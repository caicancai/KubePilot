# KubePilot Console

KubePilot Console is a local desktop app for Kubernetes investigation and deployment with Codex or Claude Code.

The idea is simple: you talk to an agent in chat, and every Kubernetes operation the agent actually runs is projected into a terminal you can read, verify, and interact with. The chat can contain the agent's normal reasoning and context gathering, while the terminal only shows concrete cluster commands and their results.

## What It Does

- Selects a Kubernetes context from your local kubeconfig before starting a session.
- Supports Codex and Claude Code as local agents.
- Keeps the main workspace focused on two panes: chat and terminal.
- Streams agent responses in chat so progress is visible while the agent works.
- Projects `kubectl`, `helm`, and related Kubernetes commands into the terminal.
- Lets you type verification commands directly into the projected terminal.
- Runs Kubernetes commands sequentially through a command queue instead of firing everything at once.
- Tracks each projected command as a structured command intent with id, domain, source, mode, purpose, status, and result.
- Uses Bash AST parsing with `ast-grep` for command extraction and classification.
- Requires approval for mutating operations and shows the YAML before deployment.
- Feeds command results back to the agent so it can explain errors and continue from real cluster state.
- Persists local session memory, command audit events, and cluster-scoped recent context.
- Uses orchestrated specialists for review and diagnosis without allowing parallel autonomous cluster changes.

## Why

General agent terminals are noisy for Kubernetes work. They mix chat, tool calls, shell state, partial commands, and model output in ways that make it hard to tell what actually happened to the cluster.

KubePilot Console is intentionally narrower. It is built for Kubernetes operators who want:

- agent assistance in chat,
- a clear audit trail of cluster commands,
- real command output,
- manual verification from the same terminal,
- and approval gates before deployment or mutation.

## How It Works

1. Pick a cluster context from the launcher.
2. Pick an agent: Codex or Claude Code.
3. Ask a Kubernetes question or request an operation in chat.
4. The backend asks the agent for the next useful action.
5. Kubernetes commands are parsed, classified, queued, and projected into the terminal.
6. Command output is sent back to the agent for the next response.

The main agent remains the planner. Kubernetes execution still goes through one serialized queue and one approval gate.

Internally, projected commands are represented as command intents rather than raw terminal text. This is the foundation for an agent-native terminal runtime: the terminal is a human-readable projection of structured command lifecycle events.

Specialists are controlled internal passes:

- `Reviewer`: runs before mutating commands and adds a risk summary, findings, and post-approval checks to the deployment review.
- `Diagnoser`: runs after command results and turns common Kubernetes failures into concise explanations and next steps.

Specialists do not run Kubernetes commands directly.

Command modes:

- `observe`: read-only investigation commands such as `kubectl get`, `kubectl describe`, and logs.
- `setup`: safe setup commands that are idempotent or required before a deploy, such as namespace creation.
- `approval`: mutating commands that need explicit user approval and YAML preview.
- `blocked`: incomplete, placeholder, or unsafe commands that should not run.

## Requirements

- Node.js 20 or newer.
- `kubectl` installed and authenticated locally.
- At least one kubeconfig context.
- Optional: `helm`, `stern`, Codex CLI, and Claude Code CLI depending on the workflows you use.

The app currently targets local desktop usage. It should not be exposed as a public WebSocket service.

## Run

Install dependencies:

```bash
npm install
```

Start the desktop app:

```bash
npm run app
```

For browser development:

```bash
npm run dev
```

Then open:

```text
http://127.0.0.1:5174
```

Build:

```bash
npm run build
```

## Kubeconfig Discovery

KubePilot Console scans local Kubernetes configuration and presents contexts in the launcher.

Supported sources:

- default kubeconfig locations,
- minikube contexts,
- AWS EKS contexts already present in kubeconfig,
- `K8S_AGENT_AWS_KUBECONFIG`,
- `K8S_AGENT_MINIKUBE_KUBECONFIG`.

Multiple AWS clusters are expected. The launcher is context based, so each discovered context can be selected separately.

## Memory

KubePilot Console keeps memory local by default.

Default location:

```text
~/.kubepilot-console
```

Override it with:

```bash
KUBEPILOT_HOME=/path/to/local/state npm run app
```

Stored memory includes:

- session metadata,
- chat transcript events,
- command start/result audit events,
- approval pending/accepted/rejected events,
- lightweight cluster-scoped recent activity,
- rolling summaries used to keep long agent conversations compact.

Memory is organized into:

```text
~/.kubepilot-console/
  sessions/
    session-.../
      meta.json
      events.jsonl
      summary.json
  clusters/
    <context-id>.json
```

The app injects the current session summary and recent cluster memory into the agent prompt. It does not send unrelated historical sessions wholesale.

## Safety Model

KubePilot Console is a local operator tool, not an autonomous production controller.

- The agent can discuss plans in chat without running a command.
- The terminal only displays concrete Kubernetes-related commands and their output.
- Read-only commands can run directly.
- Mutating commands require approval.
- Deployment flows should show the selected or generated YAML before apply.
- Incomplete commands such as `kubectl apply -f` are blocked.
- Commands are serialized through a queue so dependent operations run in order.
- Local memory is written to disk; avoid storing sensitive cluster output if your kubeconfig points at confidential environments.

You are still responsible for the kubeconfig, selected context, credentials, and final approval of cluster changes.

## Project Layout

```text
electron/          Electron launcher
server/            Local backend, agent loop, command queue, Kubernetes command handling
src/               React UI and terminal surface
scripts/           Local helper scripts
```

## Current Status

This is an early prototype focused on the Kubernetes command loop and local desktop workflow. The current implementation has been exercised against minikube and local kubeconfig contexts. Packaging, broader cluster policy, richer YAML review, and automated tests are still active work.

## Roadmap

- Stronger command policy and command classification.
- Better deployment preview and diff views.
- More complete resource-aware Kubernetes diagnostics.
- Packaged macOS builds.
- Integration tests for the agent command loop.
- Session export for command audit trails.
