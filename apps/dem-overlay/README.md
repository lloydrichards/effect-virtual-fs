# Overlay agent workspace demo

This example lets real language-model agents work with a virtual project without giving them a host-filesystem or
shell tool. It demonstrates two overlay arrangements:

- a planner works in a disposable private overlay whose changes never reach the template;
- an author and reviewer use separate callers on one shared overlay and communicate through project files.

## Run the live demo

Create `apps/overlay-demo/.env`:

```dotenv
OPENAI_API_KEY=your-key
# Optional; defaults to the cost-conscious gpt-5-mini model.
OPENAI_MODEL=gpt-5-mini
```

Then run:

```sh
cd apps/overlay-demo
bun demo
```

The script loads the app-local `.env`. File contents read by an agent are sent to the configured OpenAI model. The
application reads the key through redacted Effect configuration and does not print it.

## What to look for

The guided workflow is split into three readable parts:

- [`src/agent.ts`](src/agent.ts) defines the caller-bound filesystem tools and bounded `LanguageModel` loop;
- [`src/demo.ts`](src/demo.ts) creates the base, private overlay, shared overlay, watch, and capture;
- [`src/presentation.ts`](src/presentation.ts) formats the terminal story.

Actor-labelled `read` and `write` lines are emitted by the agent harness. `VFS` lines are native watch events and
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
