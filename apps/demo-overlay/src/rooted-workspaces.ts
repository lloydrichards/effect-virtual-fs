import { Testing, VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { Effect } from "effect"

const encode = (text: string) => new TextEncoder().encode(text)

/** Demonstrate caller views on one overlay without another model request. */
export const rootedWorkspaces = Effect.fn("Demo.rootedWorkspaces")(function*() {
  const template = yield* Vfs.fromFixture({
    entries: [
      { kind: "directory", path: "/projects" },
      { kind: "directory", path: "/projects/release" },
      { kind: "directory", path: "/projects/docs" }
    ]
  })

  const overlay = yield* template.snapshot.pipe(Effect.flatMap(Vfs.makeOverlay()))
  const owner = yield* overlay.caller()
  const release = yield* owner.withRoot("/projects/release")
  const docs = yield* owner.withRoot("/projects/docs")
  const collectEvents = yield* release.watch("/").pipe(Effect.flatMap(Testing.collectChanges(1)))

  yield* docs.writeFile("/note.md", encode("Sibling documentation."), { access: "write", create: "exclusive" })
  yield* release.writeFile("/plan.md", encode("Release on Friday."), { access: "write", create: "exclusive" })
  const events = yield* collectEvents

  yield* owner.rename("/projects/release", "/projects/renamed-release")
  const content = new TextDecoder().decode(yield* release.readFile("/plan.md"))
  const sibling = yield* release.readFile("/note.md").pipe(Effect.result)

  return { events, content, sibling }
})
