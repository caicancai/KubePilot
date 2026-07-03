# KubePilot Agent Guide

This document defines how KubePilot Console should behave as an agent-driven Kubernetes tool. It is written for maintainers and future coding agents working in this repository.

## Product Contract

KubePilot is not a general shell agent. It is a local Kubernetes console where the user chats with Codex or Claude Code, while concrete Kubernetes operations are projected into a terminal.

The core contract:

- Chat may contain planning, explanations, questions, and agent progress.
- The projected terminal must only show concrete Kubernetes-related commands and their output.
- Large inline manifests should be shortened in terminal projection and reviewed in the approval panel.
- Kubernetes commands must run through one serialized queue.
- Mutating commands must stop at a review and approval gate.
- The user can type verification commands into the projected terminal.
- Agent reasoning must not be projected into the terminal.
- All cluster state used for answers should come from real command output, not guesses.

The terminal is a projection of structured command lifecycle events. Internally, commands should be modeled as intents with:

- stable command id,
- domain,
- source,
- mode,
- command text,
- purpose,
- status,
- result.

## Runtime Roles

KubePilot uses orchestrated specialists, not free-running multi-agent autonomy.

### Planner

The selected local agent, Codex or Claude Code, acts as the planner.

Responsibilities:

- Understand the user's request.
- Ask clarifying questions when needed.
- Propose complete Kubernetes commands when cluster data is required.
- Explain command results after they are returned.
- Continue the task after setup commands when the user objective is not complete.

Constraints:

- The planner must not execute `kubectl`, `helm`, `stern`, or related Kubernetes commands itself.
- The planner should output complete shell commands on their own lines when it wants the app to run them.
- The planner should not use placeholders, ellipses, or partial commands.

### Executor

The backend executor owns command parsing, classification, queuing, execution, memory, and result feedback.

Responsibilities:

- Extract Kubernetes commands from planner output using Bash AST parsing.
- Convert commands into structured command intents.
- Classify each command as `observe`, `setup`, `approval`, or `blocked`.
- Run commands sequentially.
- Send command output to the terminal and command results back to chat.
- Feed command results back to the planner when automatic continuation is allowed.
- Persist session and cluster memory.
- Persist the visible timeline per agent and kube context.

Constraints:

- Never run two Kubernetes commands concurrently in one session.
- Never run mutating commands before approval.
- Never run incomplete commands such as `kubectl apply -f`.

### Reviewer

Reviewer is a deterministic specialist pass before mutating commands.

Responsibilities:

- Inspect the command, manifest preview, selected context, namespace, files, and cluster memory.
- Assign risk: `low`, `medium`, or `high`.
- Produce findings for the approval panel.
- Produce post-approval verification checks.
- Emit a chat-visible review summary.

Constraints:

- Reviewer does not run commands.
- Reviewer does not approve or reject commands.
- Reviewer is advisory; the user remains the final approver.

### Diagnoser

Diagnoser is a deterministic specialist pass after command results.

Responsibilities:

- Explain common Kubernetes failures, including image pull errors, scheduling failures, CrashLoopBackOff, and generic non-zero exits.
- Quote concise evidence from command output.
- Suggest the next concrete diagnostic or fix direction.
- Persist diagnosis into memory.

Constraints:

- Diagnoser does not run commands.
- User rejection of an approval is not a workload failure and should not create a diagnosis.

## Command Policy

Command classification lives in `server/index.ts`.

Current domains:

- `kubernetes`: enabled for structured agent execution.
- `shell`: recognized as a future domain, but blocked for agent-controlled execution by default.

| Mode | Behavior | Examples |
| --- | --- | --- |
| `observe` | Execute directly and feed results back when agent-driven. | `kubectl get`, `kubectl describe`, `kubectl logs`, `helm list`, `helm status` |
| `setup` | Execute directly when considered safe and idempotent. | namespace ensure, `helm repo add`, `helm repo update` |
| `approval` | Stop, render preview, run Reviewer, wait for user approval. | `kubectl apply`, `kubectl delete`, `kubectl patch`, `helm upgrade` |
| `blocked` | Do not execute. Return a command result explaining the block. | unsupported or incomplete commands |

Rules:

- Use AST extraction for command discovery. Do not replace it with ad hoc regex extraction.
- Regex is acceptable for narrow command classification after AST extraction.
- Commands with placeholders, ellipses, `TODO`, or missing arguments must be blocked.
- Remote manifests should be treated as higher risk unless rendered locally.
- Inline heredoc manifests should be previewed before approval.
- Inline heredoc manifests should not be printed into the terminal as full YAML; terminal output should show a compact preview and point to the review panel.

