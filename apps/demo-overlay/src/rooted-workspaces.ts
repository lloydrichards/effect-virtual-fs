import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { Effect, Stream } from "effect"

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

  const overlay = yield* Vfs.makeOverlay(yield* template.snapshot)
  const owner = yield* overlay.caller()
  const release = yield* owner.withRoot("/projects/release")
  const docs = yield* owner.withRoot("/projects/docs")
  const watch = yield* release.watch("/")

  yield* docs.writeFile("/note.md", encode("Sibling documentation."), { access: "write", create: "exclusive" })
  yield* release.writeFile("/plan.md", encode("Release on Friday."), { access: "write", create: "exclusive" })
  const events = yield* watch.pipe(Stream.take(1), Stream.runCollect)

  yield* owner.rename("/projects/release", "/projects/renamed-release")
  const content = new TextDecoder().decode(yield* release.readFile("/plan.md"))
  const sibling = yield* release.readFile("/note.md").pipe(Effect.result)

  return { events, content, sibling }
})
