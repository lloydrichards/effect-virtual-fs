import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { assert, it } from "@effect/vitest"
import { ByteSize, Effect, Result, Schema } from "effect"
import { BytePath, VirtualFileSystem as Vfs } from "../src/index.js"
import { DeltaBudgetFromLimits } from "../src/internal/budget.js"
import { mergeOverlayCaptures } from "../src/internal/snapshotMerge.js"
import { captureOverlayForMerge } from "../src/internal/virtualFileSystem.js"
import { VfsError } from "../src/VfsError.js"
import { entryNames, pathText, text } from "./support/text.js"

const encoder = new TextEncoder()

const limits = Result.getOrThrow(Schema.decodeResult(DeltaBudgetFromLimits)(Vfs.SnapshotDeltaLimits.default))

const fixture = Vfs.fromFixture({
  entries: [
    { kind: "directory", path: "/dir" },
    { kind: "file", path: "/source", bytes: encoder.encode("base") },
    { kind: "file", path: "/other", bytes: encoder.encode("untouched") },
    { kind: "symlink", path: "/sym", target: "source" }
  ]
})

const both = Effect.gen(function*() {
  const base = yield* (yield* fixture).snapshot
  const ours = yield* Vfs.makeOverlay(base)
  const theirs = yield* Vfs.makeOverlay(base)

  return { base, ours, theirs, left: yield* ours.caller(), right: yield* theirs.caller() }
})

const write = (fs: Vfs.Caller, path: string | BytePath.BytePath, bytes: string) =>
  fs.writeFile(path, encoder.encode(bytes), { access: "write", truncate: true, create: "ifMissing" })

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
  const volume = yield* Vfs.fromSnapshot(yield* Vfs.applySnapshotDelta(base, delta))

  return yield* volume.caller()
})

const readText = (caller: Vfs.Caller, path: string | BytePath.BytePath) => Effect.map(caller.readFile(path), text)

const isVfsError = Schema.is(VfsError)

const mergeFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flip(effect).pipe(Effect.map((error) => {
    if (!isVfsError(error)) throw new Error("Expected a VFS failure", { cause: error })

    return error
  }))