## Agent Loop

The loop should remain serialized:

1. User sends a chat message or terminal command.
2. Planner responds in chat and may propose K8s commands.
3. Executor extracts commands and queues them.
4. Executor runs one command at a time.
5. Observe/setup results are returned to chat and memory.
6. Mutating commands enter Reviewer approval.
7. Approved commands execute.
8. Results trigger Diagnoser if needed.
9. The planner may continue automatically while the continuation budget allows it.

The loop must avoid these failure modes:

- multiple commands stuck in `running`,
- deployment after namespace creation never continuing,
- command output shown without explanation,
- planner repeating the same command after a result,
- terminal showing agent thought text,
- approval prompt without enough YAML or command context.

## Memory

Memory is local by default:

```text
~/.kubepilot-console
```

Override:

```bash
KUBEPILOT_HOME=/path/to/state npm run app
```

Memory layout:

```text
sessions/
  session-.../
    meta.json
    events.jsonl
    summary.json
clusters/
  <context-id>.json
```

Memory should store:

- session metadata,
- user chat events,
- assistant chat events,
- command start and result events,
- approval events,
- specialist review events,
- diagnosis events,
- compacted session summaries,
- cluster-scoped recent activity.
- visible chat and command timeline in browser `localStorage`, scoped by agent and kube context.

Memory should not:

- make unrelated historical sessions dominate the current prompt,
- treat user-rejected approvals as workload failures,
- silently hide sensitive output concerns from the user.
- preserve pending `Sending` states across reloads.

Clear behavior:

- The UI Clear action removes the visible timeline for the current agent/context.
- The UI Clear action sends `clearMemory` to the backend.
- Backend clear resets current session transcript, rolling summary, and current cluster memory.
- Clear should not erase the terminal screen.

## UI Contract

The first screen is a launcher:

- select Kubernetes context,
- select Codex or Claude Code,
- open console.

The session screen has only:

- chat,
- projected terminal,
- approval overlay when needed.

Important UI behavior:

- Enter sends chat.
- Shift+Enter inserts a newline.
- Enter during IME composition must not send.
- The terminal should auto-scroll to the latest output.
- The terminal should occupy about two thirds of the workspace.
- The chat header should provide a Clear action for context/history reset.
- The approval overlay must show command, Reviewer risk/findings/checks, and manifest preview.

All UI copy should be English.

## Implementation Map

Primary files:

- `server/index.ts`: WebSocket server, planner prompt, command extraction, queue, approval, memory, Reviewer, Diagnoser.
- `src/main.tsx`: React UI, launcher, chat pane, terminal pane, approval overlay.
- `src/styles.css`: layout and terminal/review styling.
- `electron/`: desktop app launcher.
- `scripts/fix-pty-perms.cjs`: local PTY permission helper.

## Test Checklist

Before committing meaningful loop changes, run:

```bash
npm run build
```

For runtime smoke testing, start a temporary backend:

```bash
KUBEPILOT_HOME=/tmp/kubepilot-review-test AGENT_TERMINAL_PORT=18878 npm start
```

Recommended smoke cases:

- `GET /api/kube-contexts` returns contexts.
- Create a WebSocket session.
- Type `kubectl config current-context`; expect exit `0`.
- Type a read-only command that fails, such as a missing namespace; expect Diagnoser output.
- Type a mutating command, such as `kubectl delete namespace test`; expect Reviewer approval, not execution.
- Reject approval; expect exit `130` and no Diagnoser workload failure.
- Inspect `/tmp/kubepilot-review-test/sessions/*/events.jsonl`.
- Inspect `/tmp/kubepilot-review-test/clusters/*.json`.

## Non-Goals

Do not add free-running autonomous multi-agent behavior yet.

Avoid:

- concurrent K8s execution from multiple agents,
- hidden shell sessions that mutate the cluster,
- terminal projection of private reasoning,
- generic shell-agent behavior that is not Kubernetes-aware,
- background deployment without YAML or command review.

## Current Direction

Prefer depth over breadth:

- better command policy,
- stronger manifest rendering and diff review,
- richer Kubernetes diagnosis,
- reliable session export,
- integration tests for the agent loop,
- packaged desktop builds.
