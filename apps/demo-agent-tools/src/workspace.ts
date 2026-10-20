import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { Effect } from "effect"

const encode = (text: string) => new TextEncoder().encode(text)

export const projectRoot = "/projects/release"

export const makeBaseSnapshot = Effect.fn("Workspace.base")(function*() {
  const template = yield* Vfs.fromFixture({
    entries: [
      { kind: "directory", path: "/projects" },
      { kind: "directory", path: "/projects/release" },
      { kind: "file", path: "/orchestrator.txt", bytes: encode("Volume-level orchestration data.") },
      {
        kind: "file",
        path: "/projects/release/BRIEF.md",
        bytes: encode("Prepare a Friday release plan. Tests must pass before release. Keep a rollback step.")
      },
      { kind: "directory", path: "/projects/release/plans" },
      {
        kind: "file",
        path: "/projects/release/plans/draft.md",
        bytes: encode("# Release plan\n\nRelease on Friday.\n")
      },
      {
        kind: "file",
        path: "/projects/release/temporary.txt",
        bytes: encode("Remove this scratch file after preparing the plan.")
      }
    ]
  })

  return yield* template.snapshot
})

export const makeWorkspace = Effect.fn("Workspace.make")(function*() {
  const base = yield* makeBaseSnapshot()
  const overlay = yield* Vfs.makeOverlay(base)
  const original = yield* Vfs.fromSnapshot(base)

  const owner = yield* overlay.caller()
  const originalOwner = yield* original.caller()

  return {
    caller: yield* owner.withRoot(projectRoot),
    baseCaller: yield* originalOwner.withRoot(projectRoot),
    owner
  }
})