it.layer(BunCrypto.layer)("snapshot deltas from overlay captures", (it) => {
  it.effect("should follow an edit to the renamed path when merging an earlier capture", () =>
    Effect.gen(function*() {
      const { base, ours, theirs, left, right } = yield* both
      yield* left.rename("/source", "/dir/moved")
      yield* left.chmod("/dir/moved", 0o600)
      yield* write(right, "/source", "edit")
      const capture = yield* captureOverlayForMerge(ours)
      const edited = yield* captureOverlayForMerge(theirs)
      yield* write(left, "/dir/moved", "later")

      const equivalent = yield* Vfs.decodeSnapshot(yield* Vfs.encodeSnapshot(base), {
        maxEncodedBytes: ByteSize.kilobytes(10),
        maxDecodedBytes: ByteSize.kilobytes(10),
        maxEntries: 10,
        maxRecords: 10
      })

      const result = yield* mergeOverlayCaptures(equivalent, capture, edited, limits)
      const mirrored = yield* mergeOverlayCaptures(equivalent, edited, capture, limits)
      const fs = yield* apply(equivalent, result.delta)

      assert.deepStrictEqual(result.renameConflicts, [])
      assert.deepStrictEqual(result.conflicts, [])
      assert.strictEqual(yield* readText(fs, "/dir/moved"), "edit")
      assert.strictEqual((yield* fs.stat("/dir/moved")).mode, 0o600)
      assert.deepStrictEqual(
        yield* Vfs.inspectSnapshotDelta(equivalent, result.delta),
        yield* Vfs.inspectSnapshotDelta(equivalent, mirrored.delta)
      )
      assert.strictEqual((yield* Effect.flip(fs.stat("/source"))).code, "NotFound")
    }))

  it.effect("should preserve the base paths until a divergent move is resolved as a group", () =>
    Effect.gen(function*() {
      const { base, ours, theirs, left, right } = yield* both
      yield* left.rename("/source", "/a")
      yield* right.rename("/source", "/b")
      yield* write(right, "/b", "right")
      yield* write(left, "/other", "clean")
      const result = yield* merge(base, ours, theirs)
      assert.lengthOf(result.renameConflicts, 1)
      assert.deepStrictEqual(result.conflicts, [])
      const conflict = result.renameConflicts[0]!
      assert.strictEqual(conflict.reason, "RenameDiverged")
      assert.strictEqual(yield* pathText(conflict.path), "/source")
      assert.strictEqual(yield* pathText(conflict.ours.destination), "/a")
      assert.strictEqual(yield* pathText(conflict.theirs.destination), "/b")
      assert.strictEqual(conflict.theirs.changes._tag, "Updated")
      const fs = yield* apply(base, result.delta)
      assert.strictEqual(yield* readText(fs, "/source"), "base")
      assert.strictEqual(yield* readText(fs, "/other"), "clean")
      assert.strictEqual((yield* Effect.flip(fs.stat("/a"))).code, "NotFound")
      assert.strictEqual((yield* Effect.flip(fs.stat("/b"))).code, "NotFound")

      for (const take of ["ours", "theirs", "base"] as const) {
        const chosen = yield* merge(base, ours, theirs, { renames: [{ source: conflict.source, take }] })
        const fs = yield* apply(base, chosen.delta)
        assert.deepStrictEqual(chosen.renameConflicts, [])
        const path = take === "ours" ? "/a" : take === "theirs" ? "/b" : "/source"
        assert.strictEqual(yield* readText(fs, path), take === "theirs" ? "right" : "base")
        assert.strictEqual(yield* readText(fs, "/other"), "clean")
        assert.deepStrictEqual(entryNames(yield* fs.readDirectory("/")), ["dir", "other", "sym", path.slice(1)].sort())
      }

      const choice = { source: conflict.source, take: "base" } as const
      assert.strictEqual(
        (yield* mergeFailure(merge(base, ours, theirs, { renames: [choice, choice] }))).code,
        "InvalidArgument"
      )
      assert.strictEqual(
        (yield* mergeFailure(merge(base, ours, theirs, {
          renames: [{ ...choice, source: yield* BytePath.fromString("/other") }]
        }))).code,
        "InvalidArgument"
      )
    }))

  it.effect("should take a removal against a clean move and conflict against an edited move", () =>
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
      assert.strictEqual(yield* pathText(edited.renameConflicts[0]!.path), "/moved")
    }))

  it.effect("should combine source edits before comparing an independent addition", () =>
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
      assert.strictEqual(yield* readText(fs, "/source"), "combined")
      assert.strictEqual(yield* readText(fs, "/moved"), "different")

      yield* write(right, "/moved", "combined")
      const combined = yield* merge(base, ours, theirs)
      assert.deepStrictEqual(combined.renameConflicts, [])
      const merged = yield* apply(base, combined.delta)
      assert.strictEqual(yield* readText(merged, "/moved"), "combined")
      assert.strictEqual((yield* mergeFailure(merged.stat("/source"))).code, "NotFound")

      yield* write(left, "/moved", "left")
      const changed = yield* merge(base, ours, theirs)
      assert.strictEqual(changed.renameConflicts[0]?.reason, "BothChanged")
    }))

  it.effect("should reject fabricated captures and captures from a foreign base", () =>
    Effect.gen(function*() {
      const { base, ours, theirs } = yield* both
      const retained = yield* captureOverlayForMerge(ours)
      const publicCapture: object = yield* theirs.capture()
      // SAFETY: Intentionally forge an input to exercise the runtime registry check.
      const fake = publicCapture as typeof retained
      assert.strictEqual(
        (yield* mergeFailure(mergeOverlayCaptures(base, retained, fake, limits))).code,
        "InvalidArgument"
      )
      assert.strictEqual((yield* Effect.flip(captureOverlayForMerge({ ...ours }))).code, "InvalidArgument")

      const empty = yield* (yield* Vfs.make()).snapshot
      const foreign = yield* captureOverlayForMerge(yield* Vfs.makeOverlay(empty))
      assert.strictEqual(
        (yield* mergeFailure(mergeOverlayCaptures(base, retained, foreign, limits))).code,
        "BaseMismatch"
      )
      assert.strictEqual(
        (yield* mergeFailure(mergeOverlayCaptures(base, foreign, retained, limits))).code,
        "BaseMismatch"
      )
    }))

  it.effect("should reject a destination directory together with its children", () =>
    Effect.gen(function*() {
      const { base, ours, theirs, left, right } = yield* both

      yield* left.rename("/source", "/moved")
      yield* right.mkdir("/moved")
      yield* write(right, "/moved/child", "directory collision")
      const collision = yield* mergeFailure(merge(base, ours, theirs))
      assert.strictEqual(collision.code, "InvalidStructure")
      assert.strictEqual(collision.field, "renameDestination")
      assert.strictEqual(yield* pathText(collision.path), "/moved")
    }))

  it.effect("should merge moves to the same byte path and preserve identity and idempotence", () =>
    Effect.gen(function*() {
      const { base, ours, theirs, left, right } = yield* both
      const untouched = yield* merge(base, ours, theirs)
      assert.deepStrictEqual(yield* Vfs.inspectSnapshotDelta(base, untouched.delta), [])
      const raw = yield* BytePath.fromBytes(Uint8Array.of(47, 255))
      yield* left.rename("/source", raw)
      const oneSided = yield* merge(base, ours, theirs)
      const moved = yield* Vfs.diffSnapshots(base, (yield* ours.capture()).snapshot)
      assert.deepStrictEqual(oneSided.renameConflicts, [])
      assert.deepStrictEqual(
        yield* Vfs.inspectSnapshotDelta(base, oneSided.delta),
        yield* Vfs.inspectSnapshotDelta(base, moved)
      )

      yield* right.rename("/source", raw)
      yield* write(left, raw, "edited")
      yield* right.chmod(raw, 0o640)
      const combined = yield* merge(base, ours, theirs)
      const same = yield* merge(base, ours, ours)
      const reader = yield* apply(base, combined.delta)
      assert.deepStrictEqual(combined.renameConflicts, [])
      assert.strictEqual(yield* readText(reader, raw), "edited")
      assert.strictEqual((yield* reader.stat(raw)).mode, 0o640)
      const standalone = yield* Vfs.diffSnapshots(base, (yield* ours.capture()).snapshot)
      assert.deepStrictEqual(
        yield* Vfs.inspectSnapshotDelta(base, same.delta),
        yield* Vfs.inspectSnapshotDelta(base, standalone)
      )
    }))

  it.effect("should treat an equal-byte replacement as an addition and removal", () =>
    Effect.gen(function*() {
      const { base, ours, theirs, left, right } = yield* both
      yield* left.remove("/source")
      yield* write(left, "/moved", "base")
      yield* write(right, "/source", "edit")

      const result = yield* merge(base, ours, theirs)

      assert.deepStrictEqual(result.renameConflicts, [])
      assert.strictEqual(result.conflicts[0]?.reason, "ChangedRemoved")
      const fs = yield* apply(base, result.delta)
      assert.strictEqual(yield* readText(fs, "/source"), "base")
      assert.strictEqual(yield* readText(fs, "/moved"), "base")
    }))

  it.effect("should resolve ordinary path conflicts alongside rename groups", () =>
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
      assert.strictEqual(yield* readText(fs, "/a"), "base")
      assert.strictEqual(yield* readText(fs, "/other"), "right")
      assert.strictEqual(
        (yield* mergeFailure(merge(base, ours, theirs, {
          paths: [{ path: rename.source, take: "ours" }]
        }))).code,
        "InvalidArgument"
      )
    }))

  it.effect.each(
    [
      ["directory move", (fs: Vfs.Caller) => fs.rename("/dir", "/moved"), "renameLineage"],
      ["symlink move", (fs: Vfs.Caller) => fs.rename("/sym", "/moved"), "renameLineage"],
      ["hard-linked file move", (fs: Vfs.Caller) =>
        Effect.gen(function*() {
          yield* fs.link("/source", "/alias")
          yield* fs.rename("/source", "/moved")
        }), "renameLineage"],
      ["occupied destination", (fs: Vfs.Caller) => fs.rename("/source", "/other"), "renameOverlap"],
      ["swap", (fs: Vfs.Caller) =>
        Effect.gen(function*() {
          yield* fs.rename("/source", "/temp")
          yield* fs.rename("/other", "/source")
          yield* fs.rename("/temp", "/other")
        }), "renameOverlap"]
    ] as const
  )("should reject an unsupported move when the scenario is %s", ([, edit, field]) =>
    Effect.gen(function*() {
      const { base, ours, theirs, left } = yield* both
      yield* edit(left)

      const error = yield* mergeFailure(merge(base, ours, theirs))

      assert.strictEqual(error.code, "InvalidStructure")
      assert.strictEqual(error.field, field)
    }))

  it.effect("should reject moves from different sources to the same destination", () =>
    Effect.gen(function*() {
      const { base, ours, theirs, left, right } = yield* both
      yield* left.rename("/source", "/moved")
      yield* right.rename("/other", "/moved")

      const error = yield* mergeFailure(merge(base, ours, theirs))

      assert.strictEqual(error.code, "InvalidStructure")
      assert.strictEqual(error.field, "renameOverlap")
      assert.strictEqual(yield* pathText(error.path), "/moved")
    }))

  it.effect("should reject a move when the other side replaces its destination parent", () =>
    Effect.gen(function*() {
      const { base, ours, theirs, left, right } = yield* both
      yield* left.rename("/source", "/dir/moved")
      yield* right.remove("/dir")
      yield* right.mkdir("/dir")

      const error = yield* mergeFailure(merge(base, ours, theirs))

      assert.strictEqual(error.code, "InvalidStructure")
      assert.strictEqual(error.field, "renameParent")
    }))

  it.effect("should enforce the path count limit when unresolved moves produce an empty delta", () =>
    Effect.gen(function*() {
      const count = 12
      const sources = Array.from({ length: count }, (_, index) => "/s" + index)

      const volume = yield* Vfs.fromFixture({
        entries: sources.map((path) => ({ kind: "file" as const, path, bytes: encoder.encode("base") }))
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
      const over = yield* mergeFailure(merge(base, ours, theirs, undefined, { ...limits, entries: exact - 1 }))
      assert.strictEqual(over.code, "LimitExceeded")
      assert.strictEqual(over.field, "renamePaths")
    }))

  it.effect("should enforce the byte limit for paths in rename groups", () =>
    Effect.gen(function*() {
      const { base, ours, theirs, left, right } = yield* both
      const a = "/" + "é".repeat(40)
      const b = "/" + "b".repeat(80)
      yield* left.rename("/source", a)
      yield* right.rename("/source", b)
      const exact = encoder.encode(a).length + encoder.encode(b).length + encoder.encode("/source").length

      const at = yield* merge(base, ours, theirs, undefined, { ...limits, decodedBytes: ByteSize.bytes(exact) })
      assert.strictEqual(at.renameConflicts[0]?.reason, "RenameDiverged")

      const fail = yield* mergeFailure(merge(base, ours, theirs, undefined, {
        ...limits,
        decodedBytes: ByteSize.bytes(exact - 1)
      }))

      assert.strictEqual(fail.code, "LimitExceeded")
      assert.strictEqual(fail.field, "renamePathBytes")
    }))
})
