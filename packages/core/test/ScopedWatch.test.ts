import { assert, describe, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { Testing, VirtualFileSystem as Vfs } from "../src/index.js"
import { pathText } from "./support/text.js"

const rendered = (events: Iterable<Vfs.Change>) =>
  Effect.forEach(events, (event) => Effect.map(pathText(event.path), (path) => `${event._tag} ${path}`))

// A scoped watch on `path`, registered before it returns.
const watchAt = Effect.fnUntraced(function*(path: string, options?: { readonly recursive?: boolean }) {
  const volume = yield* Vfs.Volume
  const caller = yield* Vfs.Caller

  return yield* volume.watch({ ...options, scope: yield* caller.lookup(path) })
})

const file = (caller: Vfs.Caller, path: string) =>
  caller.writeFile(path, new Uint8Array([1]), { access: "write", create: "ifMissing" })

describe("scoped watch", () => {
  it.effect("reports only the scope's subtree", () =>
    Effect.gen(function*() {
      const caller = yield* Vfs.Caller
      yield* caller.mkdir("/a")
      yield* caller.mkdir("/b")
      const changes = yield* Testing.collectChanges(yield* watchAt("/a"), 3)

      yield* caller.mkdir("/b/outside")
      yield* caller.mkdir("/a/inside")
      yield* caller.mkdir("/a/inside/deep")
      yield* caller.chmod("/a", 0o700)

      assert.deepStrictEqual(yield* rendered(yield* changes), [
        "Create /a/inside",
        "Create /a/inside/deep",
        "Update /a"
      ])
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("reports only the scope and its direct children when not recursive", () =>
    Effect.gen(function*() {
      const caller = yield* Vfs.Caller
      yield* caller.mkdir("/a")
      const changes = yield* Testing.collectChanges(yield* watchAt("/a", { recursive: false }), 3)

      yield* caller.mkdir("/a/child")
      yield* caller.mkdir("/a/child/grandchild")
      yield* caller.chmod("/a/child/grandchild", 0o700)
      yield* caller.chmod("/a", 0o700)
      yield* caller.chmod("/a/child", 0o700)

      assert.deepStrictEqual(yield* rendered(yield* changes), ["Create /a/child", "Update /a", "Update /a/child"])
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("reports only the root's direct children for an unscoped watch that is not recursive", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.Volume
      const caller = yield* Vfs.Caller
      const changes = yield* Testing.collectChanges(yield* volume.watch({ recursive: false }), 2)

      yield* caller.mkdir("/a")
      yield* caller.mkdir("/a/nested")
      yield* caller.mkdir("/b")

      assert.deepStrictEqual(yield* rendered(yield* changes), ["Create /a", "Create /b"])
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("keeps reporting at the new paths after an ancestor of the scope is renamed", () =>
    Effect.gen(function*() {
      const caller = yield* Vfs.Caller
      yield* caller.mkdir("/project")
      yield* caller.mkdir("/project/work")
      const changes = yield* Testing.collectChanges(yield* watchAt("/project/work"), 1)

      yield* caller.rename("/project", "/renamed")
      yield* caller.mkdir("/renamed/work/out")

      assert.deepStrictEqual(yield* rendered(yield* changes), ["Create /renamed/work/out"])
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("reports a rename of the scope itself and keeps watching it", () =>
    Effect.gen(function*() {
      const caller = yield* Vfs.Caller
      yield* caller.mkdir("/work")
      const changes = yield* Testing.collectChanges(yield* watchAt("/work"), 3)

      yield* caller.rename("/work", "/moved")
      yield* caller.mkdir("/moved/out")

      assert.deepStrictEqual(yield* rendered(yield* changes), ["Remove /work", "Create /moved", "Create /moved/out"])
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("reports a move out of the scope as Remove and a move into it as Create", () =>
    Effect.gen(function*() {
      const caller = yield* Vfs.Caller
      yield* caller.mkdir("/in")
      yield* caller.mkdir("/out")
      yield* caller.mkdir("/in/leaving")
      yield* file(caller, "/out/arriving")
      const changes = yield* Testing.collectChanges(yield* watchAt("/in"), 3)

      yield* caller.rename("/in/leaving", "/out/left")
      yield* caller.rename("/out/arriving", "/in/arrived")
      // The moved-out directory is no longer in the scope, so its changes are not reported.
      yield* caller.mkdir("/out/left/later")
      yield* caller.mkdir("/in/sentinel")

      assert.deepStrictEqual(yield* rendered(yield* changes), [
        "Remove /in/leaving",
        "Create /in/arrived",
        "Create /in/sentinel"
      ])
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("reports Remove for the scope and ends when the scope directory is removed", () =>
    Effect.gen(function*() {
      const caller = yield* Vfs.Caller
      yield* caller.mkdir("/work")
      const stream = yield* watchAt("/work")

      yield* caller.mkdir("/work/child")
      yield* caller.rmdir("/work/child")
      yield* caller.rmdir("/work")
      yield* caller.mkdir("/work")

      assert.deepStrictEqual(yield* rendered(yield* Stream.runCollect(stream)), [
        "Create /work/child",
        "Remove /work/child",
        "Remove /work"
      ])
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("reports Remove for the scope and ends when a rename replaces it", () =>
    Effect.gen(function*() {
      const caller = yield* Vfs.Caller
      yield* file(caller, "/target")
      yield* file(caller, "/replacement")
      const stream = yield* watchAt("/target")

      yield* caller.chmod("/target", 0o600)
      yield* caller.rename("/replacement", "/target")

      assert.deepStrictEqual(yield* rendered(yield* Stream.runCollect(stream)), ["Update /target", "Remove /target"])
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("keeps watching a file until its last name is removed", () =>
    Effect.gen(function*() {
      const caller = yield* Vfs.Caller
      yield* file(caller, "/f")
      yield* caller.link("/f", "/alias")
      const stream = yield* watchAt("/f")

      yield* caller.unlink("/alias")
      yield* caller.chmod("/f", 0o600)
      yield* caller.unlink("/f")

      assert.deepStrictEqual(yield* rendered(yield* Stream.runCollect(stream)), [
        "Remove /alias",
        "Update /f",
        "Remove /f"
      ])
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("rejects a scope that is not a live reference of the volume", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.Volume
      const caller = yield* Vfs.Caller
      yield* caller.mkdir("/gone")
      const gone = yield* caller.lookup("/gone")
      yield* caller.rmdir("/gone")
      const other = yield* Vfs.make()
      const foreign = yield* (yield* other.caller()).root

      assert.strictEqual((yield* Effect.flip(volume.watch({ scope: gone }))).code, "StaleReference")
      assert.strictEqual((yield* Effect.flip(volume.watch({ scope: foreign }))).code, "ForeignReference")

      // SAFETY: a forged reference stands in for a scope from an untyped caller, which the decoder must reject.
      const forged = Object.freeze({}) as Vfs.ObjectReference
      const invalid = yield* Effect.flip(volume.watch({ scope: forged }))
      assert.strictEqual(invalid.code, "InvalidArgument")
      assert.strictEqual(invalid.field, "scope")
    }).pipe(Effect.provide(Testing.layer())))
})
