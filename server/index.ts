import express from "express";
import http from "node:http";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bashLanguage from "@ast-grep/lang-bash";
import { parse, registerDynamicLanguage, type SgNode } from "@ast-grep/napi";
import pty from "node-pty";
import { WebSocketServer, WebSocket } from "ws";

type SessionKind = "codex" | "claude";

registerDynamicLanguage({ bash: bashLanguage });

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

type ClientMessage =
  | { type: "create"; kind: SessionKind; kubeContextId?: string; cwd?: string; cols?: number; rows?: number }
  | { type: "chat"; text: string }
  | { type: "terminalInput"; data: string }
  | { type: "approve"; id: string }
  | { type: "reject"; id: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "interrupt" }
  | { type: "clear" }
  | { type: "clearMemory" }
  | { type: "close" };

type ServerMessage =
  | {
      type: "ready";
      id: string;
      title: string;
      cwd: string;
      command: string;
      kind: SessionKind;
      kube: ResolvedKubeTarget;
    }
  | { type: "terminalData"; data: string }
  | { type: "operation"; id: string; domain: CommandDomain; mode: CommandMode; source: CommandSource; command: string; summary: string }
  | { type: "commandResult"; id?: string; domain?: CommandDomain; command: string; exitCode: number; output: string; durationMs: number; at: string }
  | { type: "approval"; approval: DeploymentApproval }
  | { type: "chatEcho"; text: string; at: string }
  | { type: "chatAgent"; text: string; at: string }
  | { type: "chatAgentStart"; id: string; at: string }
  | { type: "chatAgentDelta"; id: string; text: string }
  | { type: "chatAgentDone"; id: string; text: string; at: string }
  | { type: "status"; running: boolean; exitCode?: number }
  | { type: "error"; message: string };

type CommandDomain = "kubernetes" | "shell";
type CommandSource = "agent" | "user";
type CommandMode = "observe" | "setup" | "approval" | "blocked";

type CommandIntent = {
  id: string;
  domain: CommandDomain;
  source: CommandSource;
  mode: CommandMode;
  command: string;
  summary: string;
  purpose: string;
};

type QueuedCommand = {
  intent: CommandIntent;
  feedbackToAgent: boolean;
};

type TranscriptMessage = { role: "user" | "assistant" | "tool"; text: string };
type PendingAgentReason = "user" | "tool";

type SpecialistReview = {
  specialist: "Reviewer";
  risk: "low" | "medium" | "high";
  summary: string;
  findings: string[];
  nextChecks: string[];
};

type SpecialistDiagnosis = {
  specialist: "Diagnoser";
  summary: string;
  findings: string[];
  nextSteps: string[];
};

type MemoryEvent =
  | { type: "session.start"; at: string; sessionId: string; kind: SessionKind; cwd: string; kube: Pick<ResolvedKubeTarget, "id" | "label" | "context" | "kubeconfig"> }
  | { type: "chat.user"; at: string; text: string }
  | { type: "chat.agent"; at: string; text: string }
  | { type: "command.start"; at: string; intent: CommandIntent }
  | { type: "command.result"; at: string; commandId?: string; domain?: CommandDomain; command: string; exitCode: number; durationMs: number; output: string }
  | { type: "approval.pending"; at: string; approval: DeploymentApproval }
  | { type: "approval.accepted"; at: string; command: string }
  | { type: "approval.rejected"; at: string; command: string }
  | { type: "specialist.review"; at: string; command: string; review: SpecialistReview }
  | { type: "diagnosis"; at: string; text: string }
  | { type: "memory.clear"; at: string; kube: Pick<ResolvedKubeTarget, "id" | "label" | "context" | "kubeconfig"> }
  | { type: "summary.compacted"; at: string; summary: string };

type SessionMemory = {
  id: string;
  dir: string;
  eventsFile: string;
  summaryFile: string;
};

type ClusterMemoryEntry = {
  at: string;
  kind: "user" | "command" | "result" | "diagnosis" | "approval";
  text: string;
};

