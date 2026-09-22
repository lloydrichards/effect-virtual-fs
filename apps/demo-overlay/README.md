# Overlay agent workspace demo

Effect VFS gives this demo a Linux-like project tree with paths, files, separate callers, change watches, and
snapshots, all without touching the host project. Language-model agents receive filesystem tools bound to that
virtual tree. The demo shows two overlay arrangements:

- a planner writes to a private overlay without changing the base project;
- an author and reviewer use separate callers on one shared overlay, so the reviewer can read the author's file.

The demo then captures the shared tree, changes the live copy, and restores the captured files. The same base
snapshot can therefore support isolated work, shared work, and a stable handoff.

## Run the live demo

Create `apps/demo-overlay/.env`:

```dotenv
OPENAI_API_KEY=your-key
# Optional; defaults to the cost-conscious gpt-5-mini model.
OPENAI_MODEL=gpt-5-mini
```

Then run:

```sh
cd apps/demo-overlay
bun demo
```

The script loads the app-local `.env`. File contents read by an agent are sent to the configured OpenAI model. The
application reads the key through redacted Effect configuration and does not print it.

## What to look for

Read the demo in this order:

- [`src/demo.ts`](src/demo.ts) creates a fixture and snapshots it. A planner works in a private overlay. An author and reviewer then work through separate callers on a shared overlay. Finally, the demo captures that overlay, edits the live copy, and reads the captured files back.
- [`src/agent.ts`](src/agent.ts) gives each agent caller-bound `list`, `read`, and `write` tools and limits the model loop to eight turns.
- [`src/presentation.ts`](src/presentation.ts) formats the terminal output without changing the workspace.

Actor-labelled `read` and `write` lines show which caller used the virtual filesystem. `VFS` lines are native watch events and
contain only an operation and path—not an actor, content, intent, or history. The final `CHANGE` lines compare the
shared workspace with its immutable base. `RESTORED` lines are read from the captured snapshot after the live
workspace has changed again.

The entire virtual volume is the assigned project, so symlinks cannot reach sibling virtual data. Tool inputs must
be relative and cannot contain `..`. This demonstrates capability-based tool selection; it is not a claim that the
surrounding Bun process is a complete security sandbox. The harness limits an agent to eight model turns, but does
not claim a general tool-call, token, or resource budget.

## Deterministic checks

The test suite replaces the live model with a scripted `LanguageModel` while exercising the same tools and real
overlays:

```sh
bun test
```

Portable compact deltas remain separate work and are not needed for this in-process collaboration flow.
