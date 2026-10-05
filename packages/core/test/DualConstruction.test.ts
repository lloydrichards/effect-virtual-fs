import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Effect, pipe, Predicate } from "effect"
import { Target, VirtualFileSystem as Vfs, Volume } from "../src/index.js"

const fixture: Vfs.Fixture = { entries: [{ kind: "file", path: "/file", bytes: Uint8Array.of(7) }] }

const options: Vfs.VolumeOptions = { maxBytes: ByteSize.kibibytes(4) }

describe("dual construction and snapshot deltas", () => {
  it.layer(BunCrypto.layer)((it) => {
    it.effect("should restore fixture contents when constructors receive optional configuration in either call style", () =>
      Effect.gen(function*() {
        const snapshot = yield* (yield* Vfs.fromFixture(fixture)).snapshot

        const builds = [
          Vfs.fromFixture(fixture),
          Vfs.fromFixture(fixture, undefined),
          Vfs.fromFixture(fixture, options),
          Vfs.fromFixture()(fixture),
          Vfs.fromFixture(undefined)(fixture),
          Vfs.fromFixture(options)(fixture),
          Vfs.fromSnapshot(snapshot),
          Vfs.fromSnapshot(snapshot, undefined),
          Vfs.fromSnapshot(snapshot, options),
          Vfs.fromSnapshot()(snapshot),
          Vfs.fromSnapshot(undefined)(snapshot),
          Vfs.fromSnapshot(options)(snapshot),
          Vfs.makeOverlay(snapshot),
          Vfs.makeOverlay(snapshot, undefined),
          Vfs.makeOverlay(snapshot, options),
          Vfs.makeOverlay()(snapshot),
          Vfs.makeOverlay(undefined)(snapshot),
          Vfs.makeOverlay(options)(snapshot)
        ]

        for (const build of builds) {
          const caller = yield* (yield* build).caller()
          assert.deepStrictEqual(yield* caller.readFile("/file"), Uint8Array.of(7))
        }

        const tooSmall = { maxBytes: ByteSize.bytes(0) }
        assert.deepStrictEqual(
          yield* Effect.flip(Vfs.fromFixture(tooSmall)(fixture)),
          yield* Effect.flip(Vfs.fromFixture(fixture, tooSmall))
        )
        assert.deepStrictEqual(
          yield* Effect.flip(Vfs.fromSnapshot(tooSmall)(snapshot)),
          yield* Effect.flip(Vfs.fromSnapshot(snapshot, tooSmall))
        )
      }))

    it.effect("should provide fixture contents when volume layers receive configuration in either call style", () =>
      Effect.gen(function*() {
        const snapshot = yield* (yield* Vfs.fromFixture(fixture)).snapshot

        const layers = [
          Vfs.Volume.layerFromFixture(fixture),
          Vfs.Volume.layerFromFixture(fixture, undefined),
          Vfs.Volume.layerFromFixture(fixture, options),
          Vfs.Volume.layerFromFixture()(fixture),
          Vfs.Volume.layerFromFixture(undefined)(fixture),
          Vfs.Volume.layerFromFixture(options)(fixture),
          Vfs.Volume.layerFromSnapshot(snapshot),
          Vfs.Volume.layerFromSnapshot(snapshot, undefined),
          Vfs.Volume.layerFromSnapshot(snapshot, options),
          Vfs.Volume.layerFromSnapshot()(snapshot),
          Vfs.Volume.layerFromSnapshot(undefined)(snapshot),
          Vfs.Volume.layerFromSnapshot(options)(snapshot),
          Vfs.Volume.layerOverlay(snapshot),
          Vfs.Volume.layerOverlay(snapshot, undefined),
          Vfs.Volume.layerOverlay(snapshot, options),
          Vfs.Volume.layerOverlay()(snapshot),
          Vfs.Volume.layerOverlay(undefined)(snapshot),
          Vfs.Volume.layerOverlay(options)(snapshot)
        ]

        const read = Effect.gen(function*() {
          return yield* (yield* (yield* Vfs.Volume).caller()).readFile("/file")
        })

        for (const layer of layers) {
          assert.deepStrictEqual(yield* read.pipe(Effect.provide(layer)), Uint8Array.of(7))
        }
      }))

    it.effect("should reproduce the target snapshot when diff and apply use either call style", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.fromFixture(fixture)
        const base = yield* volume.snapshot
        yield* (yield* volume.caller()).writeFile("/next", Uint8Array.of(8), { access: "write", create: "exclusive" })
        const target = yield* volume.snapshot
        const expected = yield* Vfs.encodeSnapshot(target)
        const limits = Vfs.SnapshotDeltaLimits.default

        const diffs = [
          Vfs.diffSnapshots(base, target),
          Vfs.diffSnapshots(base, target, undefined),
          Vfs.diffSnapshots(base, target, limits),
          Vfs.diffSnapshots(target)(base),
          Vfs.diffSnapshots(target, undefined)(base),
          Vfs.diffSnapshots(target, limits)(base)
        ]

        for (const diff of diffs) {
          const delta = yield* diff
          const applied = yield* pipe(base, Vfs.applySnapshotDelta(delta))
          assert.deepStrictEqual(yield* Vfs.encodeSnapshot(applied), expected)
        }

        const delta = yield* Vfs.diffSnapshots(base, target)

        const applies = [
          Vfs.applySnapshotDelta(base, delta),
          Vfs.applySnapshotDelta(base, delta, undefined),
          Vfs.applySnapshotDelta(base, delta, limits),
          Vfs.applySnapshotDelta(delta)(base),
          Vfs.applySnapshotDelta(delta, undefined)(base),
          Vfs.applySnapshotDelta(delta, limits)(base)
        ]

        for (const apply of applies) {
          assert.deepStrictEqual(yield* Vfs.encodeSnapshot(yield* apply), expected)
        }

        const expectedChanges = yield* Vfs.inspectSnapshotDelta(base, delta, { includeTimestamps: true }, limits)
        assert.isTrue(expectedChanges.some(Predicate.isTagged("Added")))
        const inspect = Vfs.inspectSnapshotDelta(delta, { includeTimestamps: true }, limits)
        assert.deepStrictEqual(yield* inspect(base), expectedChanges)
        assert.deepStrictEqual(
          yield* Vfs.inspectSnapshotDelta(delta)(base),
          yield* Vfs.inspectSnapshotDelta(base, delta)
        )
        assert.deepStrictEqual(
          yield* Vfs.inspectSnapshotDelta(delta, undefined)(base),
          yield* Vfs.inspectSnapshotDelta(base, delta, undefined)
        )
        assert.deepStrictEqual(
          yield* Vfs.inspectSnapshotDelta(delta, undefined, undefined)(base),
          yield* Vfs.inspectSnapshotDelta(base, delta, undefined, undefined)
        )
        assert.deepStrictEqual(
          yield* Vfs.inspectSnapshotDelta(delta, undefined, limits)(base),
          yield* Vfs.inspectSnapshotDelta(base, delta, undefined, limits)
        )
        const mismatched = yield* Effect.flip(Vfs.applySnapshotDelta(delta)(target))
        assert.deepStrictEqual(mismatched, yield* Effect.flip(Vfs.applySnapshotDelta(target, delta)))
      }))

    it.effect("should merge changes onto the same base when merge options are omitted or supplied in either call style", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.fromFixture(fixture)
        const base = yield* volume.snapshot
        yield* (yield* volume.caller()).writeFile("/next", Uint8Array.of(8), { access: "write", create: "exclusive" })
        const target = yield* volume.snapshot
        const ours = yield* Vfs.diffSnapshots(base, target)
        const theirs = yield* Vfs.diffSnapshots(base, base)
        const options = { limits: Vfs.SnapshotDeltaLimits.default }

        const merges = [
          Vfs.mergeSnapshotDeltas(base, ours, theirs),
          Vfs.mergeSnapshotDeltas(base, ours, theirs, undefined),
          Vfs.mergeSnapshotDeltas(base, ours, theirs, options),
          Vfs.mergeSnapshotDeltas(ours, theirs)(base),
          Vfs.mergeSnapshotDeltas(ours, theirs, undefined)(base),
          Vfs.mergeSnapshotDeltas(ours, theirs, options)(base)
        ]

        const expected = yield* Vfs.encodeSnapshot(target)

        for (const merge of merges) {
          const result = yield* merge
          assert.deepStrictEqual(result.conflicts, [])
          assert.deepStrictEqual(yield* Vfs.encodeSnapshot(yield* Vfs.applySnapshotDelta(base, result.delta)), expected)
        }
      }))
  })

  it("should preserve addressing and durability comparisons when helpers are partially applied", () => {
    const name = Uint8Array.of(255)
    assert.deepStrictEqual(Target.Entry(name)("/work"), Target.Entry("/work", name))
    assert.deepStrictEqual(Vfs.Entry("file")("/work"), Target.Entry("/work", "file"))
    assert.strictEqual(Vfs.isVolumeDurabilityAtLeast, Volume.isVolumeDurabilityAtLeast)
    const meetsRequirement = Volume.isVolumeDurabilityAtLeast("survives-process-crash")
    assert.isTrue(meetsRequirement("survives-operating-system-crash"))
    assert.isFalse(meetsRequirement("memory-only"))
    assert.strictEqual(
      meetsRequirement("survives-process-crash"),
      Volume.isVolumeDurabilityAtLeast("survives-process-crash", "survives-process-crash")
    )
  })
})
