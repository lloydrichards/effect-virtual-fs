import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { Effect } from "effect"

const encode = (text: string) => new TextEncoder().encode(text)

export const makeWorkspace = Effect.fn("Workspace.make")(function*() {
  const template = yield* Vfs.fromFixture({
    entries: [
      {
        kind: "file",
        path: "/BRIEF.md",
        bytes: encode("Prepare a Friday release plan. Tests must pass before release. Keep a rollback step.")
      },
      { kind: "directory", path: "/plans" },
      { kind: "file", path: "/plans/draft.md", bytes: encode("# Release plan\n\nRelease on Friday.\n") },
      { kind: "file", path: "/temporary.txt", bytes: encode("Remove this scratch file after preparing the plan.") }
    ]
  })

  const base = yield* template.snapshot
  const overlay = yield* Vfs.makeOverlay(base)
  const original = yield* Vfs.fromSnapshot(base)

  return { caller: yield* overlay.caller(), baseCaller: yield* original.caller() }
})
