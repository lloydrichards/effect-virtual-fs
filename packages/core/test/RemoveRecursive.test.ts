import { assert, describe, it } from "@effect/vitest"
import { Effect, Result } from "effect"
import { Testing, VirtualFileSystem as Vfs } from "../src/index.js"
import { withVolumeTestSeams } from "../src/internal/testSeams.js"
import { exists, failure, GUEST, RECURSIVE, write } from "./support/caller.js"
import { pathText } from "./support/text.js"

const present = (fs: Vfs.Caller, paths: ReadonlyArray<string>) => Effect.forEach(paths, (path) => exists(fs, path))

// A guest-owned /work the guest can write, and a guest caller.
const guestWork = Effect.gen(function*() {
  const fs = yield* Vfs.Caller
  yield* fs.mkdir("/work")
  yield* fs.chown("/work", { uid: GUEST.uid, gid: GUEST.gid })

  return yield* Testing.callerAs(GUEST)
})

describe("remove recursive", () => {
  it.effect("removes entries before their directories, one change each", () =>
    Effect.gen(function*() {
      const fs = yield* Vfs.Caller
      const volume = yield* Vfs.Volume
      yield* fs.mkdir("/t")
      yield* fs.mkdir("/t/a")
      yield* write(fs, "/t/a/x")
      yield* write(fs, "/t/b")
      const changes = yield* Testing.collectChanges(yield* volume.watch(), 4)

      const change = yield* fs.remove("/t", RECURSIVE)
      const events = yield* changes

      assert.deepStrictEqual(
        yield* Effect.forEach(events, (event) => Effect.map(pathText(event.path), (path) => `${event._tag} ${path}`)),
        ["Remove /t/a/x", "Remove /t/a", "Remove /t/b", "Remove /t"]
      )
      assert.strictEqual(change.after, (yield* fs.stat("/")).revision)
    }).pipe(Effect.scoped, Effect.provide(Testing.layer())))

  it.effect("removes a file or a link itself, never what a link names", () =>
    Effect.gen(function*() {
      const fs = yield* Vfs.Caller
      yield* fs.mkdir("/dir")
      yield* write(fs, "/dir/kept")
      yield* fs.symlink("/dir", "/link")
      yield* write(fs, "/file")

      yield* fs.remove("/link", RECURSIVE)
      yield* fs.remove("/file", RECURSIVE)

      assert.deepStrictEqual(yield* present(fs, ["/link", "/file", "/dir/kept"]), [false, false, true])
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("stops at the first failure, naming the entry, and leaves what it did not reach", () =>
    Effect.gen(function*() {
      const guest = yield* guestWork
      yield* guest.mkdir("/work/t/locked", RECURSIVE)
      yield* write(guest, "/work/t/a")
      yield* write(guest, "/work/t/locked/f")
      yield* write(guest, "/work/t/z")
      // Readable, so the walk lists it, but not writable, so its entry cannot go.
      yield* guest.chmod("/work/t/locked", 0o555)

      const error = yield* Effect.flip(guest.remove("/work/t", RECURSIVE))

      assert.deepStrictEqual(yield* failure(error), ["AccessDenied", "/work/t/locked/f"])
      assert.deepStrictEqual(
        yield* present(guest, ["/work/t/a", "/work/t/locked/f", "/work/t/z"]),
        [false, true, true]
      )
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("refuses a directory with entries it may not read, and changes no permission", () =>
    Effect.gen(function*() {
      const guest = yield* guestWork
      yield* guest.mkdir("/work/t/sealed", RECURSIVE)
      yield* write(guest, "/work/t/sealed/f")
      yield* guest.chmod("/work/t/sealed", 0o000)

      const error = yield* Effect.flip(guest.remove("/work/t", RECURSIVE))

      assert.deepStrictEqual(yield* failure(error), ["AccessDenied", "/work/t/sealed"])
      assert.strictEqual((yield* guest.stat("/work/t/sealed")).mode & 0o777, 0o000)
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("removes an empty directory it may not read", () =>
    Effect.gen(function*() {
      const guest = yield* guestWork
      yield* guest.mkdir("/work/t/sealed", RECURSIVE)
      yield* write(guest, "/work/t/f")
      yield* guest.chmod("/work/t/sealed", 0o000)

      yield* guest.remove("/work/t", RECURSIVE)

      assert.isFalse(yield* exists(guest, "/work/t"))
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("forgives a missing target with force, and an entry going missing below it never", () =>
    Effect.gen(function*() {
      const fs = yield* Vfs.Caller

      assert.isUndefined(yield* fs.remove("/missing", { force: true }))
      assert.isUndefined(yield* fs.remove("/missing/deeper", { recursive: true, force: true }))

      yield* fs.mkdir("/t")
      yield* fs.mkdir("/t/a")
      yield* write(fs, "/t/a/x")
      yield* write(fs, "/t/b")
      let removals = 0

      // Another caller removes /t/b once the walk has listed /t and before the removal reaches it.
      const beforeTreeRemoval = Effect.suspend(() => ++removals === 1 ? Effect.orDie(fs.unlink("/t/b")) : Effect.void)

      const error = yield* Effect.flip(
        fs.remove("/t", { recursive: true, force: true }).pipe(withVolumeTestSeams({ beforeTreeRemoval }))
      )

      assert.deepStrictEqual(yield* failure(error), ["NotFound", "/t/b"])
      assert.deepStrictEqual(yield* present(fs, ["/t", "/t/a"]), [true, false])
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("leaves a directory renamed out of the target before the removal reaches it", () =>
    Effect.gen(function*() {
      const fs = yield* Vfs.Caller
      yield* fs.mkdir("/keep")
      yield* fs.mkdir("/work/a/g", RECURSIVE)
      yield* write(fs, "/work/a/f")
      yield* write(fs, "/work/a/g/y")
      yield* fs.mkdir("/work/z")
      yield* write(fs, "/work/z/k")
      let removals = 0

      // Another caller moves /work/z out once the walk has listed /work and before the removal reaches /work/z.
      const beforeTreeRemoval = Effect.suspend(() =>
        ++removals === 1 ? Effect.orDie(fs.rename("/work/z", "/keep/z")) : Effect.void
      )

      const error = yield* Effect.flip(fs.remove("/work", RECURSIVE).pipe(withVolumeTestSeams({ beforeTreeRemoval })))

      // The walk reaches /work/z by its name, which no longer names it, so nothing below it is removed.
      assert.deepStrictEqual(yield* failure(error), ["NotFound", "/work/z"])
      assert.deepStrictEqual(yield* present(fs, ["/work/a", "/keep/z/k"]), [false, true])
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("leaves the target renamed away before the first removal, forgiven only with force", () =>
    Effect.gen(function*() {
      const fs = yield* Vfs.Caller

      for (const force of [false, true]) {
        yield* fs.mkdir("/work/a", RECURSIVE)
        yield* write(fs, "/work/a/f")
        yield* write(fs, "/work/b")
        let removals = 0

        // Another caller moves /work itself once the walk has listed it and before the first removal.
        const beforeTreeRemoval = Effect.suspend(() =>
          ++removals === 1 ? Effect.orDie(fs.rename("/work", "/keep")) : Effect.void
        )

        const removed = yield* Effect.result(
          fs.remove("/work", { recursive: true, force }).pipe(withVolumeTestSeams({ beforeTreeRemoval }))
        )

        const outcome = Result.isSuccess(removed) ? "removed" : yield* failure(removed.failure)

        // The walk reaches every entry through the target's name, which no longer names it, so nothing moves.
        assert.deepStrictEqual(outcome, force ? "removed" : ["NotFound", "/work"])
        assert.deepStrictEqual(yield* present(fs, ["/keep/a/f", "/keep/b"]), [true, true])
        yield* fs.remove("/keep", RECURSIVE)
      }
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("leaves a replacement created under a listed name, failing at that name", () =>
    Effect.gen(function*() {
      const fs = yield* Vfs.Caller
      yield* fs.mkdir("/keep")
      yield* fs.mkdir("/work")
      yield* write(fs, "/work/f")
      let removals = 0

      // Another caller moves /work/f out and creates a new /work/f before the removal reaches it.
      const beforeTreeRemoval = Effect.suspend(() =>
        ++removals === 1
          ? Effect.orDie(Effect.andThen(fs.rename("/work/f", "/keep/f"), write(fs, "/work/f")))
          : Effect.void
      )

      const error = yield* Effect.flip(fs.remove("/work", RECURSIVE).pipe(withVolumeTestSeams({ beforeTreeRemoval })))

      assert.deepStrictEqual(yield* failure(error), ["NotFound", "/work/f"])
      assert.deepStrictEqual(yield* present(fs, ["/work/f", "/keep/f"]), [true, true])
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("names an entry's failure under the entry when the target is an entry", () =>
    Effect.gen(function*() {
      const guest = yield* guestWork
      yield* guest.mkdir("/work/t/locked", RECURSIVE)
      yield* write(guest, "/work/t/locked/f")
      yield* guest.chmod("/work/t/locked", 0o555)

      const error = yield* Effect.flip(guest.remove(Vfs.Entry(yield* guest.lookup("/work"), "t"), RECURSIVE))

      assert.deepStrictEqual(yield* failure(error), ["AccessDenied", "t/locked/f"])
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("rejects malformed options before resolving the target", () =>
    Effect.gen(function*() {
      const fs = yield* Vfs.Caller
      // SAFETY: the malformed option is the input under test; remove validates it at runtime.
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- Runtime validation requires an invalid typed input.
      const options = { recursive: "yes" } as unknown as Vfs.RemoveOptions

      assert.deepStrictEqual(
        yield* failure(yield* Effect.flip(fs.remove("/missing", options))),
        ["InvalidArgument", "/missing"]
      )
    }).pipe(Effect.provide(Testing.layer())))
})
