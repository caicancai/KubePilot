import React from "react";
import ReactDOM from "react-dom/client";
import { ArrowLeft, Bot, CheckCircle2, Clock3, MessageSquareText, RefreshCw, SendHorizontal, TerminalSquare, Trash2, User, XCircle } from "lucide-react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

type SessionKind = "codex" | "claude";
type CommandDomain = "kubernetes" | "shell";
type CommandMode = "observe" | "setup" | "approval" | "blocked";
type CommandSource = "agent" | "user";

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

type ChatItem = {
  id: string;
  role: "user" | "assistant" | "system" | "command" | "result";
  text: string;
  at: string;
  pending?: boolean;
  commandId?: string;
  domain?: CommandDomain;
  mode?: CommandMode;
  source?: CommandSource;
  command?: string;
  summary?: string;
  exitCode?: number;
  durationMs?: number;
  output?: string;
};

type TerminalController = {
  sendChat(text: string): boolean;
  approve(id: string): boolean;
  reject(id: string): boolean;
  clearMemory(): boolean;
  close(): void;
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

type SpecialistReview = {
  specialist: "Reviewer";
  risk: "low" | "medium" | "high";
  summary: string;
  findings: string[];
  nextChecks: string[];
};

const sessionOptions: Array<{ kind: SessionKind; label: string; badge: string }> = [
  { kind: "codex", label: "Codex", badge: "CX" },
  { kind: "claude", label: "Claude Code", badge: "CC" }
];

const selectionStorageKey = "kubepilot:selection";

function readStoredSelection(): { kind: SessionKind; kubeContextId: string } {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(selectionStorageKey) || "{}") as Partial<{ kind: SessionKind; kubeContextId: string }>;
    return {
      kind: parsed.kind === "claude" ? "claude" : "codex",
      kubeContextId: typeof parsed.kubeContextId === "string" ? parsed.kubeContextId : ""
    };
  } catch {
    return { kind: "codex" as SessionKind, kubeContextId: "" };
  }
}

function chatStorageKey(kind: SessionKind, kubeContextId: string) {
  return `kubepilot:chat:${kind}:${kubeContextId || "current"}`;
}

function loadStoredChat(kind: SessionKind, kubeContextId: string): ChatItem[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(chatStorageKey(kind, kubeContextId)) || "[]") as ChatItem[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item.id === "string" && typeof item.text === "string" && typeof item.at === "string")
      .map((item) => ({ ...item, pending: false }))
      .slice(-300);
  } catch {
    return [];
  }
}

function saveStoredChat(kind: SessionKind, kubeContextId: string, chat: ChatItem[]) {
  const stableItems = chat.map((item) => ({ ...item, pending: false })).slice(-300);
  window.localStorage.setItem(chatStorageKey(kind, kubeContextId), JSON.stringify(stableItems));
}

