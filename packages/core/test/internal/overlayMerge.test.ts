import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { assert, it } from "@effect/vitest"
import { ByteSize, Effect, Option, Result, Schema } from "effect"
import { BytePath, VirtualFileSystem as Vfs } from "../../src/index.js"
import { DeltaBudgetFromLimits } from "../../src/internal/budget.js"
import { mergeOverlayCaptures } from "../../src/internal/snapshotMerge.js"
import { captureOverlayForMerge } from "../../src/internal/virtualFileSystem.js"
import { VfsError } from "../../src/VfsError.js"

const text = (value: string) => new TextEncoder().encode(value)

const pathText = (path: BytePath.BytePath) => Option.getOrThrow(BytePath.toStringOption(path))

const limits = Result.getOrThrow(Schema.decodeResult(DeltaBudgetFromLimits)(Vfs.SnapshotDeltaLimits.default))

const isVfsError = Schema.is(VfsError)

const fixture = Vfs.fromFixture({
  entries: [
    { kind: "directory", path: "/dir" },
    { kind: "file", path: "/source", bytes: text("base") },
    { kind: "file", path: "/other", bytes: text("untouched") }
  ]
})

const failure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flip(effect).pipe(Effect.map((error) => {
    if (!isVfsError(error)) throw new Error("Expected a VFS failure", { cause: error })

    return error
  }))

const both = Effect.gen(function*() {
  const base = yield* (yield* fixture).snapshot
  const ours = yield* Vfs.makeOverlay(base)
  const theirs = yield* Vfs.makeOverlay(base)

  return { base, ours, theirs, left: yield* ours.caller(), right: yield* theirs.caller() }
})

const write = (fs: Vfs.Caller, path: string | BytePath.BytePath, bytes: string) =>
  fs.writeFile(path, text(bytes), { access: "write", truncate: true, create: "ifMissing" })

const merge = Effect.fnUntraced(function*(
  base: Vfs.Snapshot,
  ours: Vfs.OverlayVolume,
  theirs: Vfs.OverlayVolume,
  options?: Parameters<typeof mergeOverlayCaptures>[4],
  budget = limits
) {
  return yield* mergeOverlayCaptures(
    base,
    yield* captureOverlayForMerge(ours),
    yield* captureOverlayForMerge(theirs),
    budget,
    options
  )
})

const apply = Effect.fnUntraced(function*(base: Vfs.Snapshot, delta: Vfs.SnapshotDelta) {
  const fs = yield* Vfs.fromSnapshot(yield* Vfs.applySnapshotDelta(base, delta))
  const reader = yield* fs.caller()

  return {
    read: (path: string) => reader.readFile(path).pipe(Effect.map((bytes) => new TextDecoder().decode(bytes))),
    stat: (path: string) => reader.stat(path)
  }
})