type ClusterMemory = {
  id: string;
  label: string;
  context?: string;
  kubeconfig?: string;
  updatedAt: string;
  summary: string;
  recent: ClusterMemoryEntry[];
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const port = Number(process.env.AGENT_TERMINAL_PORT ?? 8787);
const memoryBaseDir = process.env.KUBEPILOT_HOME ?? path.join(os.homedir(), ".kubepilot-console");

const app = express();
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "http://127.0.0.1:5174");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});
app.get("/api/kube-contexts", (_req, res) => {
  const contexts = scanKubeContexts();
  res.json({
    contexts,
    selectedId: resolveKubeTarget().id
  });
});
if (process.env.NODE_ENV === "production") {
  app.use(express.static(distDir));
  app.get("*", (_req, res) => res.sendFile(path.join(distDir, "index.html")));
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/session" });

wss.on("connection", (ws) => {
  let terminalProc: pty.IPty | undefined;
  let kind: SessionKind = "codex";
  let kube = resolveKubeTarget();
  let cwd = process.cwd();
  let suppressTerminalOutput = false;
  let promptTimer: NodeJS.Timeout | undefined;
  let manualInput = "";
  let agentRunning = false;
  const transcript: TranscriptMessage[] = [];
  const activeCommandKeys = new Set<string>();
  const pendingApprovals = new Map<string, DeploymentApproval>();
  const commandQueue: QueuedCommand[] = [];
  let pendingAgentReason: PendingAgentReason | undefined;
  let autoContinuationBudget = 0;
  let commandRunning = false;
  let queuePausedForApproval = false;
  let sessionMemory: SessionMemory | undefined;
  let clusterMemory = loadClusterMemory(kube);
  let sessionSummary = "";

  const send = (message: ServerMessage) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  };

  const requestUserAgentTurn = () => {
    autoContinuationBudget = 8;
    pendingAgentReason = "user";
    maybeRunPendingAgentTurn();
  };

  const requestToolAgentTurnWhenIdle = () => {
    if (autoContinuationBudget <= 0) {
      send({
        type: "chatAgent",
        text: "I stopped automatic follow-up because the tool loop reached its continuation limit. Ask me to continue if you want me to keep going.",
        at: new Date().toISOString()
      });
      return;
    }
    if (pendingAgentReason !== "user") {
      pendingAgentReason = "tool";
    }
    maybeRunPendingAgentTurn();
  };

  const maybeRunPendingAgentTurn = () => {
    if (!pendingAgentReason) return;
    if (agentRunning || commandRunning || commandQueue.length > 0 || queuePausedForApproval) return;
    const reason = pendingAgentReason;
    pendingAgentReason = undefined;
    if (reason === "tool") {
      autoContinuationBudget -= 1;
    }
    setTimeout(() => {
      if (agentRunning || commandRunning || commandQueue.length > 0 || queuePausedForApproval) {
        if (pendingAgentReason !== "user") {
          pendingAgentReason = reason;
        }
        return;
      }
      void runAgentTurn();
    }, 0);
  };

  const clearCommandQueue = () => {
    for (const item of commandQueue) {
      activeCommandKeys.delete(commandIdentity(item.intent.command));
    }
    commandQueue.length = 0;
  };

  const record = (event: MemoryEvent) => {
    if (!sessionMemory) return;
    appendMemoryEvent(sessionMemory, event);
  };

  const rememberCluster = (entry: Omit<ClusterMemoryEntry, "at"> & { at?: string }) => {
    clusterMemory = updateClusterMemory(kube, clusterMemory, {
      at: entry.at ?? new Date().toISOString(),
      kind: entry.kind,
      text: entry.text
    });
  };

  const addTranscript = (role: TranscriptMessage["role"], text: string) => {
    const cleanText = text.trim();
    if (!cleanText) return;
    transcript.push({ role, text: cleanText });
    if (role === "user") {
      const at = new Date().toISOString();
      record({ type: "chat.user", at, text: cleanText });
      rememberCluster({ at, kind: "user", text: cleanText.slice(0, 800) });
    } else if (role === "assistant") {
      record({ type: "chat.agent", at: new Date().toISOString(), text: cleanText });
    }
    compactTranscriptIfNeeded();
  };

  const compactTranscriptIfNeeded = () => {
    const totalChars = transcript.reduce((sum, message) => sum + message.text.length, 0);
    if (transcript.length <= 28 && totalChars <= 60_000) return;
    const keep = transcript.slice(-14);
    const archive = transcript.slice(0, -14);
    sessionSummary = mergeSessionSummary(sessionSummary, archive);
    transcript.length = 0;
    transcript.push(...keep);
    if (sessionMemory) {
      writeJsonAtomic(sessionMemory.summaryFile, {
        sessionId: sessionMemory.id,
        updatedAt: new Date().toISOString(),
        summary: sessionSummary
      });
      record({ type: "summary.compacted", at: new Date().toISOString(), summary: sessionSummary });
    }
  };

  const projectCommand = (command: string, options: { source: CommandSource; feedbackToAgent?: boolean; purpose?: string } = { source: "agent" }) => {
    const feedbackToAgent = options.feedbackToAgent ?? false;
    const normalized = command.trim();
    const commandKey = commandIdentity(normalized);
    const intent = createCommandIntent(normalized, options.source, options.purpose);
    if (!normalized || activeCommandKeys.has(commandKey)) return;
    if (isPlaceholderCommand(normalized)) {
      const blocked = `rejected incomplete placeholder command: ${normalized}`;
      sendOperation(intent);
      sendCommandResult(intent, 125, blocked, 0);
      if (feedbackToAgent) {
        addTranscript("tool", renderCommandResult(normalized, 125, blocked, 0));
        requestToolAgentTurnWhenIdle();
      }
      return;
    }

    commandQueue.push({ intent, feedbackToAgent });
    activeCommandKeys.add(commandKey);
    void drainCommandQueue();
  };

  const drainCommandQueue = async () => {
    if (commandRunning || queuePausedForApproval) return;
    const next = commandQueue.shift();
    if (!next) return;
    commandRunning = true;
    try {
      await executeQueuedCommand(next);
    } finally {
      activeCommandKeys.delete(commandIdentity(next.intent.command));
      commandRunning = false;
      if (!queuePausedForApproval) {
        if (commandQueue.length > 0) {
          void drainCommandQueue();
        } else {
          maybeRunPendingAgentTurn();
        }
      }
    }
  };

  const executeQueuedCommand = async ({ intent, feedbackToAgent }: QueuedCommand) => {
    const normalized = intent.command;
    sendOperation(intent);
    if (!terminalProc) return;
    suppressTerminalOutput = false;
    record({ type: "command.start", at: new Date().toISOString(), intent });
    switch (intent.mode) {
      case "observe":
        rememberCluster({ kind: "command", text: `$ ${normalized}` });
        await executeProjectedShellCommand(intent, intent.summary, { feedbackToAgent });
        return;
      case "setup":
        rememberCluster({ kind: "command", text: `$ ${normalized}` });
        await executeProjectedShellCommand(intent, intent.summary, { feedbackToAgent });
        return;
      case "approval": {
        const approval = createDeploymentApproval(intent, cwd, kube, clusterMemory);
        if (approval) {
          pendingApprovals.set(approval.id, approval);
          queuePausedForApproval = true;
          send({ type: "approval", approval });
          record({ type: "approval.pending", at: new Date().toISOString(), approval });
          record({ type: "specialist.review", at: new Date().toISOString(), command: normalized, review: approval.review });
          rememberCluster({ kind: "approval", text: `Pending approval: ${normalized}` });
          send({
            type: "chatAgent",
            text: renderSpecialistReviewForChat(approval.review),
            at: new Date().toISOString()
          });
          rememberCluster({ kind: "command", text: `$ ${normalized}` });
          send({ type: "terminalData", data: `\r\n\x1b[38;5;214m◆ pending approval\x1b[0m\r\n` });
          await typeProjectedCommand(normalized);
          return;
        }
        break;
      }
      case "blocked":
        break;
    }

    const blocked = `skipped unsupported Kubernetes command: ${normalized}`;
    rememberCluster({ kind: "command", text: `$ ${normalized}` });
    terminalProc.write(`printf '\\n[blocked] skipped unsupported Kubernetes command: %s\\n' ${shellQuote(normalized)}\r`);
    sendCommandResult(intent, 126, blocked, 0);
    if (feedbackToAgent) {
      addTranscript("tool", renderCommandResult(normalized, 126, blocked, 0));
      requestToolAgentTurnWhenIdle();
    }
  };

  const sendOperation = (intent: CommandIntent) => {
    send({
      type: "operation",
      id: intent.id,
      domain: intent.domain,
      mode: intent.mode,
      source: intent.source,
      command: intent.command,
      summary: intent.summary
    });
  };

  ws.on("message", (raw) => {
    const message = parseClientMessage(raw);
    if (!message) {
      send({ type: "error", message: "Invalid client message" });
      return;
    }

    if (message.type === "create") {
      if (terminalProc) return;
      kind = message.kind;
      kube = resolveKubeTarget(message.kubeContextId);
      const spec = commandFor(kind);
      const terminalSpec = terminalCommandFor();
      cwd = message.cwd || process.cwd();
      clusterMemory = loadClusterMemory(kube);
      sessionMemory = createSessionMemory(kind, kube, cwd);
      sessionSummary = "";
      record({
        type: "session.start",
        at: new Date().toISOString(),
        sessionId: sessionMemory.id,
        kind,
        cwd,
        kube: {
          id: kube.id,
          label: kube.label,
          context: kube.context,
          kubeconfig: kube.kubeconfig
        }
      });
      suppressTerminalOutput = true;

      terminalProc = spawnPty(terminalSpec.file, terminalSpec.args, {
        name: "xterm-256color",
        cols: message.cols ?? 120,
        rows: message.rows ?? 34,
        cwd,
        env: {
          ...process.env,
          ...kubeEnv(kube),
          ...terminalSpec.env,
          TERM: "xterm-256color",
          COLORTERM: "truecolor"
        }
      });

      if (!terminalProc) {
        send({ type: "error", message: "Failed to start projection shell" });
        return;
      }

      const id = `${kind}-${Date.now().toString(36)}`;
      send({
        type: "ready",
        id,
        title: spec.title,
        cwd,
        command: `${spec.display} -> ${kube.label} Kubernetes projection`,
        kind,
        kube
      });

      terminalProc.onData((data) => {
        if (suppressTerminalOutput) return;
        send({ type: "terminalData", data });
        clearTimeout(promptTimer);
        promptTimer = setTimeout(() => {
          send({ type: "terminalData", data: promptFor(kube) });
        }, 120);
      });

      terminalProc.onExit(({ exitCode }) => {
        send({ type: "status", running: false, exitCode });
      });

      terminalProc.write(buildProjectionShellInit(kube));
      setTimeout(() => {
        suppressTerminalOutput = false;
        send({
          type: "terminalData",
          data: [
            `\x1b[38;5;81mKubernetes projection\x1b[0m`,
            `cluster: \x1b[1m${kube.context ?? "current context"}\x1b[0m`,
            "manual commands: kubectl, k, helm, stern",
            "",
            promptFor(kube)
          ].join("\r\n")
        });
      }, 250);
      return;
    }

    if (!terminalProc) {
      send({ type: "error", message: "Session has not been created" });
      return;
    }

    switch (message.type) {
      case "chat": {
        const text = message.text.trim();
        if (!text) return;
        send({ type: "chatEcho", text, at: new Date().toISOString() });
        addTranscript("user", text);
        const directCommand = fallbackK8sCommandForUserQuestion(text, "");
        if (directCommand) {
          send({ type: "chatAgent", text: directCommand.chatText, at: new Date().toISOString() });
          addTranscript("assistant", directCommand.chatText);
          autoContinuationBudget = 8;
          projectCommand(directCommand.command, { source: "agent", feedbackToAgent: true, purpose: directCommand.summary });
          break;
        }
        requestUserAgentTurn();
        break;
      }
      case "terminalInput":
        suppressTerminalOutput = false;
        handleManualTerminalInput(message.data);
        break;
      case "approve": {
        const approval = pendingApprovals.get(message.id);
        if (!approval) return;
        pendingApprovals.delete(message.id);
        suppressTerminalOutput = false;
        queuePausedForApproval = false;
        record({ type: "approval.accepted", at: new Date().toISOString(), command: approval.command });
        rememberCluster({ kind: "approval", text: `Approved: ${approval.command}` });
        commandRunning = true;
        void executeApprovedCommand(approval).finally(() => {
          commandRunning = false;
          if (commandQueue.length > 0) {
            void drainCommandQueue();
          } else {
            maybeRunPendingAgentTurn();
          }
        });
        break;
      }
      case "reject": {
        const approval = pendingApprovals.get(message.id);
        if (!approval) return;
        pendingApprovals.delete(message.id);
        suppressTerminalOutput = false;
        queuePausedForApproval = false;
        clearCommandQueue();
        terminalProc.write(`printf '\\n\\033[38;5;244m◆ rejected\\033[0m %s\\n' ${shellQuote(approval.command)}\r`);
        const rejected = "command rejected by user";
        sendCommandResult(commandIntentFromApproval(approval, "rejected Kubernetes change"), 130, rejected, 0);
        record({ type: "approval.rejected", at: new Date().toISOString(), command: approval.command });
        rememberCluster({ kind: "approval", text: `Rejected: ${approval.command}` });
        addTranscript("tool", renderCommandResult(approval.command, 130, rejected, 0));
        requestToolAgentTurnWhenIdle();
        commandRunning = false;
        if (commandQueue.length > 0) {
          void drainCommandQueue();
        } else {
          maybeRunPendingAgentTurn();
        }
        break;
      }
      case "resize":
        terminalProc.resize(Math.max(20, message.cols), Math.max(8, message.rows));
        break;
      case "interrupt":
        terminalProc.write("\x03");
        break;
      case "clear":
        terminalProc.write("\x0c");
        break;
      case "clearMemory":
        transcript.length = 0;
        sessionSummary = "";
        clusterMemory = clearClusterMemory(kube);
        record({
          type: "memory.clear",
          at: new Date().toISOString(),
          kube: {
            id: kube.id,
            label: kube.label,
            context: kube.context,
            kubeconfig: kube.kubeconfig
          }
        });
        break;
      case "close":
        terminalProc.kill();
        break;
    }
  });

  const runAgentTurn = async () => {
    if (agentRunning) {
      send({ type: "chatAgent", text: "I am still working on the previous request.", at: new Date().toISOString() });
      return;
    }
    agentRunning = true;
    try {
      const prompt = buildK8sPrompt(transcript, kube, {
        sessionSummary,
        clusterMemory
      });
      const streamId = `agent-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
      send({ type: "chatAgentStart", id: streamId, at: new Date().toISOString() });
      const output = await runAgent(kind, prompt, cwd, kube, (delta) => {
        send({ type: "chatAgentDelta", id: streamId, text: delta });
      });
      const commands = extractK8sCommands(output);
      let visibleText = stripCommandLines(output, commands).trim();
      const fallbackCommand = commands.length === 0 ? fallbackK8sCommandForUserQuestion(lastUserText(transcript), visibleText) : undefined;
      if (fallbackCommand) {
        visibleText = fallbackCommand.chatText;
      }
      if (visibleText) {
        addTranscript("assistant", visibleText);
      }
      send({ type: "chatAgentDone", id: streamId, text: visibleText, at: new Date().toISOString() });
      if (fallbackCommand) {
        projectCommand(fallbackCommand.command, { source: "agent", feedbackToAgent: true, purpose: fallbackCommand.summary });
        return;
      }
      for (const command of commands) {
        projectCommand(command, { source: "agent", feedbackToAgent: true, purpose: summarizeK8sCommand(command) });
      }
    } catch (error) {
      send({ type: "error", message: error instanceof Error ? error.message : "Agent request failed" });
    } finally {
      agentRunning = false;
      maybeRunPendingAgentTurn();
    }
  };

  const handleManualTerminalInput = (data: string) => {
    for (const char of data) {
      if (char === "\r" || char === "\n") {
        const command = manualInput.trim();
        manualInput = "";
        send({ type: "terminalData", data: "\r\n" });
        if (!command) {
          send({ type: "terminalData", data: promptFor(kube) });
          continue;
        }
        if (isK8sShellCommand(command)) {
          projectCommand(command, { source: "user", feedbackToAgent: false, purpose: summarizeK8sCommand(command) });
        } else {
          terminalProc?.write(`${command}\r`);
        }
      } else if (char === "\u007f" || char === "\b") {
        if (manualInput.length > 0) {
          manualInput = manualInput.slice(0, -1);
          send({ type: "terminalData", data: "\b \b" });
        }
      } else if (char >= " ") {
        manualInput += char;
        send({ type: "terminalData", data: char });
      }
    }
  };

  ws.on("close", () => {
    terminalProc?.kill();
  });

  function executeApprovedCommand(approval: DeploymentApproval) {
    return executeProjectedShellCommand(commandIntentFromApproval(approval, "approved Kubernetes change"), "approved", { feedbackToAgent: true });
  }

  async function executeProjectedShellCommand(intent: CommandIntent, label: string, options: { feedbackToAgent: boolean }) {
    const command = intent.command;
    send({ type: "terminalData", data: `\r\n\x1b[38;5;82m◆ ${label}\x1b[0m\r\n` });
    await typeProjectedCommand(command);
    return new Promise<void>((resolve) => {
      const startedAt = Date.now();
      let output = "";
      let settled = false;
      const child = spawn("/bin/sh", ["-lc", buildExecutionShellScript(command, kube)], {
        cwd,
        env: {
          ...process.env,
          ...kubeEnv(kube),
          TERM: "dumb",
          NO_COLOR: "1"
        },
        stdio: ["ignore", "pipe", "pipe"]
      });

      const append = (chunk: Buffer | string) => {
        const text = String(chunk);
        output += text;
        if (output.length > 120_000) output = output.slice(-120_000);
        send({ type: "terminalData", data: text.replace(/\n/g, "\r\n") });
      };

      child.stdout.on("data", append);
      child.stderr.on("data", append);
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        const text = error instanceof Error ? error.message : String(error);
        send({ type: "terminalData", data: `${text}\r\n${promptFor(kube)}` });
        sendCommandResult(intent, 127, text, Date.now() - startedAt);
        if (options.feedbackToAgent) {
          addTranscript("tool", renderCommandResult(command, 127, text, Date.now() - startedAt));
          requestToolAgentTurnWhenIdle();
        }
        resolve();
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        send({ type: "terminalData", data: `${output.endsWith("\n") || output.endsWith("\r") || !output ? "" : "\r\n"}${promptFor(kube)}` });
        sendCommandResult(intent, code ?? 0, output, Date.now() - startedAt);
        if (options.feedbackToAgent) {
          addTranscript("tool", renderCommandResult(command, code ?? 0, output, Date.now() - startedAt));
          requestToolAgentTurnWhenIdle();
        }
        resolve();
      });
    });
  }

  async function typeProjectedCommand(command: string) {
    const preview = terminalCommandPreview(command);
    const chars = Array.from(preview);
    const chunkSize = chars.length > 120 ? 4 : chars.length > 60 ? 3 : 2;
    const delayMs = Math.max(5, Math.min(24, Math.floor(900 / Math.max(chars.length, 1))));
    send({ type: "terminalData", data: promptFor(kube) });
    for (let index = 0; index < chars.length; index += chunkSize) {
      send({ type: "terminalData", data: chars.slice(index, index + chunkSize).join("") });
      await delay(delayMs);
    }
    send({ type: "terminalData", data: "\r\n" });
  }

  function sendCommandResult(intent: CommandIntent, exitCode: number, output: string, durationMs: number) {
    const command = intent.command;
    const cleanOutput = stripAnsi(output).trim().slice(0, 24_000);
    const at = new Date().toISOString();
    send({
      type: "commandResult",
      id: intent.id,
      domain: intent.domain,
      command,
      exitCode,
      output: cleanOutput,
      durationMs,
      at
    });
    record({
      type: "command.result",
      at,
      commandId: intent.id,
      domain: intent.domain,
      command,
      exitCode,
      durationMs,
      output: cleanOutput.slice(0, 80_000)
    });
    rememberCluster({
      at,
      kind: "result",
      text: [`$ ${command}`, `exit ${exitCode}`, cleanOutput ? cleanOutput.slice(0, 1800) : "(no output)"].join("\n")
    });
    const diagnosis = diagnoseK8sResult(command, exitCode, cleanOutput);
    if (diagnosis) {
      const diagnosisAt = new Date().toISOString();
      const diagnosisText = renderSpecialistDiagnosisForChat(diagnosis);
      record({ type: "diagnosis", at: diagnosisAt, text: diagnosisText });
      rememberCluster({ at: diagnosisAt, kind: "diagnosis", text: diagnosisText });
      send({ type: "chatAgent", text: diagnosisText, at: diagnosisAt });
    }
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Agent Terminal server listening on http://127.0.0.1:${port}`);
});

function parseClientMessage(raw: Buffer | ArrayBuffer | Buffer[]): ClientMessage | undefined {
  try {
    return JSON.parse(String(raw)) as ClientMessage;
  } catch {
    return undefined;
  }
}

function spawnPty(file: string, args: string[], options: pty.IPtyForkOptions) {
  try {
    return pty.spawn(file, args, options);
  } catch {
    return undefined;
  }
}

type ResolvedKubeTarget = {
  id?: string;
  label: string;
  context?: string;
  kubeconfig?: string;
  contexts: KubeContextOption[];
};

type KubeContextOption = {
  id: string;
  label: string;
  context: string;
  kubeconfig?: string;
  source: "default" | "aws" | "minikube";
  current: boolean;
};

type DeploymentApproval = {
  id: string;
  commandId: string;
  domain: CommandDomain;
  source: CommandSource;
  command: string;
  title: string;
  manifest: string;
  files: string[];
  cwd: string;
  review: SpecialistReview;
};

function createCommandIntent(command: string, source: CommandSource, purpose?: string): CommandIntent {
  const domain = detectCommandDomain(command);
  const summary = purpose || summarizeCommand(command, domain);
  return {
    id: `cmd-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`,
    domain,
    source,
    mode: classifyCommand(command, domain),
    command,
    summary,
    purpose: purpose || summary
  };
}

function commandIntentFromApproval(approval: DeploymentApproval, purpose: string): CommandIntent {
  return {
    id: approval.commandId,
    domain: approval.domain,
    source: approval.source,
    mode: "approval",
    command: approval.command,
    summary: approval.title,
    purpose
  };
}

function detectCommandDomain(command: string): CommandDomain {
  return isK8sShellCommand(command) ? "kubernetes" : "shell";
}

function summarizeCommand(command: string, domain: CommandDomain) {
  if (domain === "kubernetes") return summarizeK8sCommand(command);
  return "Run a shell command";
}

function classifyCommand(command: string, domain: CommandDomain): CommandMode {
  if (domain === "kubernetes") return classifyK8sCommand(command);
  return "blocked";
}

function createSessionMemory(kind: SessionKind, kube: ResolvedKubeTarget, cwd: string): SessionMemory {
  const id = `session-${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(16).slice(2, 8)}`;
  const dir = path.join(memoryBaseDir, "sessions", id);
  fs.mkdirSync(dir, { recursive: true });
  const memory: SessionMemory = {
    id,
    dir,
    eventsFile: path.join(dir, "events.jsonl"),
    summaryFile: path.join(dir, "summary.json")
  };
  writeJsonAtomic(path.join(dir, "meta.json"), {
    id,
    kind,
    cwd,
    createdAt: new Date().toISOString(),
    kube: {
      id: kube.id,
      label: kube.label,
      context: kube.context,
      kubeconfig: kube.kubeconfig
    }
  });
  return memory;
}

function appendMemoryEvent(memory: SessionMemory, event: MemoryEvent) {
  fs.mkdirSync(memory.dir, { recursive: true });
  fs.appendFileSync(memory.eventsFile, `${JSON.stringify(event)}\n`, "utf8");
}

function loadClusterMemory(kube: ResolvedKubeTarget): ClusterMemory {
  const file = clusterMemoryFile(kube);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as ClusterMemory;
    return {
      id: parsed.id || clusterMemoryId(kube),
      label: parsed.label || kube.label,
      context: parsed.context ?? kube.context,
      kubeconfig: parsed.kubeconfig ?? kube.kubeconfig,
      updatedAt: parsed.updatedAt || new Date().toISOString(),
      summary: parsed.summary || "",
      recent: Array.isArray(parsed.recent) ? parsed.recent.slice(-80) : []
    };
  } catch {
    return {
      id: clusterMemoryId(kube),
      label: kube.label,
      context: kube.context,
      kubeconfig: kube.kubeconfig,
      updatedAt: new Date().toISOString(),
      summary: "",
      recent: []
    };
  }
}

function updateClusterMemory(kube: ResolvedKubeTarget, current: ClusterMemory, entry: ClusterMemoryEntry) {
  const next: ClusterMemory = {
    ...current,
    id: clusterMemoryId(kube),
    label: kube.label,
    context: kube.context,
    kubeconfig: kube.kubeconfig,
    updatedAt: entry.at,
    recent: [...current.recent, trimClusterEntry(entry)].slice(-80)
  };
  next.summary = summarizeClusterMemory(next);
  writeJsonAtomic(clusterMemoryFile(kube), next);
  return next;
}

function clearClusterMemory(kube: ResolvedKubeTarget): ClusterMemory {
  const cleared: ClusterMemory = {
    id: clusterMemoryId(kube),
    label: kube.label,
    context: kube.context,
    kubeconfig: kube.kubeconfig,
    updatedAt: new Date().toISOString(),
    summary: "",
    recent: []
  };
  writeJsonAtomic(clusterMemoryFile(kube), cleared);
  return cleared;
}

function clusterMemoryFile(kube: ResolvedKubeTarget) {
  return path.join(memoryBaseDir, "clusters", `${safeFilePart(clusterMemoryId(kube))}.json`);
}

function clusterMemoryId(kube: ResolvedKubeTarget) {
  return kube.id ?? kube.context ?? "current-context";
}

function trimClusterEntry(entry: ClusterMemoryEntry): ClusterMemoryEntry {
  return {
    ...entry,
    text: entry.text.replace(/\s+$/g, "").slice(0, 4_000)
  };
}

function summarizeClusterMemory(memory: ClusterMemory) {
  const recent = memory.recent.slice(-18);
  const failed = [...memory.recent].reverse().find((entry) => entry.kind === "result" && /\bexit\s+[1-9]\d*\b/i.test(entry.text) && !/\bexit\s+130\b[\s\S]*command rejected by user/i.test(entry.text));
  const diagnoses = memory.recent.filter((entry) => entry.kind === "diagnosis").slice(-3);
  return [
    `Cluster: ${memory.context ?? memory.label}.`,
    failed ? `Most recent failed command: ${oneLine(failed.text).slice(0, 280)}` : "",
    diagnoses.length > 0 ? `Recent diagnoses: ${diagnoses.map((entry) => oneLine(entry.text).slice(0, 220)).join(" | ")}` : "",
    recent.length > 0 ? `Recent activity: ${recent.map((entry) => `${entry.kind}: ${oneLine(entry.text).slice(0, 180)}`).join(" / ")}` : ""
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 8_000);
}

function mergeSessionSummary(previous: string, archived: TranscriptMessage[]) {
  const lines = archived
    .map((message) => {
      const label = message.role === "user" ? "User" : message.role === "assistant" ? "Agent" : "Tool";
      return `- ${label}: ${oneLine(message.text).slice(0, 420)}`;
    })
    .filter((line) => line.trim().length > 4);
  return [previous, ...lines].filter(Boolean).join("\n").slice(-16_000);
}

function renderMemoryContext(sessionSummary: string, clusterMemory: ClusterMemory) {
  return [
    sessionSummary ? `Session summary:\n${sessionSummary}` : "",
    clusterMemory.summary ? `Cluster memory:\n${clusterMemory.summary}` : "",
    clusterMemory.recent.length > 0
      ? `Recent cluster events:\n${clusterMemory.recent
          .slice(-12)
          .map((entry) => `- ${entry.at} ${entry.kind}: ${oneLine(entry.text).slice(0, 260)}`)
          .join("\n")}`
      : ""
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 16_000);
}

function lastUserText(transcript: TranscriptMessage[]) {
  return [...transcript].reverse().find((message) => message.role === "user")?.text ?? "";
}

function fallbackK8sCommandForUserQuestion(userText: string, agentText: string) {
  const normalized = userText.toLowerCase().replace(/\s+/g, " ").trim();
  const agentLooksStalled = !agentText.trim() || /wait|waiting|output|result|等待|输出|结果|检查|查询/i.test(agentText);
  if (!agentLooksStalled) return undefined;

  const deploymentQuestion = /部署|deploy|deployed|installed|安装|存在|有没有|是否|了吗|了吗\?|有吗|查/.test(normalized);
  if (!deploymentQuestion) return undefined;

  const component = componentNameFromQuestion(normalized);
  if (!component) return undefined;

  const command = `kubectl get all,pvc,ingress,configmap,secret -A | grep -i ${shellQuote(component.grep)} || true`;
  return {
    command,
    summary: `Search all namespaces for ${component.label} resources`,
    chatText: `I will check the selected cluster for ${component.label} resources with a read-only query.`
  };
}

function componentNameFromQuestion(normalized: string) {
  if (/open\s*observe|openobserve/.test(normalized)) {
    return { label: "OpenObserve", grep: "openobserve" };
  }
  if (/dagster/.test(normalized)) {
    return { label: "Dagster", grep: "dagster" };
  }
  const quoted = normalized.match(/[`'"]([a-z0-9][a-z0-9_.-]{1,60})[`'"]/i)?.[1];
  if (quoted) return { label: quoted, grep: quoted };
  return undefined;
}

function writeJsonAtomic(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temp, file);
}

function safeFilePart(value: string) {
  return value.replace(/[^a-z0-9_.-]+/gi, "_").slice(0, 180) || "default";
}

function oneLine(value: string) {
  return stripAnsi(value).replace(/\s+/g, " ").trim();
}

function buildK8sPrompt(
  transcript: TranscriptMessage[],
  kube: ResolvedKubeTarget,
  memory: { sessionSummary: string; clusterMemory: ClusterMemory }
) {
  const contextLine = kube.context
    ? `Selected Kubernetes target: ${kube.label}, context ${kube.context}.`
    : `Selected Kubernetes target: ${kube.label}. No matching context was found; use the current kubeconfig context.`;
  const memoryContext = renderMemoryContext(memory.sessionSummary, memory.clusterMemory);
  return [
    "Kubernetes investigation mode:",
    contextLine,
    "You are the chat agent for a local Kubernetes console.",
    "Do not execute kubectl, k, helm, stern, or any Kubernetes command yourself.",
    "When cluster data is needed, write the exact command you want the console to run on its own line.",
    "Commands must be complete executable shell commands. Never use ellipses, placeholders, or abbreviated commands such as `helm search ...`.",
    "Never say you are waiting for command output unless your response includes the exact executable command to run.",
    "If the user asks whether a component is deployed, request a read-only search command first, such as `kubectl get all,pvc,ingress,configmap,secret -A | grep -i NAME || true`.",
    "The app will execute that command in a separate projected terminal using the selected context.",
    "When command results are present in the conversation, answer the user from those results instead of repeating the same command.",
    "Drive the task as a loop: plan the next concrete step, request exactly the needed command, wait for the command result, then either continue with the next step or give the final answer.",
    "Do not stop after a prerequisite/setup command if the user's objective is not complete. Continue with deployment, verification, or diagnosis as appropriate.",
    "After a mutating command succeeds, verify the outcome with read-only commands such as get, rollout status, describe, events, or logs before declaring success.",
    "If a command fails, explain the failure from the output and either propose the next diagnostic command, propose a fix that requires approval, or ask the user for missing information.",
    "When the user asks what error happened or why a workload is not ready, summarize the diagnosis after describe/logs output: state the Kubernetes Reason, quote the key event or error line, and suggest the next concrete fix.",
    "If command output contains ErrImagePull, ImagePullBackOff, CrashLoopBackOff, FailedScheduling, Pending, or readiness/liveness probe failures, explicitly explain that condition in chat before proposing more commands.",
    "For mutating operations such as apply, delete, patch, scale, rollout restart, or helm upgrade, propose the command only; the app will show a YAML review and require approval.",
    "For deployments into a new namespace, the first executable command must ensure the namespace exists. Use an idempotent command such as: kubectl create namespace NAME --dry-run=client -o yaml | kubectl apply -f -",
    "Never apply a namespace-scoped manifest or run helm install/upgrade into a namespace before the namespace has been created or confirmed by command output.",
    "Creating or confirming a namespace is not a completed deployment. After that command succeeds, continue with the actual apply/helm deployment command or explain exactly what approval is needed.",
    "For shell commands, quote values safely. Do not leave passwords or values containing #, spaces, $, quotes, or semicolons unquoted.",
    "Prefer a rendered YAML manifest or values file for deployments that need secrets or many --set values.",
    "It is fine to ask clarifying questions before proposing any Kubernetes command.",
    "Keep normal explanation in chat. Do not expose private reasoning.",
    "",
    "Memory:",
    memoryContext || "No durable memory is available for this session yet.",
    "",
    "Conversation:",
    ...transcript.map((message) => `${message.role === "user" ? "User" : message.role === "tool" ? "Command result" : "Assistant"}: ${message.text}`)
  ].join("\n");
}

function runAgent(kind: SessionKind, prompt: string, cwd: string, kube: ResolvedKubeTarget, onChunk?: (text: string) => void) {
  const spec =
    kind === "codex"
      ? {
          file: "codex",
          args: ["exec", "--color", "never", "--sandbox", "read-only", "--skip-git-repo-check", "-"]
        }
      : {
          file: "claude",
          args: ["--print", "--output-format", "text", "--permission-mode", "plan", prompt]
        };

  return new Promise<string>((resolve, reject) => {
    const child = spawn(spec.file, spec.args, {
      cwd,
      env: {
        ...process.env,
        ...kubeEnv(kube),
        TERM: "dumb",
        NO_COLOR: "1"
      },
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let streamed = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (onChunk) {
        const cleaned = cleanAgentText(stdout);
        if (cleaned.startsWith(streamed)) {
          const delta = cleaned.slice(streamed.length);
          if (delta) onChunk(delta);
        } else if (cleaned) {
          onChunk(cleaned);
        }
        streamed = cleaned;
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(stderr.trim() || `${spec.file} exited with code ${code}`));
        return;
      }
      resolve(cleanAgentText(stdout || stderr));
    });

    if (kind === "codex") {
      child.stdin.write(prompt);
    }
    child.stdin.end();
  });
}

function cleanAgentText(text: string) {
  return stripAnsi(text)
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((line) => !/^\s*(Thinking|Running|Reading|Tool|OpenAI|Codex CLI)\b/i.test(line))
    .join("\n")
    .trim();
}

function extractK8sCommands(text: string) {
  try {
    const root = parse("bash", text).root();
    const commands: string[] = [];
    visitAst(root, (node) => {
      if (node.kind() !== "command") return;
      const name = commandName(node);
      if (!name || !["kubectl", "k", "helm", "stern"].includes(name)) return;
      const command = commandProjectionText(node).trim();
      if (command) commands.push(command.slice(0, command.includes("\n") ? 250_000 : 240));
    });
    return Array.from(new Set(commands));
  } catch {
    return [];
  }
}

function visitAst(node: SgNode, visitor: (node: SgNode) => void) {
  visitor(node);
  for (const child of node.children()) {
    visitAst(child, visitor);
  }
}

function commandName(command: SgNode) {
  const nameNode = command.children().find((child) => child.kind() === "command_name");
  return nameNode?.text().trim();
}

function commandProjectionText(command: SgNode) {
  let current = command;
  if (current.parent()?.kind() === "redirected_statement") {
    current = current.parent()!;
  }
  while (current.parent()?.kind() === "pipeline") {
    current = current.parent()!;
  }
  const parent = current.parent();
  if (parent?.kind() === "list" && isPipelineWithTrailingTrue(parent, current)) {
    return parent.text();
  }
  return current.text();
}

function isPipelineWithTrailingTrue(list: SgNode, pipeline: SgNode) {
  const children = list.children();
  const pipelineIndex = children.findIndex((child) => child.id() === pipeline.id());
  if (pipelineIndex < 0) return false;
  const rest = children.slice(pipelineIndex + 1);
  if (rest.length !== 2) return false;
  return rest[0].text().trim() === "||" && rest[1].kind() === "command" && commandName(rest[1]) === "true";
}

function stripCommandLines(text: string, commands: string[]) {
  const commandSet = new Set(commands.map(commandIdentity));
  const withoutCommandBlocks = [...commands]
    .sort((a, b) => b.length - a.length)
    .reduce((current, command) => current.replace(command, ""), text);
  return withoutCommandBlocks
    .split("\n")
    .filter((line) => {
      const normalized = commandIdentity(line);
      if (!normalized) return false;
      if (commandSet.has(normalized)) return false;
      return !/^[>$#%❯]\s*$/.test(normalized);
    })
    .join("\n");
}

function summarizeK8sCommand(command: string) {
  const normalized = command.toLowerCase();
  if (/^(kubectl|k)\s+get\s+(pods?|po)\b/.test(normalized)) return "List pods to check status, restarts, and age";
  if (/^(kubectl|k)\s+get\s+events?\b/.test(normalized)) return "Inspect cluster events for scheduling, image, probe, or eviction issues";
  if (/^(kubectl|k)\s+describe\b/.test(normalized)) return "Describe the resource and inspect its events";
  if (/^(kubectl|k)\s+logs?\b/.test(normalized)) return "Read container logs for errors and stack traces";
  if (/^(kubectl|k)\s+top\b/.test(normalized)) return "Check CPU and memory pressure";
  if (/^(kubectl|k)\s+exec\b/.test(normalized)) return "Run a validation command inside the container";
  if (/^(kubectl|k)\s+rollout\s+(status|history)\b/.test(normalized)) return "Inspect rollout status or revision history";
  if (/^helm\s+list\b/.test(normalized)) return "List Helm releases";
  if (/^helm\s+search\b/.test(normalized)) return "Search Helm repositories";
  if (/^helm\s+repo\s+add\b/.test(normalized)) return "Add the Helm chart repository";
  if (/^helm\s+repo\s+update\b/.test(normalized)) return "Update local Helm chart indexes";
  if (/^helm\s+status\b/.test(normalized)) return "Inspect Helm release status and related resources";
  if (/^helm\s+history\b/.test(normalized)) return "Inspect Helm release history";
  if (/^stern\b/.test(normalized)) return "Stream matching pod logs";
  return "Run a Kubernetes investigation command";
}

function isReadOnlyK8sCommand(command: string) {
  const normalized = command.toLowerCase().trim();
  if (/^(kubectl|k)\s+(get|describe|logs?|top|explain|api-resources|api-versions|version|config\s+(current-context|get-contexts|view))\b/.test(normalized)) {
    return true;
  }
  if (/^(kubectl|k)\s+rollout\s+(status|history)\b/.test(normalized)) return true;
  if (/^helm\s+(list|status|history|get|search|repo\s+(add|update|list)|version)\b/.test(normalized)) return true;
  if (/^stern\b/.test(normalized)) return true;
  return false;
}

function classifyK8sCommand(command: string): CommandMode {
  if (isReadOnlyK8sCommand(command)) return "observe";
  if (isSafeK8sSetupCommand(command)) return "setup";
  if (isMutatingK8sCommand(command)) return "approval";
  return "blocked";
}

function isSafeK8sSetupCommand(command: string) {
  const normalized = commandIdentity(command).toLowerCase();
  if (/^(kubectl|k) create namespace [a-z0-9]([-a-z0-9]*[a-z0-9])? --dry-run=client -o yaml \| (kubectl|k) apply -f -$/.test(normalized)) {
    return true;
  }
  if (/^helm repo (add|update)\b/.test(normalized)) return true;
  return false;
}

function createDeploymentApproval(intent: CommandIntent, cwd: string, kube: ResolvedKubeTarget, clusterMemory: ClusterMemory): DeploymentApproval | undefined {
  const command = intent.command;
  if (!isMutatingK8sCommand(command)) return undefined;
  const files = manifestFilesForCommand(command, cwd);
  const inlineManifest = extractHeredocManifest(command);
  const manifest = inlineManifest ?? (files.length > 0 ? renderManifestPreview(files) : commandOnlyPreview(command));
  const review = reviewK8sChange(command, manifest, files, kube, clusterMemory);
  return {
    id: `approval-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`,
    commandId: intent.id,
    domain: intent.domain,
    source: intent.source,
    command,
    title: approvalTitle(command),
    manifest,
    files,
    cwd,
    review
  };
}

function reviewK8sChange(command: string, manifest: string, files: string[], kube: ResolvedKubeTarget, clusterMemory: ClusterMemory): SpecialistReview {
  const findings: string[] = [];
  const nextChecks = new Set<string>();
  let risk: SpecialistReview["risk"] = "medium";
  const normalized = commandIdentity(command).toLowerCase();
  const targetNamespace = namespaceFromCommand(command) ?? namespaceFromManifest(manifest);
  const resources = resourceKindsFromManifest(manifest);

  findings.push(`Target context: ${kube.context ?? kube.label}.`);
  if (targetNamespace) {
    findings.push(`Target namespace: ${targetNamespace}.`);
  } else if (!/namespace\b/i.test(manifest)) {
    findings.push("No explicit namespace was detected; the command may use the current namespace.");
    risk = raiseRisk(risk, "medium");
  }

  if (files.length > 0) {
    findings.push(`Reviewing ${files.length} local manifest file${files.length === 1 ? "" : "s"}.`);
  } else if (/https?:\/\//i.test(command)) {
    findings.push("The command applies a remote manifest URL; review is limited to the command unless the manifest is rendered locally.");
    risk = raiseRisk(risk, "high");
  } else if (/ -f -\b|--filename -\b/.test(normalized) && !extractHeredocManifest(command)) {
    findings.push("The command reads the manifest from stdin; no full rendered YAML was available for review.");
    risk = raiseRisk(risk, "high");
  }

  if (resources.length > 0) {
    findings.push(`Resources in preview: ${resources.slice(0, 12).join(", ")}${resources.length > 12 ? ", ..." : ""}.`);
  }

  if (/\bdelete\b/.test(normalized)) {
    findings.push("This is a delete operation.");
    risk = raiseRisk(risk, "high");
  }
  if (/\brollback\b|\brollout undo\b/.test(normalized)) {
    findings.push("This changes workload revision state.");
    risk = raiseRisk(risk, "high");
  }
  if (/\b(latest|:latest)\b/i.test(command) || /image:\s+\S+:latest\b/i.test(manifest)) {
    findings.push("An image uses the latest tag; rollout reproducibility may be weak.");
    risk = raiseRisk(risk, "medium");
  }
  if (/kind:\s*Secret\b/i.test(manifest) || /\bZO_ROOT_USER_PASSWORD\b|password|token|secret/i.test(manifest)) {
    findings.push("Secret-like values are present in the preview. Confirm they are intended for this cluster.");
    risk = raiseRisk(risk, "medium");
  }
  if (/nodePort:\s*\d+/i.test(manifest)) {
    findings.push("A fixed NodePort is present. Confirm the port is not already allocated.");
    risk = raiseRisk(risk, "medium");
  }
  if (/hostPath:|hostNetwork:\s*true|privileged:\s*true/i.test(manifest)) {
    findings.push("The manifest contains host-level or privileged settings.");
    risk = raiseRisk(risk, "high");
  }
  if (clusterMemory.summary) {
    findings.push(`Recent cluster memory available: ${oneLine(clusterMemory.summary).slice(0, 220)}.`);
  }

  if (/^helm\s+(install|upgrade)\b/i.test(command)) {
    nextChecks.add("helm status <release> -n <namespace>");
    nextChecks.add("kubectl get pods,svc,pvc -n <namespace> -o wide");
  } else if (/^(kubectl|k)\s+delete\b/i.test(command)) {
    nextChecks.add("kubectl get all -n <namespace>");
  } else {
    nextChecks.add("kubectl rollout status deployment/<name> -n <namespace>");
    nextChecks.add("kubectl get pods,svc,pvc -n <namespace> -o wide");
  }
  nextChecks.add("kubectl get events -n <namespace> --sort-by=.lastTimestamp");

  return {
    specialist: "Reviewer",
    risk,
    summary: `${risk.toUpperCase()} risk change review for ${approvalTitle(command).replace(/^Review\s+/i, "").toLowerCase()}.`,
    findings: findings.slice(0, 10),
    nextChecks: Array.from(nextChecks).slice(0, 5)
  };
}

function raiseRisk(current: SpecialistReview["risk"], next: SpecialistReview["risk"]) {
  const order = { low: 0, medium: 1, high: 2 };
  return order[next] > order[current] ? next : current;
}

function namespaceFromCommand(command: string) {
  const words = shellWords(command);
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if ((word === "-n" || word === "--namespace") && words[index + 1]) return words[index + 1];
    if (word.startsWith("--namespace=")) return word.slice("--namespace=".length);
  }
  return undefined;
}

function namespaceFromManifest(manifest: string) {
  const match = manifest.match(/^\s*namespace:\s*([a-z0-9]([-a-z0-9]*[a-z0-9])?)\s*$/im);
  return match?.[1];
}

function resourceKindsFromManifest(manifest: string) {
  return Array.from(new Set([...manifest.matchAll(/^\s*kind:\s*([A-Za-z][A-Za-z0-9]*)\s*$/gm)].map((match) => match[1])));
}

function renderSpecialistReviewForChat(review: SpecialistReview) {
  return [
    `Reviewer: ${review.summary}`,
    ...review.findings.map((finding) => `- ${finding}`),
    review.nextChecks.length > 0 ? "Post-approval checks:" : "",
    ...review.nextChecks.map((check) => `- ${check}`)
  ]
    .filter(Boolean)
    .join("\n");
}

function commandIdentity(command: string) {
  return command.replace(/\s+/g, " ").trim();
}

function isPlaceholderCommand(command: string) {
  return /\.\.\.|<[^>]+>|\bTODO\b|\bPLACEHOLDER\b/i.test(command);
}

function extractHeredocManifest(command: string) {
  try {
    const root = parse("bash", command).root();
    const bodies: string[] = [];
    visitAst(root, (node) => {
      if (node.kind() === "heredoc_body") bodies.push(node.text().trimEnd());
    });
    if (bodies.length === 0) return undefined;
    return bodies.join("\n---\n").slice(0, 250_000);
  } catch {
    return undefined;
  }
}

function isMutatingK8sCommand(command: string) {
  const normalized = command.toLowerCase().trim();
  if (/^(kubectl|k)\s+(apply|create|replace|delete|patch|scale|annotate|label|set)\b/.test(normalized)) return true;
  if (/^(kubectl|k)\s+rollout\s+(restart|undo|pause|resume)\b/.test(normalized)) return true;
  if (/^helm\s+(install|upgrade|rollback|uninstall|delete)\b/.test(normalized)) return true;
  return false;
}

function approvalTitle(command: string) {
  const normalized = command.toLowerCase();
  if (/^(kubectl|k)\s+apply\b/.test(normalized)) return "Review Kubernetes apply";
  if (/^(kubectl|k)\s+delete\b/.test(normalized)) return "Review Kubernetes delete";
  if (/^(kubectl|k)\s+replace\b/.test(normalized)) return "Review Kubernetes replace";
  if (/^helm\s+(install|upgrade)\b/.test(normalized)) return "Review Helm deployment";
  return "Review Kubernetes change";
}

function manifestFilesForCommand(command: string, cwd: string) {
  const words = shellWords(command);
  const paths: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if ((word === "-f" || word === "--filename" || word === "--values" || word === "-values") && words[index + 1]) {
      paths.push(words[index + 1]);
    } else if (word.startsWith("--filename=") || word.startsWith("--values=")) {
      paths.push(word.slice(word.indexOf("=") + 1));
    }
  }
  return paths.flatMap((candidate) => expandManifestPath(candidate, cwd)).slice(0, 40);
}

function shellWords(command: string) {
  try {
    const root = parse("bash", command).root();
    const firstCommand = findFirstCommand(root);
    if (!firstCommand) return [];
    return firstCommand
      .children()
      .filter((child) => ["command_name", "word", "string", "raw_string"].includes(String(child.kind())))
      .map((child) => unquoteShellWord(child.text().trim()))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function findFirstCommand(node: SgNode): SgNode | undefined {
  if (node.kind() === "command") return node;
  for (const child of node.children()) {
    const found = findFirstCommand(child);
    if (found) return found;
  }
  return undefined;
}

function unquoteShellWord(value: string) {
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
    return value.slice(1, -1);
  }
  return value;
}

function expandManifestPath(candidate: string, cwd: string) {
  if (!candidate || candidate === "-") return [];
  const resolved = path.resolve(cwd, candidate);
  if (!fs.existsSync(resolved)) return [];
  const stat = fs.statSync(resolved);
  if (stat.isFile() && isYamlFile(resolved)) return [resolved];
  if (!stat.isDirectory()) return [];
  return fs
    .readdirSync(resolved)
    .map((entry) => path.join(resolved, entry))
    .filter((entry) => fs.statSync(entry).isFile() && isYamlFile(entry))
    .sort();
}

function isYamlFile(file: string) {
  return /\.(ya?ml)$/i.test(file);
}

function renderManifestPreview(files: string[]) {
  return files
    .map((file) => {
      const content = fs.readFileSync(file, "utf8");
      return [`# Source: ${file}`, content.trimEnd()].join("\n");
    })
    .join("\n---\n")
    .slice(0, 250_000);
}

function commandOnlyPreview(command: string) {
  return [
    "# No local YAML file was found for this command.",
    "# Review the command carefully before approving.",
    "",
    `command: ${command}`
  ].join("\n");
}

function terminalCommandPreview(command: string) {
  const normalized = commandIdentity(command);
  if (command.includes("\n") || /<<['"]?[A-Z0-9_-]+['"]?/i.test(command)) {
    const heredocLines = command.split("\n");
    const firstLine = heredocLines[0]?.trim() || normalized;
    const resourceKinds = resourceKindsFromManifest(command);
    const resourceText = resourceKinds.length > 0 ? `; resources: ${resourceKinds.slice(0, 8).join(", ")}${resourceKinds.length > 8 ? ", ..." : ""}` : "";
    return `${firstLine}  # inline manifest hidden from terminal (${Math.max(0, heredocLines.length - 1)} lines${resourceText}); review YAML panel`;
  }
  if (normalized.length > 180) {
    return `${normalized.slice(0, 170)}...  # command shortened; review details in chat/panel`;
  }
  return normalized;
}

function renderCommandResult(command: string, exitCode: number, output: string, durationMs: number) {
  const trimmed = stripAnsi(output).trim();
  const body = trimmed || "(no output)";
  return [
    `$ ${command}`,
    `exit code: ${exitCode}`,
    `duration: ${Math.max(1, Math.round(durationMs))}ms`,
    "output:",
    body.slice(0, 80_000)
  ].join("\n");
}

function diagnoseK8sResult(command: string, exitCode: number, output: string): SpecialistDiagnosis | undefined {
  if (exitCode === 130 && /command rejected by user/i.test(output)) return undefined;
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const imagePullLine = lines.find((line) => /Failed to pull image|ErrImagePull|ImagePullBackOff|image can't be pulled/i.test(line));
  if (imagePullLine) {
    const imageLine = lines.find((line) => /^Image:\s+/i.test(line));
    const reasonLine = lines.find((line) => /^Reason:\s+/i.test(line));
    return {
      specialist: "Diagnoser",
      summary: "The workload is blocked on image pull.",
      findings: [
        reasonLine ? `Reason: ${reasonLine.replace(/^Reason:\s*/i, "")}.` : "Reason: ErrImagePull / ImagePullBackOff.",
        imageLine ? `Image: ${imageLine.replace(/^Image:\s*/i, "")}.` : "",
        `Evidence: ${imagePullLine}`
      ].filter(Boolean),
      nextSteps: [
        "Verify the image registry and tag are reachable from the selected cluster.",
        "If needed, patch the manifest to a reachable image and wait for rollout."
      ]
    };
  }

  const schedulingLine = lines.find((line) => /FailedScheduling|unbound immediate PersistentVolumeClaims|Insufficient/i.test(line));
  if (schedulingLine) {
    return {
      specialist: "Diagnoser",
      summary: "The pod is blocked by scheduling.",
      findings: [`Evidence: ${schedulingLine}`],
      nextSteps: ["Inspect PVC/storage class and node resources.", "Re-check pod events after fixing the constraint."]
    };
  }

  const crashLine = lines.find((line) => /CrashLoopBackOff|Back-off restarting failed container/i.test(line));
  if (crashLine) {
    return {
      specialist: "Diagnoser",
      summary: "The container is crashing after start.",
      findings: [`Evidence: ${crashLine}`],
      nextSteps: ["Inspect current logs.", "Inspect previous container logs if the container has restarted."]
    };
  }

  if (exitCode !== 0) {
    const evidence = lines.find((line) => /error|failed|forbidden|notfound|not found|invalid|denied|timeout/i.test(line)) ?? lines.slice(-1)[0];
    return {
      specialist: "Diagnoser",
      summary: `The command failed with exit code ${exitCode}.`,
      findings: [evidence ? `Evidence: ${evidence}` : `Command: ${command}`],
      nextSteps: ["Use the error output to choose the next read-only diagnostic command before retrying mutation."]
    };
  }

  return undefined;
}

function renderSpecialistDiagnosisForChat(diagnosis: SpecialistDiagnosis) {
  return [
    `Diagnoser: ${diagnosis.summary}`,
    ...diagnosis.findings.map((finding) => `- ${finding}`),
    diagnosis.nextSteps.length > 0 ? "Next steps:" : "",
    ...diagnosis.nextSteps.map((step) => `- ${step}`)
  ]
    .filter(Boolean)
    .join("\n");
}

function shellCommand() {
  return process.env.SHELL || (os.platform() === "win32" ? "powershell.exe" : "/bin/zsh");
}

function terminalCommandFor() {
  if (os.platform() === "win32") {
    return { file: shellCommand(), args: [], env: {} };
  }
  return {
    file: "/bin/sh",
    args: ["-i"],
    env: {
      PS1: "",
      ENV: ""
    }
  };
}

function resolveKubeTarget(contextId?: string): ResolvedKubeTarget {
  const contexts = scanKubeContexts();
  const selected = (contextId ? contexts.find((context) => context.id === contextId) : undefined) ?? contexts.find((context) => context.current) ?? contexts[0];
  if (!selected) {
    return {
      label: "current kube context",
      contexts
    };
  }
  return {
    id: selected.id,
    label: selected.label,
    context: selected.context,
    kubeconfig: selected.kubeconfig,
    contexts
  };
}

function kubeEnv(kube: ResolvedKubeTarget) {
  return kube.kubeconfig ? { KUBECONFIG: kube.kubeconfig } : {};
}

function scanKubeContexts(): KubeContextOption[] {
  const configs: Array<{ source: KubeContextOption["source"]; kubeconfig?: string }> = [
    { source: "default", kubeconfig: process.env.KUBECONFIG },
    { source: "aws", kubeconfig: process.env.K8S_AGENT_AWS_KUBECONFIG },
    { source: "minikube", kubeconfig: process.env.K8S_AGENT_MINIKUBE_KUBECONFIG }
  ];
  const seen = new Set<string>();
  const options: KubeContextOption[] = [];

  for (const config of configs) {
    const contexts = listKubeContexts(config.kubeconfig);
    const current = currentKubeContext(config.kubeconfig);
    for (const context of contexts) {
      const key = `${config.kubeconfig ?? ""}\n${context}`;
      if (seen.has(key)) continue;
      seen.add(key);
      options.push({
        id: encodeContextId(config.kubeconfig, context),
        label: labelForContext(context, config.source),
        context,
        kubeconfig: config.kubeconfig,
        source: sourceForContext(context, config.source),
        current: context === current
      });
    }
  }

  return options.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    if (a.source !== b.source) return a.source.localeCompare(b.source);
    return a.label.localeCompare(b.label);
  });
}

function listKubeContexts(kubeconfig?: string) {
  try {
    return execFileSync("kubectl", ["config", "get-contexts", "-o", "name"], {
      encoding: "utf8",
      env: { ...process.env, ...(kubeconfig ? { KUBECONFIG: kubeconfig } : {}) }
    })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function currentKubeContext(kubeconfig?: string) {
  try {
    return execFileSync("kubectl", ["config", "current-context"], {
      encoding: "utf8",
      env: { ...process.env, ...(kubeconfig ? { KUBECONFIG: kubeconfig } : {}) }
    }).trim();
  } catch {
    return undefined;
  }
}

function sourceForContext(context: string, fallback: KubeContextOption["source"]) {
  if (/minikube/i.test(context)) return "minikube";
  if (/arn:aws:eks|eks|aws/i.test(context)) return "aws";
  return fallback;
}

function labelForContext(context: string, source: KubeContextOption["source"]) {
  const inferred = sourceForContext(context, source);
  const prefix = inferred === "aws" ? "AWS" : inferred === "minikube" ? "minikube" : "kube";
  return `${prefix} · ${context}`;
}

function encodeContextId(kubeconfig: string | undefined, context: string) {
  return Buffer.from(JSON.stringify({ kubeconfig, context })).toString("base64url");
}

function buildProjectionShellInit(kube: ResolvedKubeTarget) {
  const context = kube.context ? shellQuote(kube.context) : "";
  const contextArg = kube.context ? `--context ${context}` : "";
  const helmContextArg = kube.context ? `--kube-context ${context}` : "";
  const sternContextArg = kube.context ? `--context ${context}` : "";

  return [
    "stty -echo 2>/dev/null",
    "alias k=kubectl",
    `kubectl() { command kubectl ${contextArg} "$@"; }`,
    `k() { command kubectl ${contextArg} "$@"; }`,
    `helm() { command helm ${helmContextArg} "$@"; }`,
    `stern() { command stern ${sternContextArg} "$@"; }`,
    ""
  ].join("\r");
}

function buildExecutionShellScript(command: string, kube: ResolvedKubeTarget) {
  const context = kube.context ? shellQuote(kube.context) : "";
  const contextArg = kube.context ? `--context ${context}` : "";
  const helmContextArg = kube.context ? `--kube-context ${context}` : "";
  const sternContextArg = kube.context ? `--context ${context}` : "";

  return [
    "set +e",
    "alias k=kubectl",
    `kubectl() { command kubectl ${contextArg} "$@"; }`,
    `k() { command kubectl ${contextArg} "$@"; }`,
    `helm() { command helm ${helmContextArg} "$@"; }`,
    `stern() { command stern ${sternContextArg} "$@"; }`,
    command
  ].join("\n");
}

function isK8sShellCommand(command: string) {
  const name = shellWords(command)[0];
  return name ? ["kubectl", "k", "helm", "stern"].includes(name) : false;
}

function promptFor(kube: ResolvedKubeTarget) {
  const label = kube.context ?? "kube";
  return `\x1b[38;5;244m${label}\x1b[0m \x1b[38;5;81m›\x1b[0m `;
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function stripAnsi(input: string) {
  return input.replace(
    // eslint-disable-next-line no-control-regex
    /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g,
    ""
  );
}

function commandFor(kind: SessionKind) {
  if (kind === "codex") {
    return { file: "/bin/zsh", args: ["-lic", "exec codex"], title: "Codex", display: "codex" };
  }
  if (kind === "claude") {
    return { file: "/bin/zsh", args: ["-lic", "exec claude"], title: "Claude Code", display: "claude" };
  }
  return { file: "/bin/zsh", args: ["-lic", "exec codex"], title: "Codex", display: "codex" };
}