function App() {
  const [kind, setKind] = React.useState<SessionKind>(() => readStoredSelection().kind);
  const [kubeContexts, setKubeContexts] = React.useState<KubeContextOption[]>([]);
  const [kubeContextId, setKubeContextId] = React.useState(() => readStoredSelection().kubeContextId);
  const [isSessionOpen, setIsSessionOpen] = React.useState(false);
  const [sessionKey, setSessionKey] = React.useState(0);
  const [status, setStatus] = React.useState("Not started");
  const [meta, setMeta] = React.useState<{ title: string; cwd: string; command: string } | undefined>();
  const [kube, setKube] = React.useState<ResolvedKubeTarget | undefined>();
  const [chat, setChat] = React.useState<ChatItem[]>([]);
  const [approval, setApproval] = React.useState<DeploymentApproval | undefined>();
  const [draft, setDraft] = React.useState("");
  const [controller, setController] = React.useState<TerminalController | undefined>();
  const chatFeedRef = React.useRef<HTMLDivElement | null>(null);
  const isComposingRef = React.useRef(false);

  const activeOption = sessionOptions.find((option) => option.kind === kind) ?? sessionOptions[0];
  const selectedContext = kubeContexts.find((context) => context.id === kubeContextId);

  const openSession = React.useCallback((nextKind = kind, nextKubeContextId = kubeContextId) => {
    setKind(nextKind);
    setKubeContextId(nextKubeContextId);
    setIsSessionOpen(true);
    setMeta(undefined);
    setKube(undefined);
    setChat(loadStoredChat(nextKind, nextKubeContextId));
    setApproval(undefined);
    setStatus("Starting...");
    setSessionKey((value) => value + 1);
  }, [kind, kubeContextId]);

  const closeSession = () => {
    controller?.close();
    setController(undefined);
    setIsSessionOpen(false);
    setMeta(undefined);
    setKube(undefined);
    setChat([]);
    setApproval(undefined);
    setDraft("");
    setStatus("Not started");
  };

  const refreshContexts = React.useCallback(() => {
    return fetch("http://127.0.0.1:8787/api/kube-contexts")
      .then((response) => response.json() as Promise<{ contexts: KubeContextOption[]; selectedId?: string }>)
      .then((data) => {
        setKubeContexts(data.contexts);
        const stored = readStoredSelection();
        const storedContextId = data.contexts.find((context) => context.id === stored.kubeContextId)?.id;
        const nextId =
          data.contexts.find((context) => context.id === kubeContextId)?.id ??
          storedContextId ??
          data.selectedId ??
          data.contexts[0]?.id ??
          "";
        setKubeContextId(nextId);
        return nextId;
      });
  }, [kubeContextId]);

  React.useEffect(() => {
    let cancelled = false;
    fetch("http://127.0.0.1:8787/api/kube-contexts")
      .then((response) => response.json() as Promise<{ contexts: KubeContextOption[]; selectedId?: string }>)
      .then((data) => {
        if (cancelled) return;
        setKubeContexts(data.contexts);
        const stored = readStoredSelection();
        const selectedId = data.contexts.find((context) => context.id === stored.kubeContextId)?.id ?? data.selectedId ?? data.contexts[0]?.id ?? "";
        setKubeContextId(selectedId);
      })
      .catch(() => {
        if (cancelled) return;
        setKubeContextId("");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const sendChat = () => {
    const text = draft.trim();
    if (!text || !controller) return;
    const id = `chat-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
    if (!controller.sendChat(text)) {
      setStatus("Disconnected");
      setController(undefined);
      return;
    }
    setChat((items) => [
      ...items,
      {
        id,
        role: "user",
        text,
        at: new Date().toISOString(),
        pending: true
      }
    ]);
    setDraft("");
    window.setTimeout(() => {
      setChat((items) => items.map((item) => (item.id === id && item.pending ? { ...item, pending: false } : item)));
    }, 3000);
  };

  const clearSessionHistory = () => {
    window.localStorage.removeItem(chatStorageKey(kind, kubeContextId));
    setChat([]);
    setApproval(undefined);
    controller?.clearMemory();
  };

  React.useEffect(() => {
    window.localStorage.setItem(selectionStorageKey, JSON.stringify({ kind, kubeContextId }));
  }, [kind, kubeContextId]);

  React.useEffect(() => {
    if (!isSessionOpen) return;
    saveStoredChat(kind, kubeContextId, chat);
  }, [chat, isSessionOpen, kind, kubeContextId]);

  React.useEffect(() => {
    const feed = chatFeedRef.current;
    if (!feed) return;
    feed.scrollTo({ top: feed.scrollHeight, behavior: "smooth" });
  }, [chat]);

  if (!isSessionOpen) {
    return (
      <div className="launcher-shell">
        <header className="launcher-header">
          <div className="brand large">
            <TerminalSquare size={22} />
            <span>K8s Agent Console</span>
          </div>
          <button className="refresh-button" onClick={() => void refreshContexts()} type="button">
            <RefreshCw size={15} />
            Refresh
          </button>
        </header>

        <main className="launcher-main">
          <section className="launcher-section cluster-section">
            <div className="section-heading">
              <div className="eyebrow">Cluster</div>
              <h1>Select a Kubernetes Context</h1>
            </div>
            <div className="cluster-list">
              {kubeContexts.length === 0 ? (
                <button className="cluster-row active" type="button" onClick={() => setKubeContextId("")}>
                  <span className="cluster-name">Current kube context</span>
                  <span className="cluster-meta">kubectl default</span>
                </button>
              ) : (
                kubeContexts.map((context) => (
                  <button
                    className={context.id === kubeContextId ? "cluster-row active" : "cluster-row"}
                    key={context.id}
                    onClick={() => setKubeContextId(context.id)}
                    type="button"
                  >
                    <span className="cluster-name">{context.context}</span>
                    <span className="cluster-meta">
                      {context.source}
                      {context.current ? " · current" : ""}
                    </span>
                  </button>
                ))
              )}
            </div>
          </section>

          <section className="launcher-section agent-section">
            <div className="section-heading">
              <div className="eyebrow">Agent</div>
              <h1>Choose Runtime</h1>
            </div>
            <div className="agent-list">
              {sessionOptions.map((option) => (
                <button
                  className={option.kind === kind ? "agent-row active" : "agent-row"}
                  key={option.kind}
                  onClick={() => setKind(option.kind)}
                  type="button"
                >
                  <span>{option.badge}</span>
                  <strong>{option.label}</strong>
                </button>
              ))}
            </div>
            <button className="open-session-button" onClick={() => openSession(kind, kubeContextId)} type="button">
              Open Console
            </button>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <main className="workspace">
        <aside className="chat-pane">
          <div className="pane-heading">
            <div>
              <div className="eyebrow">{selectedContext?.context ?? kube?.context ?? "Current context"}</div>
              <h1>{activeOption.label} Kubernetes</h1>
            </div>
            <div className="pane-actions">
              <button className="icon-button" onClick={clearSessionHistory} title="Clear session history" type="button">
                <Trash2 size={16} />
              </button>
              <button className="icon-button" onClick={closeSession} title="Back to cluster selection" type="button">
                <ArrowLeft size={16} />
              </button>
            </div>
          </div>

          <div className="chat-feed" ref={chatFeedRef}>
            {chat.length === 0 ? (
              <div className="empty-state">
                <MessageSquareText size={20} />
                <p>Describe the cluster issue here. The terminal accepts your own commands and projects only Kubernetes commands plus results from the agent.</p>
              </div>
            ) : (
              chat.map((item) => <ChatMessage item={item} key={item.id} />)
            )}
          </div>

          <div className="composer">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onCompositionStart={() => {
                isComposingRef.current = true;
              }}
              onCompositionEnd={() => {
                isComposingRef.current = false;
              }}
              onKeyDown={(event) => {
                const nativeEvent = event.nativeEvent as KeyboardEvent & { isComposing?: boolean };
                if (nativeEvent.isComposing || isComposingRef.current || nativeEvent.keyCode === 229) {
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  sendChat();
                }
              }}
              placeholder={`Ask ${activeOption.label}: for example, inspect unhealthy pods in default...`}
            />
            <button className="send-button" onClick={sendChat} disabled={!controller || !draft.trim()} type="button">
              <SendHorizontal size={16} />
              Send
            </button>
          </div>
        </aside>

        <section className="terminal-pane">
          <div className="terminal-header">
            <div>
              <div className="terminal-title">{meta?.title ?? activeOption.label} Projected Terminal</div>
              <div className="terminal-subtitle">
                {meta
                  ? `${meta.command} · ${kube?.context ? `context ${kube.context}` : "current kube context"} · ${meta.cwd}`
                  : status}
              </div>
            </div>
            <span className={status === "Running" ? "status live" : "status"}>{status}</span>
          </div>
          <TerminalView
            key={sessionKey}
            kind={kind}
            kubeContextId={kubeContextId}
            onController={setController}
            onMeta={(nextMeta) => {
              setMeta(nextMeta);
              setKube(nextMeta.kube);
              setStatus("Running");
            }}
            onApproval={setApproval}
            onStatus={(nextStatus) => {
              setStatus(nextStatus);
              if (nextStatus === "Disconnected") {
                setChat((items) => items.map((item) => (item.pending ? { ...item, pending: false } : item)));
              }
            }}
            onOperation={(operation, at) => {
              setChat((items) => [
                ...items,
                {
                  id: operation.id,
                  role: "command",
                  text: operation.command,
                  commandId: operation.id,
                  domain: operation.domain,
                  mode: operation.mode,
                  source: operation.source,
                  command: operation.command,
                  summary: operation.summary,
                  at
                }
              ]);
            }}
            onCommandResult={(result) => {
              setChat((items) => {
                const targetIndex = findLastIndex(
                  items,
                  (item) =>
                    item.role === "command" &&
                    item.exitCode === undefined &&
                    (result.id ? item.commandId === result.id : item.command === result.command)
                );
                if (targetIndex === -1) {
                  return [
                    ...items,
                    {
                      id: result.id ?? `result-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`,
                      role: "result",
                      text: result.output || "(no output)",
                      commandId: result.id,
                      domain: result.domain,
                      command: result.command,
                      exitCode: result.exitCode,
                      durationMs: result.durationMs,
                      output: result.output || "(no output)",
                      at: result.at
                    }
                  ];
                }
                return items.map((item, index) =>
                  index === targetIndex
                    ? {
                        ...item,
                        pending: false,
                        exitCode: result.exitCode,
                        durationMs: result.durationMs,
                        output: result.output || "(no output)",
                        at: result.at
                      }
                    : item
                );
              });
            }}
            onChat={(text, at) => {
              setChat((items) => {
                const pendingIndex = items.findIndex((item) => item.pending && item.text === text);
                if (pendingIndex === -1) {
                  return [
                    ...items,
                    {
                      id: `chat-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`,
                      role: "user",
                      text,
                      at
                    }
                  ];
                }
                return items.map((item, index) => (index === pendingIndex ? { ...item, at, pending: false } : item));
              });
            }}
            onAgentText={(text, at) => {
              setChat((items) => [
                ...items,
                {
                  id: `agent-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`,
                  role: "assistant",
                  text,
                  at
                }
              ]);
            }}
            onAgentStart={(id, at) => {
              setChat((items) => [
                ...items,
                {
                  id,
                  role: "assistant",
                  text: "",
                  at,
                  pending: true
                }
              ]);
            }}
            onAgentDelta={(id, text) => {
              setChat((items) => items.map((item) => (item.id === id ? { ...item, text: `${item.text}${text}` } : item)));
            }}
            onAgentDone={(id, text, at) => {
              setChat((items) => {
                if (!text.trim()) return items.filter((item) => item.id !== id);
                return items.map((item) => (item.id === id ? { ...item, text, at, pending: false } : item));
              });
            }}
          />
          {approval ? (
            <ApprovalOverlay
              approval={approval}
              onApprove={() => {
                controller?.approve(approval.id);
                setApproval(undefined);
              }}
              onReject={() => {
                controller?.reject(approval.id);
                setApproval(undefined);
              }}
            />
          ) : null}
        </section>
      </main>
    </div>
  );
}

function TerminalView(props: {
  kind: SessionKind;
  kubeContextId: string;
  onController(controller: TerminalController | undefined): void;
  onMeta(meta: { title: string; cwd: string; command: string; kube: ResolvedKubeTarget }): void;
  onApproval(approval: DeploymentApproval): void;
  onStatus(status: string): void;
  onOperation(operation: Extract<ServerMessage, { type: "operation" }>, at: string): void;
  onCommandResult(result: Extract<ServerMessage, { type: "commandResult" }>): void;
  onChat(text: string, at: string): void;
  onAgentText(text: string, at: string): void;
  onAgentStart(id: string, at: string): void;
  onAgentDelta(id: string, text: string): void;
  onAgentDone(id: string, text: string, at: string): void;
}) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const commandInputRef = React.useRef<HTMLInputElement | null>(null);
  const socketRef = React.useRef<WebSocket | null>(null);
  const terminalComposingRef = React.useRef(false);
  const [terminalDraft, setTerminalDraft] = React.useState("");
  const [promptLabel, setPromptLabel] = React.useState("cluster");

  const submitTerminalCommand = React.useCallback(() => {
    const command = terminalDraft.trim();
    if (!command) return;
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      props.onStatus("Disconnected");
      props.onController(undefined);
      return;
    }
    socket.send(JSON.stringify({ type: "terminalCommand", command }));
    setTerminalDraft("");
  }, [props, terminalDraft]);

  React.useEffect(() => {
    const terminal = new Terminal({
      cursorBlink: true,
      disableStdin: true,
      fontFamily: "JetBrains Mono, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.18,
      scrollback: 50000,
      theme: {
        background: "#101316",
        foreground: "#d8dee6",
        cursor: "#7dd3fc",
        black: "#15191f",
        blue: "#6ea8fe",
        cyan: "#5eead4",
        green: "#8bd17c",
        magenta: "#c084fc",
        red: "#ff7b72",
        white: "#d8dee6",
        yellow: "#f4c95d"
      }
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    const socket = new WebSocket(`ws://${window.location.hostname || "127.0.0.1"}:8787/session`);
    socketRef.current = socket;
    let isReady = false;

    terminal.open(containerRef.current!);
    let resizeFrame = 0;
    let lastCols = terminal.cols;
    let lastRows = terminal.rows;

    const fitTerminal = () => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        fitAddon.fit();
        if (!isReady) return;
        if (terminal.cols === lastCols && terminal.rows === lastRows) return;
        lastCols = terminal.cols;
        lastRows = terminal.rows;
        socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
      });
    };

    queueMicrotask(fitTerminal);
    terminal.focus();

    const resizeObserver = new ResizeObserver(() => {
      fitTerminal();
    });
    resizeObserver.observe(containerRef.current!);

    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          type: "create",
          kind: props.kind,
          kubeContextId: props.kubeContextId,
          cols: terminal.cols,
          rows: terminal.rows
        })
      );
    });

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data) as ServerMessage;
      if (message.type === "ready") {
        isReady = true;
        setPromptLabel(message.kube.context ?? "cluster");
        props.onMeta({ title: message.title, cwd: message.cwd, command: message.command, kube: message.kube });
        socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
        commandInputRef.current?.focus();
      } else if (message.type === "terminalData") {
        terminal.write(message.data, () => terminal.scrollToBottom());
      } else if (message.type === "operation") {
        props.onOperation(message, new Date().toISOString());
      } else if (message.type === "commandResult") {
        props.onCommandResult(message);
      } else if (message.type === "approval") {
        props.onApproval(message.approval);
      } else if (message.type === "chatEcho") {
        props.onChat(message.text, message.at);
      } else if (message.type === "chatAgent") {
        props.onAgentText(message.text, message.at);
      } else if (message.type === "chatAgentStart") {
        props.onAgentStart(message.id, message.at);
      } else if (message.type === "chatAgentDelta") {
        props.onAgentDelta(message.id, message.text);
      } else if (message.type === "chatAgentDone") {
        props.onAgentDone(message.id, message.text, message.at);
      } else if (message.type === "status") {
        props.onStatus(message.running ? "Running" : `Exited ${message.exitCode ?? ""}`.trim());
      } else if (message.type === "error") {
        props.onStatus(message.message);
        terminal.writeln(`\r\n[agent-terminal] ${message.message}`);
      }
    });

    socket.addEventListener("close", () => {
      props.onStatus("Disconnected");
      props.onController(undefined);
    });

    props.onController({
      sendChat(text: string) {
        if (socket.readyState !== WebSocket.OPEN) {
          props.onStatus("Disconnected");
          props.onController(undefined);
          return false;
        }
        socket.send(JSON.stringify({ type: "chat", text }));
        return true;
      },
      approve(id: string) {
        if (socket.readyState !== WebSocket.OPEN) {
          props.onStatus("Disconnected");
          props.onController(undefined);
          return false;
        }
        socket.send(JSON.stringify({ type: "approve", id }));
        return true;
      },
      reject(id: string) {
        if (socket.readyState !== WebSocket.OPEN) {
          props.onStatus("Disconnected");
          props.onController(undefined);
          return false;
        }
        socket.send(JSON.stringify({ type: "reject", id }));
        return true;
      },
      clearMemory() {
        if (socket.readyState !== WebSocket.OPEN) {
          props.onStatus("Disconnected");
          props.onController(undefined);
          return false;
        }
        socket.send(JSON.stringify({ type: "clearMemory" }));
        return true;
      },
      close() {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "close" }));
        }
      }
    });

    return () => {
      props.onController(undefined);
      socketRef.current = null;
      cancelAnimationFrame(resizeFrame);
      resizeObserver.disconnect();
      socket.close();
      terminal.dispose();
    };
  }, [props.kind, props.kubeContextId]);

  return (
    <div className="terminal-stack">
      <div className="terminal-host" ref={containerRef} />
      <form
        className="terminal-command-line"
        onSubmit={(event) => {
          event.preventDefault();
          submitTerminalCommand();
        }}
      >
        <span className="terminal-command-prompt">{promptLabel} ›</span>
        <input
          ref={commandInputRef}
          value={terminalDraft}
          onChange={(event) => setTerminalDraft(event.target.value)}
          onCompositionStart={() => {
            terminalComposingRef.current = true;
          }}
          onCompositionEnd={() => {
            terminalComposingRef.current = false;
          }}
          onKeyDown={(event) => {
            const nativeEvent = event.nativeEvent as KeyboardEvent & { isComposing?: boolean };
            if (nativeEvent.isComposing || terminalComposingRef.current || nativeEvent.keyCode === 229) return;
            if (event.key === "Enter") {
              event.preventDefault();
              submitTerminalCommand();
            }
          }}
          placeholder="Type a verification command..."
          spellCheck={false}
          autoCapitalize="none"
          autoComplete="off"
        />
      </form>
    </div>
  );
}