it.layer(BunCrypto.layer)("internal overlay merge", (it) => {
  it.effect("follows a move with the other side's edits and retains the committed capture", () =>
    Effect.gen(function*() {
      const { base, ours, theirs, left, right } = yield* both
      yield* left.rename("/source", "/dir/moved")
      yield* left.chmod("/dir/moved", 0o600)
      yield* write(right, "/source", "edit")
      const capture = yield* captureOverlayForMerge(ours)
      const edited = yield* captureOverlayForMerge(theirs)
      yield* write(left, "/dir/moved", "later")

      const equivalent = yield* (yield* Vfs.fromSnapshot(base)).snapshot
      const result = yield* mergeOverlayCaptures(equivalent, capture, edited, limits)
      const mirrored = yield* mergeOverlayCaptures(equivalent, edited, capture, limits)
      const fs = yield* apply(equivalent, result.delta)

      assert.deepStrictEqual(result.renameConflicts, [])
      assert.deepStrictEqual(result.conflicts, [])
      assert.strictEqual(yield* fs.read("/dir/moved"), "edit")
      assert.strictEqual((yield* fs.stat("/dir/moved")).mode, 0o600)
      assert.deepStrictEqual(
        yield* Vfs.inspectSnapshotDelta(equivalent, result.delta),
        yield* Vfs.inspectSnapshotDelta(equivalent, mirrored.delta)
      )
      assert.strictEqual((yield* Effect.flip(fs.stat("/source"))).code, "NotFound")
    }))

  it.effect("holds divergent destinations at base and resolves the entire group", () =>
    Effect.gen(function*() {
      const { base, ours, theirs, left, right } = yield* both
      yield* left.rename("/source", "/a")
      yield* right.rename("/source", "/b")
      yield* write(right, "/b", "right")
      yield* write(left, "/other", "clean")
      const result = yield* merge(base, ours, theirs)
      const conflict = result.renameConflicts[0]!
      assert.strictEqual(conflict.reason, "RenameDiverged")
      assert.strictEqual(pathText(conflict.path), "/source")
      assert.strictEqual(pathText(conflict.ours.destination!), "/a")
      assert.strictEqual(pathText(conflict.theirs.destination!), "/b")
      assert.strictEqual(conflict.theirs.changes._tag, "Updated")
      const fs = yield* apply(base, result.delta)
      assert.strictEqual(yield* fs.read("/source"), "base")
      assert.strictEqual(yield* fs.read("/other"), "clean")
      assert.strictEqual((yield* Effect.flip(fs.stat("/a"))).code, "NotFound")
      assert.strictEqual((yield* Effect.flip(fs.stat("/b"))).code, "NotFound")

      for (const take of ["ours", "theirs", "base"] as const) {
        const chosen = yield* merge(base, ours, theirs, { renames: [{ source: conflict.source, take }] })
        const fs = yield* apply(base, chosen.delta)
        assert.deepStrictEqual(chosen.renameConflicts, [])
        const path = take === "ours" ? "/a" : take === "theirs" ? "/b" : "/source"
        assert.strictEqual(yield* fs.read(path), take === "theirs" ? "right" : "base")
        assert.strictEqual(yield* fs.read("/other"), "clean")
      }

      const choice = { source: conflict.source, take: "base" } as const
      assert.strictEqual(
        (yield* failure(merge(base, ours, theirs, { renames: [choice, choice] }))).code,
        "InvalidArgument"
      )
      assert.strictEqual(
        (yield* failure(merge(base, ours, theirs, {
          renames: [{ ...choice, source: yield* BytePath.fromString("/other") }]
        }))).code,
        "InvalidArgument"
      )
    }))

  it.effect("takes removal against a clean move and reports a move with edits", () =>
    Effect.gen(function*() {
      const { base, ours, theirs, left, right } = yield* both
      yield* left.rename("/source", "/moved")
      yield* right.remove("/source")
      const clean = yield* merge(base, ours, theirs)
      assert.deepStrictEqual(clean.renameConflicts, [])
      const fs = yield* apply(base, clean.delta)
      assert.strictEqual((yield* Effect.flip(fs.stat("/source"))).code, "NotFound")
      assert.strictEqual((yield* Effect.flip(fs.stat("/moved"))).code, "NotFound")

      yield* write(left, "/moved", "edit")
      const edited = yield* merge(base, ours, theirs)
      assert.strictEqual(edited.renameConflicts[0]?.reason, "ChangedRemoved")
      assert.strictEqual(pathText(edited.renameConflicts[0]!.path), "/moved")
    }))

  it.effect("combines the source edits before comparing an independent destination", () =>
    Effect.gen(function*() {
      const { base, ours, theirs, left, right } = yield* both
      yield* left.rename("/source", "/moved")
      yield* write(right, "/source", "combined")
      yield* write(right, "/moved", "different")
      const disputed = yield* merge(base, ours, theirs)
      const conflict = disputed.renameConflicts[0]!
      assert.strictEqual(conflict.reason, "BothAddedDifferent")
      assert.isTrue(conflict.theirs.independentAddition)
      const chosen = yield* merge(base, ours, theirs, { renames: [{ source: conflict.source, take: "theirs" }] })
      const fs = yield* apply(base, chosen.delta)
      assert.strictEqual(yield* fs.read("/source"), "combined")
      assert.strictEqual(yield* fs.read("/moved"), "different")

      yield* write(right, "/moved", "combined")
      const combined = yield* merge(base, ours, theirs)
      assert.deepStrictEqual(combined.renameConflicts, [])
      assert.strictEqual(yield* (yield* apply(base, combined.delta)).read("/moved"), "combined")

      yield* write(left, "/moved", "left")
      const changed = yield* merge(base, ours, theirs)
      assert.strictEqual(changed.renameConflicts[0]?.reason, "BothChanged")
    }))

  it.effect("rejects fabricated captures, a different base, and a directory collision", () =>
    Effect.gen(function*() {
      const { base, ours, theirs, left, right } = yield* both
      const retained = yield* captureOverlayForMerge(ours)
      const publicCapture: object = yield* theirs.capture()
      // SAFETY: Intentionally forge an input to exercise the runtime registry check.
      const fake = publicCapture as typeof retained
      assert.strictEqual((yield* failure(mergeOverlayCaptures(base, retained, fake, limits))).code, "InvalidArgument")
      const empty = yield* (yield* Vfs.make()).snapshot
      assert.strictEqual((yield* failure(mergeOverlayCaptures(empty, retained, retained, limits))).code, "BaseMismatch")

      yield* left.rename("/source", "/moved")
      yield* right.mkdir("/moved")
      yield* write(right, "/moved/child", "directory collision")
      const collision = yield* failure(merge(base, ours, theirs))
      assert.strictEqual(collision.code, "InvalidStructure")
      assert.strictEqual(collision.field, "renameDestination")
      assert.strictEqual(pathText(collision.path!), "/moved")
    }))

  it.effect("merges the same destination once, including identical and untouched inputs", () =>
    Effect.gen(function*() {
      const { base, ours, theirs, left, right } = yield* both
      const untouched = yield* merge(base, ours, theirs)
      assert.deepStrictEqual(yield* Vfs.inspectSnapshotDelta(base, untouched.delta), [])
      const raw = yield* BytePath.fromBytes(Uint8Array.of(47, 255))
      yield* left.rename("/source", raw)
      yield* right.rename("/source", raw)
      yield* write(left, raw, "edited")
      yield* right.chmod(raw, 0o640)
      const combined = yield* merge(base, ours, theirs)
      const same = yield* merge(base, ours, ours)
      const reader = yield* (yield* Vfs.fromSnapshot(yield* Vfs.applySnapshotDelta(base, combined.delta))).caller()
      assert.deepStrictEqual(combined.renameConflicts, [])
      assert.strictEqual(new TextDecoder().decode(yield* reader.readFile(raw)), "edited")
      assert.strictEqual((yield* reader.stat(raw)).mode, 0o640)
      const standalone = yield* Vfs.diffSnapshots(base, (yield* ours.capture()).snapshot)
      assert.deepStrictEqual(
        yield* Vfs.inspectSnapshotDelta(base, same.delta),
        yield* Vfs.inspectSnapshotDelta(base, standalone)
      )
    }))

  it.effect("keeps replacement with equal bytes separate from declared lineage", () =>
    Effect.gen(function*() {
      const { base, ours, theirs, left, right } = yield* both
      yield* left.remove("/source")
      yield* write(left, "/moved", "base")
      yield* write(right, "/source", "edit")

      const result = yield* merge(base, ours, theirs)

      assert.deepStrictEqual(result.renameConflicts, [])
      assert.strictEqual(result.conflicts[0]?.reason, "ChangedRemoved")
      const fs = yield* apply(base, result.delta)
      assert.strictEqual(yield* fs.read("/source"), "base")
      assert.strictEqual(yield* fs.read("/moved"), "base")
    }))

  it.effect("preserves ordinary path resolution alongside a rename group", () =>
    Effect.gen(function*() {
      const { base, ours, theirs, left, right } = yield* both
      yield* left.rename("/source", "/a")
      yield* right.rename("/source", "/b")
      yield* write(left, "/other", "left")
      yield* write(right, "/other", "right")
      const pending = yield* merge(base, ours, theirs)
      const rename = pending.renameConflicts[0]!
      const ordinary = pending.conflicts[0]!

      const chosen = yield* merge(base, ours, theirs, {
        renames: [{ source: rename.source, take: "ours" }],
        paths: [{ path: ordinary.path, take: "theirs" }]
      })

      const fs = yield* apply(base, chosen.delta)
      assert.deepStrictEqual(chosen.renameConflicts, [])
      assert.deepStrictEqual(chosen.conflicts, [])
      assert.strictEqual(yield* fs.read("/a"), "base")
      assert.strictEqual(yield* fs.read("/other"), "right")
      assert.strictEqual(
        (yield* failure(merge(base, ours, theirs, {
          paths: [{ path: rename.source, take: "ours" }]
        }))).code,
        "InvalidArgument"
      )
    }))

  it.effect("rejects moved directories, aliased files, occupied destinations, and replaced parents", () =>
    Effect.gen(function*() {
      const original = yield* both
      yield* original.left.rename("/dir", "/elsewhere")
      assert.strictEqual((yield* failure(merge(original.base, original.ours, original.theirs))).field, "renameLineage")

      const aliases = yield* both
      yield* aliases.left.link("/source", "/alias")
      yield* aliases.left.rename("/source", "/moved")
      assert.strictEqual((yield* failure(merge(aliases.base, aliases.ours, aliases.theirs))).field, "renameLineage")

      const occupied = yield* both
      yield* occupied.left.rename("/source", "/other")
      assert.strictEqual((yield* failure(merge(occupied.base, occupied.ours, occupied.theirs))).field, "renameOverlap")

      const replaced = yield* both
      yield* replaced.left.rename("/source", "/dir/moved")
      yield* replaced.right.remove("/dir")
      yield* replaced.right.mkdir("/dir")
      assert.strictEqual((yield* failure(merge(replaced.base, replaced.ours, replaced.theirs))).field, "renameParent")
    }))

  it.effect("bounds the distinct paths of many unresolved moves independently of the emitted delta", () =>
    Effect.gen(function*() {
      const count = 12
      const sources = Array.from({ length: count }, (_, index) => "/s" + index)

      const volume = yield* Vfs.fromFixture({
        entries: sources.map((path) => ({ kind: "file" as const, path, bytes: text("base") }))
      })

      const base = yield* volume.snapshot
      const ours = yield* Vfs.makeOverlay(base)
      const theirs = yield* Vfs.makeOverlay(base)
      const left = yield* ours.caller()
      const right = yield* theirs.caller()

      for (const [index, source] of sources.entries()) {
        yield* left.rename(source, "/a" + index)
        yield* right.rename(source, "/b" + index)
      }

      const exact = count * 3
      const at = yield* merge(base, ours, theirs, undefined, { ...limits, entries: exact })
      assert.strictEqual(at.renameConflicts.length, count)
      assert.deepStrictEqual(yield* Vfs.inspectSnapshotDelta(base, at.delta), [])
      const over = yield* failure(merge(base, ours, theirs, undefined, { ...limits, entries: exact - 1 }))
      assert.strictEqual(over.code, "LimitExceeded")
      assert.strictEqual(over.field, "renamePaths")
    }))

  it.effect("checks the exact rename path byte bound before retaining the group", () =>
    Effect.gen(function*() {
      const { base, ours, theirs, left, right } = yield* both
      const a = "/" + "a".repeat(80)
      const b = "/" + "b".repeat(80)
      yield* left.rename("/source", a)
      yield* right.rename("/source", b)
      const exact = a.length + b.length + "/source".length

      const at = yield* merge(base, ours, theirs, undefined, { ...limits, decodedBytes: ByteSize.bytes(exact) })
      assert.strictEqual(at.renameConflicts[0]?.reason, "RenameDiverged")

      const fail = yield* failure(merge(base, ours, theirs, undefined, {
        ...limits,
        decodedBytes: ByteSize.bytes(exact - 1)
      }))

      assert.strictEqual(fail.code, "LimitExceeded")
      assert.strictEqual(fail.field, "renamePathBytes")
    }))
})
