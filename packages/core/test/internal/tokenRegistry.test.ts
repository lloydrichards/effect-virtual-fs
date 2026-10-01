import { assert, describe, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { DirectoryHandleId, FileHandleId } from "../../src/FileHandle.js"
import { OpContext } from "../../src/internal/errors.js"
import * as Tokens from "../../src/internal/tokenRegistry.js"
import { ROOT_INO } from "../../src/internal/volumeState.js"
import type { DirectoryHandle, FileHandle } from "../../src/VirtualFileSystem.js"
import { directory, file, volumeState } from "../support/volumeState.js"

const op = OpContext.make("stat")

// SAFETY: registry tests use opaque identities only and never invoke handle operations.
const fileToken = (): FileHandle => Object.freeze({ [FileHandleId]: true }) as FileHandle

// SAFETY: registry tests use opaque identities only and never invoke handle operations.
const directoryToken = (): DirectoryHandle => Object.freeze({ [DirectoryHandleId]: true }) as DirectoryHandle

const immediate = (action: () => void) => Effect.sync(action)

const setup = () => {
  const state = volumeState()
  const registry = Tokens.make(Symbol(), state.get)

  return { state, registry }
}

describe("token resolution", () => {
  it.effect("should intern references and distinguish forged tokens from another volume's tokens", () =>
    Effect.gen(function*() {
      const { registry } = setup()
      const foreign = setup().registry
      const root = registry.referenceFor(ROOT_INO)
      assert.strictEqual(registry.referenceFor(ROOT_INO), root)
      assert.strictEqual((yield* registry.resolve(root, "reference")).kind, "live")
      assert.strictEqual((yield* foreign.resolve(root, "reference")).kind, "foreign")

      for (const forged of [undefined, null, 1, "token", {}, { ...root }]) {
        assert.strictEqual(
          (yield* registry.resolve(
            // SAFETY: malformed values exercise calls from outside TypeScript at the token boundary.
            forged as Tokens.Token,
            "reference"
          )).kind,
          "unknown"
        )
      }
    }))

  it.effect("should stale a removed directory while its retained directory handle remains live", () =>
    Effect.gen(function*() {
      const { state, registry } = setup()
      const node = directory(2)
      state.put(node)
      const token = registry.referenceFor(node.ino)
      const handle = directoryToken()
      registry.registerDirectory(handle, registry.directory(node.ino))
      state.put({ ...node, metadata: { ...node.metadata, nlink: 0 } })
      assert.strictEqual((yield* registry.resolve(token, "reference")).kind, "stale")
      assert.strictEqual((yield* registry.resolve(handle, "handle")).kind, "live")
      state.remove(node.ino)
      assert.strictEqual((yield* registry.resolve(handle, "handle")).kind, "stale")
    }))

  it.effect("should keep an unlinked file reference live until its final retained handle releases it", () =>
    Effect.gen(function*() {
      const { state, registry } = setup()
      const node = file(2, 0)
      state.put(node)
      yield* state.retain(node.ino)
      const token = registry.referenceFor(node.ino)
      assert.strictEqual((yield* registry.resolve(token, "reference")).kind, "live")
      yield* state.release(node.ino)
      assert.strictEqual((yield* registry.resolve(token, "reference")).kind, "stale")
      assert.strictEqual((yield* registry.resolveInode(node.ino)).kind, "stale")
      assert.strictEqual((yield* setup().registry.resolve(token, "reference")).kind, "foreign")
    }))

  it.effect("should forget interning without making a reclaimed inode live", () =>
    Effect.gen(function*() {
      const { state, registry } = setup()
      const node = file(2)
      state.put(node)
      const token = registry.referenceFor(node.ino)
      state.remove(node.ino)
      registry.forget(node.ino)
      assert.strictEqual((yield* registry.resolve(token, "reference")).kind, "stale")
      assert.notStrictEqual(registry.referenceFor(node.ino), token)
    }))

  it.effect("should resolve both handle kinds while rejecting a file handle as a directory base", () =>
    Effect.gen(function*() {
      const { state, registry } = setup()
      const node = file(2)
      state.put(node)
      const ref = registry.file("read", false)
      const handle = fileToken()
      registry.registerFile(handle, ref)
      assert.strictEqual((yield* registry.resolve(handle, "handle")).kind, "stale")
      Tokens.publish(ref, node.ino)
      assert.strictEqual((yield* registry.resolve(handle, "handle")).kind, "live")
      assert.strictEqual((yield* registry.resolve(handle, "directory")).kind, "unknown")
      assert.strictEqual((yield* setup().registry.resolve(handle, "handle")).kind, "foreign")
      Tokens.released(ref)
      assert.strictEqual((yield* registry.resolve(handle, "handle")).kind, "stale")
      assert.strictEqual((yield* setup().registry.resolve(handle, "handle")).kind, "foreign")
    }))

  it.effect("should render each refusal by addressing form", () =>
    Effect.gen(function*() {
      for (const kind of ["unknown", "foreign", "stale"] as const) {
        const reference = yield* Effect.flip(Tokens.nodeOrFail({ kind }, "reference", op))
        const handle = yield* Effect.flip(Tokens.nodeOrFail({ kind }, "handle", op))
        assert.strictEqual(
          reference.code,
          kind === "unknown" ? "InvalidReference" : kind === "foreign" ? "ForeignReference" : "StaleReference"
        )
        assert.strictEqual(handle.code, kind === "foreign" ? "ForeignHandle" : "InvalidHandle")
        assert.strictEqual(reference.operation, "stat")
        assert.isUndefined(reference.path)
      }
    }))
})

describe("handle lifecycle", () => {
  it.effect("should keep a handle usable until its staged release publishes", () =>
    Effect.gen(function*() {
      const { state, registry } = setup()
      const node = file(2)
      state.put(node)
      yield* state.retain(node.ino)
      const ref = registry.file("read", false)
      Tokens.publish(ref, node.ino)
      const handle = fileToken()
      registry.registerFile(handle, ref)
      const actions: Array<() => void> = []
      yield* Tokens.release(ref, state.release, (action) =>
        Effect.sync(() => {
          actions.push(action)
        }))
      assert.strictEqual((yield* registry.resolve(handle, "handle")).kind, "live")
      actions.forEach((action) => action())
      assert.strictEqual((yield* registry.resolve(handle, "handle")).kind, "stale")
      assert.isFalse(state.state.open.has(node.ino))
    }))

  it.effect("should release an unlinked inode once across explicit release and repeated finalization", () =>
    Effect.gen(function*() {
      const { state, registry } = setup()
      const node = file(2, 0)
      state.put(node)
      yield* state.retain(node.ino)
      const ref = registry.file("write", false)
      Tokens.publish(ref, node.ino)
      let releases = 0

      const release = Tokens.release(ref, (ino) =>
        Effect.andThen(
          Effect.sync(() => {
            releases++
          }),
          state.release(ino)
        ), immediate)

      yield* release
      const finalize = Tokens.finalize(ref, release, release)
      yield* finalize
      yield* finalize
      assert.strictEqual(releases, 1)
      assert.strictEqual(ref.lifecycle.kind, "closed")
      assert.strictEqual((yield* registry.resolveInode(node.ino)).kind, "stale")
    }))

  it.effect("should release a publication that arrives after acquisition cleanup already ran", () =>
    Effect.gen(function*() {
      const { state, registry } = setup()
      const node = file(2, 0)
      state.put(node)
      const ref = registry.file("read", false)
      const release = Tokens.release(ref, state.release, immediate)
      const finalize = Tokens.finalize(ref, release, release)
      yield* finalize
      yield* finalize
      assert.strictEqual(ref.lifecycle.kind, "releasedPendingCommit")
      yield* state.retain(node.ino)
      Tokens.publish(ref, node.ino)
      assert.isFalse(Tokens.isOpen(ref))
      yield* finalize
      assert.strictEqual(ref.lifecycle.kind, "closed")
      assert.strictEqual((yield* registry.resolveInode(node.ino)).kind, "stale")
    }))

  it.effect("should fall back to local release when close is refused", () =>
    Effect.gen(function*() {
      const { state, registry } = setup()
      const node = file(2, 0)
      state.put(node)
      yield* state.retain(node.ino)
      const ref = registry.file("read", false)
      Tokens.publish(ref, node.ino)
      yield* Tokens.finalize(ref, Effect.fail(op.fail("VolumeBusy")), Tokens.release(ref, state.release, immediate))
      assert.strictEqual(ref.lifecycle.kind, "closed")
      assert.strictEqual((yield* registry.resolveInode(node.ino)).kind, "stale")
    }))

  it.effect("should close a released directory even when its reclamation callback fails", () =>
    Effect.gen(function*() {
      const { registry } = setup()
      const ref = registry.directory(ROOT_INO)
      const failure = yield* Effect.flip(Tokens.release(ref, () => Effect.fail(op.fail("StorageRejected")), immediate))
      assert.strictEqual(failure.code, "StorageRejected")
      assert.isFalse(Tokens.isOpen(ref))
      assert.isUndefined(Tokens.inode(ref))
    }))

  it.effect("should release a successful acquisition when its owning scope closes", () =>
    Effect.gen(function*() {
      const { state, registry } = setup()
      const node = file(2, 0)
      state.put(node)
      const ref = registry.file("read", false)
      const scope = yield* Scope.make()
      const release = Tokens.release(ref, state.release, immediate)

      const acquisition = Effect.gen(function*() {
        yield* state.retain(node.ino)
        Tokens.publish(ref, node.ino)

        return ref
      })

      yield* Tokens.acquire(
        ref,
        (effect) => effect,
        acquisition,
        () => Effect.void,
        Tokens.finalize(ref, release, release)
      ).pipe(Scope.provide(scope))
      assert.isTrue(Tokens.isOpen(ref))
      yield* Scope.close(scope, Exit.void)
      assert.strictEqual(ref.lifecycle.kind, "closed")
      assert.strictEqual((yield* registry.resolveInode(node.ino)).kind, "stale")
    }))

  it.effect("should interrupt acquisition when its scope closes while coordination waits", () =>
    Effect.gen(function*() {
      const { registry } = setup()
      const ref = registry.file("read", false)
      const scope = yield* Scope.make()
      const waiting = yield* Deferred.make<void>()
      const blocked = yield* Deferred.make<void>()
      const release = Tokens.release(ref, () => Effect.void, immediate)

      const acquisition = Tokens.acquire(
        ref,
        (effect) =>
          Effect.andThen(Deferred.succeed(waiting, undefined), Effect.andThen(Deferred.await(blocked), effect)),
        Effect.sync(() => Tokens.publish(ref, ROOT_INO)),
        () => Effect.void,
        Tokens.finalize(ref, release, release)
      )

      const fiber = yield* acquisition.pipe(Scope.provide(scope), Effect.forkChild)
      yield* Deferred.await(waiting)
      yield* Scope.close(scope, Exit.void)
      yield* Deferred.succeed(blocked, undefined)
      const exit = yield* Fiber.await(fiber)
      assert.isTrue(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause))
      assert.strictEqual(ref.lifecycle.kind, "closed")
    }))
})