function ChatMessage({ item }: { item: ChatItem }) {
  const icon =
    item.role === "user" ? (
      <User size={14} />
    ) : item.role === "command" ? (
      <TerminalSquare size={14} />
    ) : item.role === "result" && item.exitCode === 0 ? (
      <CheckCircle2 size={14} />
    ) : item.role === "result" ? (
      <XCircle size={14} />
    ) : (
      <Bot size={14} />
    );
  const title =
    item.role === "user"
      ? "You"
      : item.role === "command"
        ? "Command"
        : item.role === "result"
          ? `Result ${item.exitCode ?? 0}`
          : "Agent";

  if (item.role === "command") {
    const isComplete = item.exitCode !== undefined;
    const isOk = item.exitCode === 0;
    const output = item.output ?? "";
    const isEmpty = output.trim() === "(no output)" || output.trim() === "";
    return (
      <article className={`chat-card command ${isComplete ? (isOk ? "ok" : "failed") : "running"}`}>
        <ChatMessageHeader icon={icon} title={title} at={item.at} pending={item.pending} pendingLabel="Running" />
        {item.summary ? <div className="command-summary">{item.summary}</div> : null}
        <code className="command-line">{item.command ?? item.text}</code>
        <div className="tool-status-row">
          <span className="tool-status-dot" />
          <span>{isComplete ? `exit ${item.exitCode}` : "running"}</span>
          {isComplete ? <span>{formatDuration(item.durationMs)}</span> : null}
        </div>
        {isComplete ? (
          <div className="tool-response">
            <span className="tool-response-glyph">⎿</span>
            <pre className={isEmpty ? "result-output empty" : "result-output"}>{isEmpty ? "(no output)" : output}</pre>
          </div>
        ) : null}
      </article>
    );
  }

  if (item.role === "result") {
    const isEmpty = item.text.trim() === "(no output)";
    return (
      <article className={`chat-card result ${item.exitCode === 0 ? "ok" : "failed"}`}>
        <ChatMessageHeader icon={icon} title={title} at={item.at} pending={item.pending} pendingLabel="Running" />
        <div className="result-meta">
          <span>exit {item.exitCode ?? 0}</span>
          <span>{formatDuration(item.durationMs)}</span>
        </div>
        <pre className={isEmpty ? "result-output empty" : "result-output"}>{item.text}</pre>
      </article>
    );
  }

  return (
    <article className={`chat-card ${item.role}${item.pending ? " pending" : ""}`}>
      <ChatMessageHeader icon={icon} title={title} at={item.at} pending={item.pending} pendingLabel={item.role === "assistant" ? "Streaming" : "Sending"} />
      <div className="message-content">{renderRichText(item.text)}</div>
    </article>
  );
}

