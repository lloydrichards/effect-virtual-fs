import * as VfsError from "@effect-vfs/core/VfsError"
import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { type Command, initialPlayground, makeWorkspaceController } from "../app/lib/playground/controller"
import { PlaygroundError } from "../app/lib/playground/error"
import { openVolume } from "../app/lib/playground/volume"

const fixture = (options: Partial<Parameters<typeof makeWorkspaceController>[0]> = {}) => {
  let state = initialPlayground
  let image = new Uint8Array()

  const controller = makeWorkspaceController({
    openVolume,
    buildWorkspace: () => Effect.fail(new PlaygroundError({ message: "Build failed" })),
    runBundle: () => Effect.succeed({ lines: [] }),
    saveCheckpoint: (bytes) =>
      Effect.sync(() => {
        image = new Uint8Array(bytes)
      }),
    readCheckpoint: Effect.sync(() => ({ image, savedAt: "", size: image.length })),
    deleteCheckpoint: Effect.void,
    ...options
  })

  return {
    execute: (command: Command) =>
      controller.execute(command, () => state, (next) => {
        state = next
      }),
    state: () => state,
    edit: (source: string) => {
      state = controller.edit(state, source)
    }
  }
}

test("flushes editor changes before switching caller and renaming files", () =>
  Effect.runPromise(Effect.gen(function*() {
    const workspace = fixture()
    expect(yield* workspace.execute("open")).toBe(true)
    workspace.edit("export const value = 21")
    expect(yield* workspace.execute({ role: "reader" })).toBe(true)
    expect(workspace.state()).toMatchObject({
      role: "reader",
      permissions: 4,
      source: "export const value = 21",
      dirty: false
    })

    yield* workspace.execute({ role: "editor" })
    workspace.edit("export const value = 42")
    expect(yield* workspace.execute({ operation: "Rename file", name: "src/reading.js" })).toBe(true)
    expect(workspace.state()).toMatchObject({
      path: "/src/reading.js",
      source: "export const value = 42",
      dirty: false
    })
    expect(workspace.state().entries.map((entry) => entry.path)).not.toContain("/src/value.js")
  })))

test("deleting the edited file clears its buffer and selects a surviving file", () =>
  Effect.runPromise(Effect.gen(function*() {
    const workspace = fixture()
    yield* workspace.execute("open")
    workspace.edit("pending changes")
    expect(yield* workspace.execute("deleteEntry")).toBe(true)
    expect(workspace.state().entries.map((entry) => entry.path)).not.toContain("/src/value.js")
    expect(workspace.state()).toMatchObject({ path: "/main.js", dirty: false })
    expect(workspace.state().source).toContain("console.log")
  })))

test("a failed build leaves a successfully flushed edit clean and saved in the volume", () =>
  Effect.runPromise(Effect.gen(function*() {
    const workspace = fixture({
      buildWorkspace: Effect.fnUntraced(function*(caller) {
        expect(yield* caller.read("/src/value.js").pipe(Effect.mapError(PlaygroundError.fromCause))).toBe(
          "new source"
        )

        return yield* new PlaygroundError({ message: "Build failed" })
      })
    })

    yield* workspace.execute("open")
    workspace.edit("new source")
    expect(yield* workspace.execute("build")).toBe(false)
    expect(workspace.state()).toMatchObject({ busy: false, dirty: false, source: "new source", error: "Build failed" })
  })))

test("refresh recovers the selection after a recursive deletion partially fails", () =>
  Effect.runPromise(Effect.gen(function*() {
    const workspace = fixture()
    yield* workspace.execute("open")
    yield* workspace.execute({ role: "admin" })
    expect(yield* workspace.execute({ operation: "New folder", name: "src/zlocked" })).toBe(true)
    expect(yield* workspace.execute({ operation: "New file", name: "src/zlocked/a.js" })).toBe(true)
    yield* workspace.execute({ role: "editor" })
    yield* workspace.execute({ select: workspace.state().entries.find((entry) => entry.path === "/src/value.js")! })
    yield* workspace.execute({ select: workspace.state().entries.find((entry) => entry.path === "/src")! })

    expect(yield* workspace.execute("deleteEntry")).toBe(false)
    expect(workspace.state().error).toContain("AccessDenied")
    expect(workspace.state().pendingView).toBeDefined()
    expect(yield* workspace.execute("refresh")).toBe(true)
    expect(workspace.state()).toMatchObject({ path: "/main.js", folder: "", pendingView: undefined })

    const paths = workspace.state().entries.map((entry) => entry.path)
    expect(paths).not.toContain("/src/value.js")
    expect(paths).toContain("/src/zlocked/a.js")
  })))

test("reopening a checkpoint replaces later editor text and namespace changes", () =>
  Effect.runPromise(Effect.gen(function*() {
    const workspace = fixture()
    yield* workspace.execute("open")
    workspace.edit("export const value = 32")
    yield* workspace.execute("save")
    yield* workspace.execute({ operation: "New file", name: "uncommitted.js" })
    workspace.edit("unsaved text")
    expect(yield* workspace.execute("reopen")).toBe(true)
    expect(workspace.state().entries.map((entry) => entry.path)).not.toContain("/uncommitted.js")
    yield* workspace.execute({ select: workspace.state().entries.find((entry) => entry.path === "/src/value.js")! })
    expect(workspace.state()).toMatchObject({ source: "export const value = 32", dirty: false })
  })))

test("a command can refresh after an applied rename without running the rename again", () =>
  Effect.runPromise(Effect.gen(function*() {
    let renames = 0
    let failRefresh = false

    const workspace = fixture({
      openVolume: (image) =>
        openVolume(image).pipe(Effect.map((volume) => ({
          ...volume,
          editor: {
            ...volume.editor,
            rename: (from, to) =>
              volume.editor.rename(from, to).pipe(Effect.tap(() =>
                Effect.sync(() => {
                  renames++
                  failRefresh = true
                })
              )),
            files: () =>
              Effect.suspend(() =>
                failRefresh
                  ? Effect.fail(VfsError.make({ code: "AccessDenied", operation: "walk" }))
                  : volume.editor.files()
              )
          }
        })))
    })

    yield* workspace.execute("open")
    workspace.edit("updated source")
    const rename = { operation: "Rename file", name: "src/reading.js" } as const
    expect(yield* workspace.execute(rename)).toBe(false)
    expect(workspace.state()).toMatchObject({
      dirty: false,
      busy: false,
      error: expect.stringContaining("AccessDenied")
    })
    expect(workspace.state().pendingView).toBeDefined()
    expect(yield* workspace.execute(rename)).toBe(false)

    failRefresh = false
    expect(yield* workspace.execute("refresh")).toBe(true)
    expect(renames).toBe(1)
    expect(workspace.state()).toMatchObject({
      path: "/src/reading.js",
      source: "updated source",
      dirty: false,
      error: "",
      pendingView: undefined
    })
    expect(workspace.state().entries.map((entry) => entry.path)).not.toContain("/src/value.js")
  })))

test("rejects a second command while a build is pending and clears busy state on interruption", () =>
  Effect.runPromise(Effect.gen(function*() {
    const started = yield* Deferred.make<void>()

    const workspace = fixture({
      buildWorkspace: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
    })

    yield* workspace.execute("open")
    const build = yield* Effect.forkChild(workspace.execute("build"))
    yield* Deferred.await(started)
    expect(yield* workspace.execute({ role: "reader" })).toBe(false)
    yield* Fiber.interrupt(build)
    expect(workspace.state()).toMatchObject({ busy: false, role: "editor" })
  })))