function ChatMessageHeader(props: { icon: React.ReactNode; title: string; at: string; pending?: boolean; pendingLabel?: string }) {
  return (
    <div className="message-header">
      <span className="message-role">
        {props.icon}
        {props.title}
      </span>
      <span className="message-time">
        {props.pending ? <Clock3 size={12} /> : null}
        {props.pending ? props.pendingLabel ?? "Working" : formatTime(props.at)}
      </span>
    </div>
  );
}

function renderRichText(text: string) {
  const parts = text.split(/```/g);
  return parts.map((part, index) => {
    if (index % 2 === 1) {
      const lines = part.replace(/^\w+\n/, "").trim();
      return (
        <pre className="message-code" key={index}>
          {lines}
        </pre>
      );
    }
    return (
      <React.Fragment key={index}>
        {part.split("\n").map((line, lineIndex) => (
          <p key={`${index}-${lineIndex}`}>{renderInlineCode(line)}</p>
        ))}
      </React.Fragment>
    );
  });
}

function renderInlineCode(line: string) {
  const parts = line.split(/(`[^`]+`)/g);
  return parts.map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={index}>{part.slice(1, -1)}</code>;
    }
    return <React.Fragment key={index}>{part}</React.Fragment>;
  });
}

function ApprovalOverlay(props: {
  approval: DeploymentApproval;
  onApprove(): void;
  onReject(): void;
}) {
  return (
    <div className="approval-overlay">
      <div className="approval-header">
        <div>
          <div className="eyebrow">Deployment Review</div>
          <h1>{props.approval.title}</h1>
        </div>
        <div className="approval-actions">
          <button className="reject-button" onClick={props.onReject} type="button">
            Reject
          </button>
          <button className="approve-button" onClick={props.onApprove} type="button">
            Approve
          </button>
        </div>
      </div>
      <div className="approval-command">{props.approval.command}</div>
      <section className={`review-panel risk-${props.approval.review.risk}`}>
        <div className="review-summary">
          <span>{props.approval.review.specialist}</span>
          <strong>{props.approval.review.risk.toUpperCase()} risk</strong>
          <p>{props.approval.review.summary}</p>
        </div>
        <div className="review-grid">
          <div>
            <h2>Findings</h2>
            <ul>
              {props.approval.review.findings.map((finding) => (
                <li key={finding}>{finding}</li>
              ))}
            </ul>
          </div>
          <div>
            <h2>Post-Approval Checks</h2>
            <ul>
              {props.approval.review.nextChecks.map((check) => (
                <li key={check}>{check}</li>
              ))}
            </ul>
          </div>
        </div>
      </section>
      <pre className="yaml-preview">{props.approval.manifest}</pre>
    </div>
  );
}

function escapeControl(value: string) {
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function formatDuration(value?: number) {
  if (value === undefined) return "duration unknown";
  if (value < 1000) return `${Math.max(1, Math.round(value))}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

function findLastIndex<T>(items: T[], predicate: (item: T, index: number) => boolean) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index], index)) return index;
  }
  return -1;
}

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
