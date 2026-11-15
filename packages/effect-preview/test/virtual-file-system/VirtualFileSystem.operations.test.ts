// Generated from Effect PR #9960 by scripts/sync.mjs. Edit the snapshot or generator, then run sync.
import { assert, describe, it } from "@effect/vitest"
import * as BytePath from "../../src/compat/BytePath.js"
import * as DateTime from "../../src/compat/DateTime.js"
import { Clock, Deferred, Effect, Exit, Fiber, Option, Result, Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import * as VFS from "../../src/virtual-file-system/VirtualFileSystem.js"

const credentials = { uid: 0, gid: 0 }
const makeScope = Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))
const text = (path: BytePath.BytePath) => Result.getOrThrow(BytePath.toString(path))
const name = (name: string): VFS.TraversalProbe => ({ _tag: "Name", name })
const withClock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(
    Clock.Clock,
    (clock) => effect.pipe(Effect.provideService<Clock.Clock, Clock.Clock>(Clock.Clock, clock))
  )
const directory = (classification: VFS.TraversalClassification): VFS.TraversalDirectory => {
  assert.strictEqual(classification.kind, "directory")
  if (classification.kind !== "directory") throw new Error("Expected a directory classification")
  return classification.directory
}

describe("VirtualFileSystem session ownership", () => {
  it.effect("should acquire a session without namespace work when its caller cwd is unusable", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make()
      const admin = yield* owner.authorize({ credentials })
      yield* admin.makeDirectory("/cwd")
      const caller = yield* admin.withCurrentDirectory("/cwd")
      yield* admin.removeDirectory("/cwd")
      const operation = yield* caller.acquireOperation({ maxVisits: 0 })
      assert.strictEqual((yield* owner.usage).operations, 1)
      yield* operation.budget.consumeComparisons(0)
      assert.strictEqual((yield* Effect.flip(operation.traversal()))._tag, "LimitExceeded")
      yield* operation.close
      assert.strictEqual((yield* owner.usage).operations, 0)
    }).pipe(withClock))

  it.effect("should release private session charges when convenience traversal cannot select its base", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make({ limits: { callers: 2, operations: 1 } })
      const caller = yield* owner.authorize({ credentials })
      const before = yield* owner.usage
      assert.strictEqual((yield* Effect.flip(caller.acquireTraversal({ base: "/missing" })))._tag, "NotFound")
      assert.deepStrictEqual(yield* owner.usage, before)
      const operation = yield* caller.acquireOperation()
      yield* operation.close
      assert.deepStrictEqual(yield* owner.usage, before)
    }).pipe(withClock))

  it.effect("should release one shared session when any namespace view closes", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make({ limits: { callers: 2, operations: 1 } })
      const caller = yield* owner.authorize({ credentials })
      const before = yield* owner.usage
      const operation = yield* caller.acquireOperation()
      const first = yield* operation.traversal()
      const second = yield* operation.traversal()
      const active = yield* owner.usage
      assert.strictEqual(active.callers, before.callers + 1)
      assert.strictEqual(active.operations, before.operations + 1)
      assert.strictEqual(first.close, operation.close)
      assert.strictEqual(second.close, operation.close)
      yield* second.close
      yield* first.close
      assert.deepStrictEqual(yield* owner.usage, before)
    }).pipe(withClock))
})

describe("VirtualFileSystem traversal locations and selections", () => {
  it.effect("should charge the first followed selection when its symlink allowance is zero or one", () =>
    Effect.gen(function*() {
      for (const symlinkFollows of [0, 1]) {
        const owner = yield* VFS.make({ limits: { symlinkFollows } })
        const caller = yield* owner.authorize({ credentials })
        yield* caller.makeDirectory("/directory")
        yield* caller.writeFile("/file", new Uint8Array([7]))
        yield* caller.makeSymlink("/dirlink", "directory")
        yield* caller.makeSymlink("/filelink", "file")
        const operation = yield* caller.acquireOperation()
        const traversal = yield* operation.traversal()
        const selectedDirectory = Option.getOrThrow(yield* traversal.select(traversal.base, name("dirlink")))
        const selectedFile = Option.getOrThrow(yield* traversal.select(traversal.base, name("filelink")))
        if (symlinkFollows === 0) {
          for (
            const follow of [
              Effect.asVoid(traversal.classify(selectedDirectory)),
              Effect.asVoid(operation.files.readForCopy(selectedFile, { followFinalSymlink: true }))
            ]
          ) {
            const error = yield* Effect.flip(follow)
            assert.strictEqual(error._tag, "InvalidResource")
            if (error._tag === "InvalidResource") assert.strictEqual(error.reason, "symlinkLimit")
          }
        } else {
          assert.strictEqual((yield* traversal.classify(selectedDirectory)).kind, "directory")
          const copied = yield* operation.files.readForCopy(selectedFile, { followFinalSymlink: true })
          assert.strictEqual(copied.value.kind, "file")
          yield* copied.release
        }
        yield* operation.close
        assert.strictEqual((yield* owner.usage).reservedTransientBytes, 0n)
      }
    }).pipe(withClock))

  it.effect("should retain a followed link until its directory location releases when the selection and base release", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make()
      const caller = yield* owner.authorize({ credentials })
      yield* caller.makeDirectory("/target")
      yield* caller.makeSymlink("/link", "target")
      const initial = yield* owner.usage
      const operation = yield* caller.acquireOperation()
      const view = yield* operation.traversal({ base: "/" })
      const selected = Option.getOrThrow(yield* view.select(view.base, name("link")))
      const followed = directory(yield* view.classify(selected))
      assert.strictEqual((yield* owner.usage).reservedTransientBytes, 18n)
      yield* selected.release
      yield* view.base.release
      const retained = yield* owner.usage
      assert.strictEqual(retained.reservedTransientBytes, 10n)
      yield* caller.unlink("/link")
      const unlinked = {
        ...retained,
        entries: retained.entries - 1,
        unreachableRetainedObjects: 1,
        unreachableRetainedContentBytes: 6n
      }
      assert.deepStrictEqual(yield* owner.usage, unlinked)
      assert.strictEqual((yield* Effect.flip(view.list(followed)))._tag, "NamespaceChanged")
      assert.deepStrictEqual(yield* owner.usage, unlinked)
      yield* followed.release
      assert.deepStrictEqual(yield* owner.usage, {
        ...unlinked,
        liveObjects: unlinked.liveObjects - 1,
        contentBytes: 0n,
        unreachableRetainedObjects: 0,
        unreachableRetainedContentBytes: 0n,
        reservedTransientBytes: 0n
      })
      yield* operation.close
      assert.deepStrictEqual(yield* owner.usage, {
        ...initial,
        liveObjects: initial.liveObjects - 1,
        entries: initial.entries - 1,
        contentBytes: 0n
      })
    }).pipe(withClock))

  it.effect("should retain detached ancestors when an independent child location remains live", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make()
      const caller = yield* owner.authorize({ credentials })
      yield* caller.makeDirectory("/aa/b", { recursive: true })
      const initial = yield* owner.usage
      const operation = yield* caller.acquireOperation()
      const view = yield* operation.traversal({ base: "/aa" })
      const selected = Option.getOrThrow(yield* view.select(view.base, name("b")))
      const child = directory(yield* view.classify(selected))
      assert.strictEqual((yield* owner.usage).reservedTransientBytes, 9n)
      yield* view.base.release
      assert.strictEqual((yield* owner.usage).reservedTransientBytes, 7n)
      yield* selected.release
      const retained = yield* owner.usage
      assert.strictEqual(retained.reservedTransientBytes, 3n)
      yield* caller.removeDirectory("/aa/b")
      yield* caller.removeDirectory("/aa")
      assert.deepStrictEqual(yield* owner.usage, {
        ...retained,
        entries: 0,
        unreachableRetainedObjects: 2,
        unreachableRetainedContentBytes: 0n
      })
      yield* child.release
      assert.deepStrictEqual(yield* owner.usage, {
        ...retained,
        liveObjects: 1,
        entries: 0,
        reservedTransientBytes: 0n
      })
      yield* operation.close
      assert.deepStrictEqual(yield* owner.usage, { ...initial, liveObjects: 1, entries: 0 })
    }).pipe(withClock))

  it.effect("should release partial list selections when payload admission fails", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make({ limits: { transientBytes: 64 } })
      const caller = yield* owner.authorize({ credentials })
      yield* caller.makeDirectory("/target")
      yield* caller.makeSymlink("/aa", "target")
      yield* caller.makeSymlink("/bb", "target")
      const initial = yield* owner.usage
      const operation = yield* caller.acquireOperation()
      const view = yield* operation.traversal({ base: "/" })
      const pressure = yield* operation.budget.reservePayload(58)
      const before = yield* owner.usage
      const root = yield* caller.stat("/")
      const failure = yield* Effect.flip(view.list(view.base))
      assert.strictEqual(failure._tag, "LimitExceeded")
      if (failure._tag === "LimitExceeded") {
        assert.strictEqual(failure.domain, "transient")
        assert.strictEqual(failure.stage, "reservation")
      }
      assert.deepStrictEqual(yield* owner.usage, before)
      const after = yield* caller.stat("/")
      assert.deepStrictEqual(after.metadata, root.metadata)
      assert.isTrue(VFS.equalsObjectRevision(after.revision, root.revision))
      yield* pressure.release
      yield* caller.unlink("/aa")
      yield* caller.unlink("/bb")
      assert.strictEqual((yield* owner.usage).unreachableRetainedObjects, 0)
      assert.strictEqual((yield* owner.usage).unreachableRetainedContentBytes, 0n)
      yield* view.base.release
      yield* operation.close
      assert.deepStrictEqual(yield* owner.usage, {
        ...initial,
        liveObjects: initial.liveObjects - 2,
        entries: initial.entries - 2,
        contentBytes: 0n
      })
    }).pipe(withClock))

  it.effect("should select exact names without touching atime when only search permission is granted", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make()
      const admin = yield* owner.authorize({ credentials })
      yield* admin.makeDirectory("/hidden")
      yield* admin.writeFile("/hidden/file", new Uint8Array([1]))
      yield* admin.setAttributes("/hidden", { mode: 0o111 })
      const caller = yield* owner.authorize({ credentials: { uid: 100, gid: 100 } })
      const view = yield* caller.acquireTraversal({ base: "/hidden" })
      const before = yield* caller.stat("/hidden")
      const selected = Option.getOrThrow(yield* view.select(view.base, name("file")))
      assert.strictEqual(selected.object.kind, "file")
      assert.isTrue(Option.isSome(selected.entry))
      assert.isTrue(Option.isNone(yield* view.select(view.base, name("missing"))))
      assert.strictEqual((yield* Effect.flip(view.list(view.base)))._tag, "AccessDenied")
      assert.strictEqual((yield* caller.stat("/hidden")).metadata.atime, before.metadata.atime)
    }).pipe(withClock))

  it.effect("should clamp explicit navigation to the caller root when the search base is below it", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make()
      const admin = yield* owner.authorize({ credentials })
      yield* admin.makeDirectory("/jail/base", { recursive: true })
      const caller = yield* admin.withRoot("/jail")
      const root = yield* caller.stat("/")
      const view = yield* caller.acquireTraversal({ base: "/base" })
      for (const probe of [{ _tag: "Root" }, { _tag: "Parent" }] as const) {
        const selected = Option.getOrThrow(yield* view.select(view.base, probe))
        assert.isTrue(Option.isNone(selected.entry))
        assert.isTrue(VFS.equalsObjectReference(selected.object.reference, root.reference))
        const parent = directory(yield* view.classify(selected))
        const again = Option.getOrThrow(yield* view.select(parent, { _tag: "Parent" }))
        assert.isTrue(VFS.equalsObjectReference(again.object.reference, root.reference))
      }
      const current = Option.getOrThrow(yield* view.select(view.base, { _tag: "Current" }))
      assert.isTrue(Option.isNone(current.entry))
      assert.isTrue(VFS.equalsObjectReference(current.object.reference, (yield* caller.stat("/base")).reference))
    }).pipe(withClock))

  it.effect("should share a retained child across views when its selection and source base release", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make()
      const caller = yield* owner.authorize({ credentials })
      yield* caller.makeDirectory("/child")
      yield* caller.writeFile("/child/f", new Uint8Array([2]))
      const operation = yield* caller.acquireOperation()
      const first = yield* operation.traversal()
      const second = yield* operation.traversal()
      const selected = Option.getOrThrow(yield* first.select(first.base, name("child")))
      const child = directory(yield* second.classify(selected))
      yield* selected.release
      yield* first.base.release
      assert.strictEqual((yield* second.list(child)).entries.length, 1)
      assert.strictEqual((yield* Effect.flip(first.list(first.base)))._tag, "InvalidResource")
      assert.strictEqual((yield* Effect.flip(first.classify(selected)))._tag, "InvalidResource")
      const foreign = yield* caller.acquireTraversal()
      assert.strictEqual((yield* Effect.flip(foreign.list(child)))._tag, "InvalidResource")
      yield* child.release
      yield* second.base.release
      yield* operation.close
      yield* foreign.close
      assert.strictEqual((yield* owner.usage).reservedTransientBytes, 0n)
    }).pipe(withClock))

  it.effect("should reject a stale selection when its entry is removed or replaced", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make()
      const caller = yield* owner.authorize({ credentials })
      yield* caller.writeFile("/f", new Uint8Array([1, 2]))
      const operation = yield* caller.acquireOperation()
      const view = yield* operation.traversal()
      const selected = Option.getOrThrow(yield* view.select(view.base, name("f")))
      yield* caller.unlink("/f")
      assert.strictEqual((yield* owner.usage).unreachableRetainedObjects, 0)
      assert.strictEqual((yield* owner.usage).contentBytes, 0n)
      assert.strictEqual((yield* Effect.flip(operation.files.readForCopy(selected)))._tag, "NamespaceChanged")
      yield* caller.writeFile("/f", new Uint8Array([3]))
      assert.strictEqual((yield* Effect.flip(view.classify(selected)))._tag, "NamespaceChanged")
      assert.strictEqual(selected.object.metadata.size, 2n)
    }).pipe(withClock))

  it.effect("should reject a stale followed route when its link or target binding changes", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make()
      const caller = yield* owner.authorize({ credentials })
      yield* caller.makeDirectory("/target")
      yield* caller.makeSymlink("/link", "target")
      const view = yield* caller.acquireTraversal()
      const selected = Option.getOrThrow(yield* view.select(view.base, name("link")))
      const followed = directory(yield* view.classify(selected))
      yield* caller.unlink("/link")
      yield* caller.makeSymlink("/link", "target")
      assert.strictEqual((yield* Effect.flip(view.list(followed)))._tag, "NamespaceChanged")
      const replacement = Option.getOrThrow(yield* view.select(view.base, name("link")))
      const next = directory(yield* view.classify(replacement))
      yield* caller.rename("/target", "/moved")
      yield* caller.makeDirectory("/target")
      assert.strictEqual((yield* Effect.flip(view.list(next)))._tag, "NamespaceChanged")
      yield* selected.release
      yield* replacement.release
      yield* followed.release
      yield* next.release
    }).pipe(withClock))

  it.effect("should reject descent outside the caller root when its cwd location moves", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make()
      const admin = yield* owner.authorize({ credentials })
      yield* admin.makeDirectory("/jail/base", { recursive: true })
      const confined = yield* admin.withRoot("/jail")
      const caller = yield* confined.withCurrentDirectory("/base")
      const view = yield* caller.acquireTraversal()
      yield* admin.rename("/jail/base", "/outside")
      assert.strictEqual((yield* Effect.flip(view.list(view.base)))._tag, "AccessDenied")
      const root = Option.getOrThrow(yield* view.select(view.base, { _tag: "Root" }))
      assert.isTrue(VFS.equalsObjectReference(root.object.reference, (yield* caller.stat("/")).reference))
    }).pipe(withClock))
})

describe("VirtualFileSystem live walk and recursive removal", () => {
  it.effect("should preserve the tree until visits are available when recursive removal reads own or inherited options", () =>
    Effect.gen(function*() {
      class InheritedRemoveOptions {
        get maxVisits() {
          return 0
        }
      }
      const owner = yield* VFS.make()
      const caller = yield* owner.authorize({ credentials })
      yield* caller.makeDirectory("/tree")
      yield* caller.writeFile("/tree/file", new Uint8Array([1]))
      const before = yield* owner.usage
      for (const options of [{ maxVisits: 0 }, new InheritedRemoveOptions()]) {
        const error = yield* Effect.flip(caller.removeRecursive("/tree", options))
        assert.strictEqual(error._tag, "LimitExceeded")
        if (error._tag === "LimitExceeded") assert.strictEqual(error.domain, "visits")
        assert.deepStrictEqual(yield* owner.usage, before)
        assert.deepStrictEqual(yield* caller.readFile("/tree/file"), new Uint8Array([1]))
      }
      yield* caller.removeRecursive("/tree", { maxVisits: 1024 })
      assert.strictEqual((yield* Effect.flip(caller.stat("/tree")))._tag, "NotFound")
      assert.strictEqual((yield* owner.usage).operations, 0)
      assert.strictEqual((yield* owner.usage).reservedTransientBytes, 0n)
    }).pipe(withClock))

  it.effect("should release the followed symlink when a paused walk only needs its target directory", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make()
      const caller = yield* owner.authorize({ credentials })
      yield* caller.makeDirectory("/tree")
      yield* caller.makeSymlink("/start", "tree")
      const before = yield* owner.usage
      yield* caller.walk("/start").pipe(
        Stream.take(1),
        Stream.runForEach((record) =>
          Effect.gen(function*() {
            assert.isTrue(record.root)
            const paused = yield* owner.usage
            assert.deepStrictEqual(paused, {
              ...before,
              operations: before.operations + 1,
              reservedTransientBytes: 15n
            })
            yield* caller.unlink("/start")
            assert.deepStrictEqual(yield* owner.usage, {
              ...paused,
              liveObjects: paused.liveObjects - 1,
              entries: paused.entries - 1,
              contentBytes: 0n,
              unreachableRetainedObjects: 0,
              unreachableRetainedContentBytes: 0n
            })
          })
        )
      )
      assert.deepStrictEqual(yield* owner.usage, {
        ...before,
        liveObjects: before.liveObjects - 1,
        entries: before.entries - 1,
        contentBytes: 0n
      })
    }).pipe(withClock))

  it.effect("should emit a byte-sorted depth-first walk without touching timestamps when the tree contains symlink leaves", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make()
      const caller = yield* owner.authorize({ credentials })
      yield* caller.makeDirectory("/tree/a", { recursive: true })
      yield* caller.writeFile("/tree/a/x", new Uint8Array([1]))
      yield* caller.writeFile("/tree/b", new Uint8Array([2]))
      yield* caller.makeSymlink("/tree/link", "a")
      yield* caller.makeSymlink("/start", "tree")
      const raw = Result.getOrThrow(BytePath.fromBytes(new Uint8Array([255])))
      yield* caller.createFile({ directory: "/tree", name: raw })
      const before = yield* Effect.forEach(
        ["/tree", "/tree/a", "/tree/a/x", "/tree/b", "/tree/link"],
        (target) => caller.linkStat(target)
      )
      yield* TestClock.adjust("1 second")
      const records = yield* Stream.runCollect(caller.walk("/start"))
      assert.deepStrictEqual(records.slice(0, -1).map((record) => text(record.path)), [".", "a", "a/x", "b", "link"])
      const [first] = records
      const last = records.at(-1)
      if (first === undefined || last === undefined) throw new Error("Expected walk records")
      assert.deepStrictEqual(BytePath.toBytes(last.path), new Uint8Array([255]))
      assert.isTrue(first.root)
      assert.isFalse(Object.hasOwn(first, "entry"))
      assert.strictEqual(first.object.kind, "directory")
      assert.strictEqual(records.find((record) => text(record.path) === "link")?.object.kind, "symlink")
      for (const record of records.slice(1)) {
        assert.isFalse(record.root)
        if (!record.root) {
          assert.isTrue(VFS.equalsObjectReference(record.object.reference, record.entry.object.reference))
          assert.isTrue(VFS.equalsObjectRevision(record.object.revision, record.entry.object.revision))
        }
      }
      const after = yield* Effect.forEach(
        ["/tree", "/tree/a", "/tree/a/x", "/tree/b", "/tree/link"],
        (target) => caller.linkStat(target)
      )
      assert.deepStrictEqual(after.map((item) => item.metadata), before.map((item) => item.metadata))
      assert.strictEqual((yield* owner.usage).operations, 0)
      assert.strictEqual((yield* owner.usage).reservedTransientBytes, 0n)
    }).pipe(withClock))

  it.effect("should distinguish depth cutoff from budget exhaustion when a walk is bounded", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make()
      const caller = yield* owner.authorize({ credentials })
      yield* caller.makeDirectory("/a/b", { recursive: true })
      assert.deepStrictEqual(
        (yield* Stream.runCollect(caller.walk("/", { maxDepth: 0 }))).map((record) => text(record.path)),
        ["."]
      )
      assert.deepStrictEqual(
        (yield* Stream.runCollect(caller.walk("/", { maxDepth: 1 }))).map((record) => text(record.path)),
        [".", "a"]
      )
      const error = yield* Effect.flip(Stream.runCollect(caller.walk("/", { maxVisits: 0 })))
      assert.strictEqual(error._tag, "LimitExceeded")
      if (error._tag === "LimitExceeded") assert.strictEqual(error.domain, "visits")
      assert.strictEqual((yield* owner.usage).operations, 0)
      assert.strictEqual((yield* owner.usage).reservedTransientBytes, 0n)
      assert.deepStrictEqual(
        (yield* Stream.runCollect(caller.walk("/", { maxVisits: 1024 }))).map((record) => text(record.path)),
        [".", "a", "a/b"]
      )
    }).pipe(withClock))

  it.effect("should observe later siblings at emission when an earlier consumer changes the tree", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make()
      const caller = yield* owner.authorize({ credentials })
      yield* caller.createFile("/a")
      yield* caller.writeFile("/b", new Uint8Array([1]))
      const records: Array<VFS.WalkRecord> = []
      yield* caller.walk("/").pipe(Stream.runForEach((record) =>
        Effect.gen(function*() {
          records.push(record)
          if (text(record.path) === "a") {
            yield* caller.writeFile("/b", new Uint8Array([2, 3, 4]))
            yield* caller.createFile("/c")
          }
        })
      ))
      assert.deepStrictEqual(records.map((record) => text(record.path)), [".", "a", "b"])
      const b = records.find((record) => text(record.path) === "b")
      if (b === undefined) throw new Error("Expected the later sibling")
      const current = yield* caller.stat("/b")
      assert.strictEqual(b.object.metadata.size, 3n)
      assert.isTrue(VFS.equalsObjectRevision(b.object.revision, current.revision))
      if (b.root) throw new Error("Expected a child walk record")
      assert.strictEqual(b.entry.object.metadata.size, 3n)
      assert.isTrue(VFS.equalsObjectRevision(b.object.revision, b.entry.object.revision))
    }).pipe(withClock))

  it.effect("should preserve a replacement entry when a walk encounters a stale selected sibling", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make()
      const caller = yield* owner.authorize({ credentials })
      yield* caller.createFile("/a")
      yield* caller.createFile("/b")
      const seen: Array<string> = []
      const error = yield* Effect.flip(
        caller.walk("/").pipe(Stream.runForEach((record) =>
          Effect.gen(function*() {
            const name = text(record.path)
            seen.push(name)
            if (name === "a") {
              yield* caller.unlink("/b")
              yield* caller.writeFile("/b", new Uint8Array([9]))
            }
          })
        ))
      )
      assert.strictEqual(error._tag, "NamespaceChanged")
      assert.deepStrictEqual(seen, [".", "a"])
      assert.deepStrictEqual(yield* caller.readFile("/b"), new Uint8Array([9]))
      assert.strictEqual((yield* owner.usage).operations, 0)
      assert.strictEqual((yield* owner.usage).reservedTransientBytes, 0n)
    }).pipe(withClock))

  it.effect("should release the paused walk ticket and frames when the consumer stops early", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make({ limits: { operations: 1, synchronous: true } })
      const caller = yield* owner.authorize({ credentials })
      yield* caller.makeDirectory("/a/b", { recursive: true })
      const sync = yield* caller.acquireSync
      const before = yield* owner.usage
      yield* caller.walk("/").pipe(
        Stream.take(1),
        Stream.runForEach(() =>
          Effect.gen(function*() {
            const usage = yield* owner.usage
            assert.strictEqual(usage.operations, 1)
            assert.isTrue(usage.reservedTransientBytes > 0n)
            assert.strictEqual(usage.callers, before.callers)
            assert.strictEqual((yield* Effect.flip(caller.stat("/")))._tag, "LimitExceeded")
            const immediate = sync.stat("/")
            assert.isTrue(Result.isFailure(immediate))
            if (Result.isFailure(immediate)) assert.strictEqual(immediate.failure._tag, "Busy")
          })
        )
      )
      assert.deepStrictEqual(yield* owner.usage, before)
      assert.strictEqual((yield* caller.stat("/")).kind, "directory")
      assert.strictEqual(Result.getOrThrow(sync.stat("/")).kind, "directory")
    }).pipe(withClock))

  it.effect("should retain earlier deletions when recursive removal later loses permission", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make({ root: { mode: 0o777 } })
      const admin = yield* owner.authorize({ credentials: { ...credentials, privileged: true } })
      const user = yield* owner.authorize({ credentials: { uid: 10, gid: 10 } })
      yield* admin.makeDirectory("/tree")
      yield* admin.setAttributes("/tree", { mode: 0o777 })
      yield* admin.writeFile("/tree/a", new Uint8Array([1]))
      yield* admin.makeDirectory("/tree/b", { mode: 0 })
      yield* admin.writeFile("/tree/b/inside", new Uint8Array([2]))
      yield* admin.writeFile("/tree/c", new Uint8Array([3]))
      assert.strictEqual((yield* Effect.flip(user.removeRecursive("/tree")))._tag, "AccessDenied")
      assert.strictEqual((yield* Effect.flip(admin.stat("/tree/a")))._tag, "NotFound")
      assert.strictEqual((yield* admin.stat("/tree/b")).kind, "directory")
      assert.deepStrictEqual(yield* admin.readFile("/tree/c"), new Uint8Array([3]))
      assert.strictEqual((yield* owner.usage).operations, 0)
      assert.strictEqual((yield* owner.usage).reservedTransientBytes, 0n)
    }).pipe(withClock))
})

describe("VirtualFileSystem reference-route work", () => {
  it.effect("should fail route search without changing usage when a reference exceeds its visit budget", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make({ limits: { namespaceVisits: 6 } })
      const caller = yield* owner.authorize({ credentials })
      for (const name of ["a", "b", "c", "d", "e", "f", "target"]) yield* caller.createFile("/" + name)
      const target = yield* caller.stat("/target")
      const before = yield* owner.usage
      const error = yield* Effect.flip(caller.stat(target.reference))
      assert.strictEqual(error._tag, "LimitExceeded")
      if (error._tag !== "LimitExceeded") throw new Error("Expected authorized-route visit exhaustion")
      assert.strictEqual(error.domain, "visits")
      assert.strictEqual(error.stage, "resolution")
      assert.deepStrictEqual(yield* owner.usage, before)
      assert.isTrue(VFS.equalsObjectReference((yield* caller.stat("/target")).reference, target.reference))
    }).pipe(withClock))

  it.effect("should share reference-route work when namespace views belong to one session", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make()
      const caller = yield* owner.authorize({ credentials })
      yield* caller.makeDirectory("/d")
      const target = yield* caller.stat("/d")
      const operation = yield* caller.acquireOperation({ maxVisits: 5 })
      const first = yield* operation.traversal({ base: target.reference })
      const usage = yield* owner.usage
      const error = yield* Effect.flip(operation.traversal({ base: target.reference }))
      assert.strictEqual(error._tag, "LimitExceeded")
      if (error._tag !== "LimitExceeded") throw new Error("Expected shared reference-route visit exhaustion")
      assert.strictEqual(error.domain, "visits")
      assert.deepStrictEqual(yield* owner.usage, usage)
      yield* first.close
      assert.strictEqual((yield* owner.usage).reservedTransientBytes, 0n)
      assert.strictEqual((yield* owner.usage).operations, 0)
      // A separate session has a fresh finite work budget and can select the same route.
      const independent = yield* caller.acquireOperation({ maxVisits: 5 })
      yield* independent.traversal({ base: target.reference })
      yield* independent.close
    }).pipe(withClock))
})

describe("VirtualFileSystem session destination routes", () => {
  it.effect("should preserve replacement destinations when a session directory route becomes stale", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make()
      const caller = yield* owner.authorize({ credentials })
      yield* caller.makeDirectory("/destination")
      const operation = yield* caller.acquireOperation()
      const view = yield* operation.traversal({ base: "/destination" })
      yield* operation.files.writeFile({ directory: view.base, name: "before" }, new Uint8Array([1]))
      yield* caller.rename("/destination", "/moved")
      yield* caller.makeDirectory("/destination")
      const error = yield* Effect.flip(
        operation.files.writeFile({ directory: view.base, name: "after" }, new Uint8Array([2]))
      )
      assert.strictEqual(error._tag, "NamespaceChanged")
      assert.deepStrictEqual(yield* caller.readFile("/moved/before"), new Uint8Array([1]))
      assert.strictEqual((yield* Effect.flip(caller.stat("/destination/after")))._tag, "NotFound")
      assert.strictEqual((yield* Effect.flip(caller.stat("/moved/after")))._tag, "NotFound")
      yield* operation.close
      assert.strictEqual((yield* owner.usage).operations, 0)
      assert.strictEqual((yield* owner.usage).reservedTransientBytes, 0n)
    }).pipe(withClock))
})

describe("VirtualFileSystem independent operation lifetimes", () => {
  it.effect("should release acquisition charges when budget validation closes the source caller", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make()
      const scope = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))
      const source = yield* owner.authorize({ credentials }).pipe(Scope.provide(scope))
      let closing: Fiber.Fiber<void> | undefined
      let completed = false
      const options: VFS.OperationOptions = {
        get maxVisits() {
          closing ??= Effect.runFork(
            Scope.close(scope, Exit.void).pipe(Effect.tap(() =>
              Effect.sync(() => {
                completed = true
              })
            ))
          )
          return 100
        }
      }
      const result = yield* Effect.result(source.acquireOperation(options))
      assert.isTrue(completed)
      assert.isDefined(closing)
      if (closing !== undefined) yield* Fiber.join(closing)
      assert.strictEqual(result._tag, "Failure")
      if (result._tag === "Failure") assert.strictEqual(result.failure._tag, "InvalidResource")
      const usage = yield* owner.usage
      assert.strictEqual(usage.handles, 0)
      assert.strictEqual(usage.operations, 0)
      assert.strictEqual(usage.reservedTransientBytes, 0n)
      assert.strictEqual(usage.callers, 0)
      assert.strictEqual(usage.liveObjects, 1)
      assert.strictEqual(usage.entries, 0)
    }).pipe(withClock))

  it.effect("should retain the caller policy until its acquisition scope closes when the source caller releases", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make({ limits: { callers: 2, operations: 1, transientBytes: 64 } })
      const sourceScope = yield* makeScope
      const source = yield* owner.authorize({ credentials }).pipe(Scope.provide(sourceScope))
      const operationScope = yield* makeScope
      const operation = yield* source.acquireOperation().pipe(Scope.provide(operationScope))
      const traversal = yield* operation.traversal()
      const hold = yield* operation.budget.reservePayload(12)
      assert.strictEqual((yield* owner.usage).callers, 2)
      assert.strictEqual((yield* Effect.flip(owner.authorize({ credentials })))._tag, "LimitExceeded")
      yield* Scope.close(sourceScope, Exit.void)
      assert.strictEqual((yield* owner.usage).callers, 1)
      yield* operation.files.writeFile("/survives", new Uint8Array([9]))
      yield* Scope.close(operationScope, Exit.void)
      assert.strictEqual((yield* owner.usage).callers, 0)
      assert.strictEqual((yield* owner.usage).operations, 0)
      assert.strictEqual((yield* owner.usage).reservedTransientBytes, 0n)
      assert.strictEqual((yield* Effect.flip(traversal.list(traversal.base)))._tag, "InvalidResource")
      assert.strictEqual((yield* Effect.flip(hold.resize(0)))._tag, "InvalidResource")
      yield* operation.close
      yield* hold.release
      const observer = yield* owner.authorize({ credentials })
      assert.deepStrictEqual(yield* observer.readFile("/survives"), new Uint8Array([9]))
    }).pipe(withClock))

  it.effect("should release undelivered charges when a session is acquired into a closed scope", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make({ limits: { callers: 2, operations: 1 } })
      const caller = yield* owner.authorize({ credentials })
      const acquisitionScope = yield* makeScope
      yield* Scope.close(acquisitionScope, Exit.void)
      const before = yield* owner.usage
      assert.strictEqual(
        (yield* Effect.flip(caller.acquireOperation().pipe(Scope.provide(acquisitionScope))))._tag,
        "InvalidResource"
      )
      assert.deepStrictEqual(yield* owner.usage, before)
      const operation = yield* caller.acquireOperation()
      yield* operation.close
      assert.deepStrictEqual(yield* owner.usage, before)
    }).pipe(withClock))
})

describe("VirtualFileSystem cumulative work limits", () => {
  it.effect("should charge every listed binding before publishing atime when a directory reaches its visit limit", () =>
    Effect.gen(function*() {
      // Resolving root costs two visits; its four listed bindings cost four more.
      for (const namespaceVisits of [5, 6]) {
        const owner = yield* VFS.make({ limits: { namespaceVisits } })
        const caller = yield* owner.authorize({ credentials })
        for (const name of ["z", "a", "m", "target"]) yield* caller.createFile("/" + name)
        const before = yield* caller.stat("/")
        const usage = yield* owner.usage
        yield* TestClock.adjust("1 second")
        const result = yield* Effect.result(caller.readDirectoryEntries("/"))
        if (namespaceVisits === 5) {
          assert.isTrue(Result.isFailure(result))
          if (Result.isFailure(result)) {
            assert.strictEqual(result.failure._tag, "LimitExceeded")
            if (result.failure._tag === "LimitExceeded") assert.strictEqual(result.failure.domain, "visits")
          }
          const after = yield* caller.stat("/")
          assert.deepStrictEqual(after.metadata, before.metadata)
          assert.isTrue(VFS.equalsObjectRevision(after.revision, before.revision))
        } else {
          const listing = Result.getOrThrow(result)
          assert.deepStrictEqual(listing.entries.map((entry) => text(entry.name)), ["a", "m", "target", "z"])
          assert.isTrue(listing.directory.metadata.atime > before.metadata.atime)
        }
        assert.deepStrictEqual(yield* owner.usage, usage)
      }
    }).pipe(withClock))

  it.effect("should charge searched parent bindings and stop at the match when a route is reconstructed", () =>
    Effect.gen(function*() {
      // The late match costs four path visits, one parent edge, and four candidates.
      // Inserting the target first reduces the searched candidates to one.
      for (
        const [targetFirst, namespaceVisits, succeeds] of [[false, 8, false], [false, 9, true], [
          true,
          6,
          true
        ]] as const
      ) {
        const owner = yield* VFS.make({ limits: { namespaceVisits } })
        const caller = yield* owner.authorize({ credentials })
        if (targetFirst) yield* caller.makeDirectory("/target")
        for (const name of ["z", "a", "m"]) yield* caller.createFile("/" + name)
        if (!targetFirst) yield* caller.makeDirectory("/target")
        const before = yield* caller.stat("/target")
        const usage = yield* owner.usage
        for (const method of ["realPath", "observeRouteParent"] as const) {
          const reconstruct = caller[method]
          const action: Effect.Effect<BytePath.BytePath | Option.Option<VFS.PresentEntry>, VFS.ReadError> = reconstruct(
            "/target/."
          )
          const result = yield* Effect.result(action)
          if (!succeeds) {
            assert.isTrue(Result.isFailure(result))
            if (Result.isFailure(result)) {
              assert.strictEqual(result.failure._tag, "LimitExceeded")
              if (result.failure._tag === "LimitExceeded") assert.strictEqual(result.failure.domain, "visits")
            }
          } else {
            const route = Result.getOrThrow(result)
            if (BytePath.isBytePath(route)) {
              assert.strictEqual(text(route), "/target")
            } else {
              const entry = Option.getOrThrow(route)
              assert.strictEqual(text(entry.name), "target")
              assert.isTrue(VFS.equalsObjectReference(entry.object.reference, before.reference))
            }
          }
          const after = yield* caller.stat("/target")
          assert.deepStrictEqual(after.metadata, before.metadata)
          assert.isTrue(VFS.equalsObjectRevision(after.revision, before.revision))
          assert.deepStrictEqual(yield* owner.usage, usage)
        }
      }
    }).pipe(withClock))

  it.effect("should retain consumed work across views when selections and bases release", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make()
      const caller = yield* owner.authorize({ credentials })
      yield* caller.createFile("/a")
      yield* caller.createFile("/b")
      const before = yield* owner.usage
      // Two bases cost four visits; each listing costs two route checks plus two bindings.
      // The explicit comparison allowance is one above its default of 1048576.
      const maxComparisons = 1048577
      const operation = yield* caller.acquireOperation({ maxVisits: 11, maxComparisons })
      const first = yield* operation.traversal({ base: "/" })
      const second = yield* operation.traversal({ base: "/" })
      const listing = yield* first.list(first.base)
      yield* Effect.forEach(listing.entries, (entry) => entry.release)
      yield* first.budget.consumeComparisons(maxComparisons)
      const comparison = yield* Effect.flip(second.budget.consumeComparisons(1))
      assert.strictEqual(comparison._tag, "LimitExceeded")
      if (comparison._tag === "LimitExceeded") assert.strictEqual(comparison.domain, "comparisons")
      const visits = yield* Effect.flip(second.list(second.base))
      assert.strictEqual(visits._tag, "LimitExceeded")
      if (visits._tag === "LimitExceeded") assert.strictEqual(visits.domain, "visits")
      yield* first.base.release
      yield* second.base.release
      assert.strictEqual((yield* owner.usage).reservedTransientBytes, 0n)
      const exhausted = yield* Effect.flip(operation.traversal({ base: "/" }))
      assert.strictEqual(exhausted._tag, "LimitExceeded")
      if (exhausted._tag === "LimitExceeded") assert.strictEqual(exhausted.domain, "visits")
      yield* operation.close
      assert.deepStrictEqual(yield* owner.usage, before)
      const independent = yield* caller.acquireOperation({ maxVisits: 6, maxComparisons })
      const fresh = yield* independent.traversal({ base: "/" })
      assert.strictEqual((yield* fresh.list(fresh.base)).entries.length, 2)
      yield* fresh.budget.consumeComparisons(maxComparisons)
      yield* independent.close
      assert.deepStrictEqual(yield* owner.usage, before)
    }).pipe(withClock))
})

describe("VirtualFileSystem payload reservations", () => {
  it.effect("should preserve the existing hold on failed growth when a reservation is resized absolutely", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make({ limits: { transientBytes: 8 } })
      const caller = yield* owner.authorize({ credentials })
      const operation = yield* caller.acquireOperation()
      const hold = yield* operation.budget.reservePayload(0)
      yield* hold.resize(8)
      assert.strictEqual((yield* owner.usage).reservedTransientBytes, 8n)
      const error = yield* Effect.flip(hold.resize(9))
      assert.strictEqual(error._tag, "LimitExceeded")
      assert.strictEqual((yield* owner.usage).reservedTransientBytes, 8n)
      yield* hold.resize(3)
      yield* hold.resize(3)
      assert.strictEqual((yield* owner.usage).reservedTransientBytes, 3n)
      yield* hold.resize(0)
      yield* hold.resize(4)
      assert.strictEqual((yield* owner.usage).reservedTransientBytes, 4n)
      yield* hold.release
      yield* hold.release
      assert.strictEqual((yield* owner.usage).reservedTransientBytes, 0n)
      assert.strictEqual((yield* Effect.flip(hold.resize(0)))._tag, "InvalidResource")
      yield* operation.close
    }).pipe(withClock))

  it.effect("should enforce zero work budgets when session settings use inherited or non-enumerable properties", () =>
    Effect.gen(function*() {
      class ZeroWork {
        get maxComparisons() {
          return 0
        }
        get maxCopyBytes() {
          return 0
        }
      }
      const hidden = Object.defineProperties({ maxComparisons: 0, maxCopyBytes: 0 }, {
        maxComparisons: { enumerable: false },
        maxCopyBytes: { enumerable: false }
      })
      const owner = yield* VFS.make()
      const caller = yield* owner.authorize({ credentials })
      yield* caller.writeFile("/file", new Uint8Array([1]))
      for (const options of [new ZeroWork(), hidden]) {
        const operation = yield* caller.acquireOperation(options)
        const comparison = yield* Effect.flip(operation.budget.consumeComparisons(1))
        assert.strictEqual(comparison._tag, "LimitExceeded")
        if (comparison._tag === "LimitExceeded") assert.strictEqual(comparison.domain, "comparisons")
        const copy = yield* Effect.flip(operation.files.readForCopy("/file"))
        assert.strictEqual(copy._tag, "LimitExceeded")
        if (copy._tag === "LimitExceeded") assert.strictEqual(copy.domain, "copyBytes")
        yield* operation.close
      }
      assert.strictEqual((yield* owner.usage).reservedTransientBytes, 0n)
    }).pipe(withClock))

  it.effect("should reject malformed recursive options through typed errors when a supplied object contains an excess field", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make()
      const caller = yield* owner.authorize({ credentials })
      yield* caller.writeFile("/file", new Uint8Array([1]))
      const options: VFS.RemoveOptions = { maxVisits: 8 }
      // JavaScript callers can supply fields outside the declared option type.
      Object.defineProperty(options, "unexpected", { value: true, enumerable: true })
      const before = yield* owner.usage
      assert.strictEqual((yield* Effect.flip(caller.removeRecursive("/file", options)))._tag, "InvalidInput")
      assert.deepStrictEqual(yield* owner.usage, before)
      assert.deepStrictEqual(yield* caller.readFile("/file"), new Uint8Array([1]))
    }).pipe(withClock))
})

describe("VirtualFileSystem public scheduling boundaries", () => {
  it.effect("should reject same-instance reentry when a supplied clock starts synchronous work", () =>
    Effect.gen(function*() {
      const clock = yield* Clock.Clock
      let probe: (() => void) | undefined
      const owner = yield* VFS.make({ limits: { synchronous: true } }).pipe(
        Effect.provideService(Clock.Clock, {
          ...clock,
          currentTimeNanosUnsafe: () => {
            probe?.()
            return clock.currentTimeNanosUnsafe()
          }
        })
      )
      const caller = yield* owner.authorize({ credentials })
      const same = yield* caller.acquireSync
      const otherOwner = yield* VFS.make({ limits: { synchronous: true } })
      const otherCaller = yield* otherOwner.authorize({ credentials })
      const other = yield* otherCaller.acquireSync
      let observed = false
      probe = () => {
        probe = undefined
        const nested = same.stat("/")
        assert.isTrue(Result.isFailure(nested))
        if (Result.isFailure(nested)) assert.strictEqual(nested.failure._tag, "ReentrantOperation")
        assert.strictEqual(Result.getOrThrow(other.stat("/")).kind, "directory")
        assert.isTrue(Effect.isEffect(caller.stat("/")))
        observed = true
      }
      yield* caller.writeFile("/file", new Uint8Array([7]))
      assert.isTrue(observed)
      assert.strictEqual(Result.getOrThrow(same.stat("/")).kind, "directory")
    }).pipe(withClock))

  it.effect("should finish masked filesystem cleanup when its child is interrupted", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make()
      const caller = yield* owner.authorize({ credentials })
      yield* caller.writeFile("/temporary", new Uint8Array([1]))
      const ready = yield* Deferred.make<void>()
      const child = yield* Effect.gen(function*() {
        yield* Deferred.succeed(ready, undefined)
        yield* Effect.never
      }).pipe(
        Effect.ensuring(Effect.gen(function*() {
          yield* caller.unlink("/temporary")
          yield* caller.makeDirectory("/cleaned")
        }).pipe(Effect.orDie)),
        Effect.forkChild
      )
      yield* Deferred.await(ready)
      yield* Fiber.interrupt(child)
      const exit = yield* Fiber.await(child)
      assert.isTrue(Exit.hasInterrupts(exit))
      assert.strictEqual((yield* Effect.flip(caller.stat("/temporary")))._tag, "NotFound")
      assert.strictEqual((yield* caller.stat("/cleaned")).kind, "directory")
      assert.strictEqual((yield* owner.usage).operations, 0)
      assert.strictEqual((yield* owner.usage).reservedTransientBytes, 0n)
    }).pipe(withClock))

  it.effect("should publish a masked write before observing interruption from its clock", () =>
    Effect.gen(function*() {
      const clock = yield* Clock.Clock
      let interrupt: (() => void) | undefined
      const owner = yield* VFS.make().pipe(
        Effect.provideService(Clock.Clock, {
          ...clock,
          currentTimeNanosUnsafe: () => {
            interrupt?.()
            return clock.currentTimeNanosUnsafe()
          }
        })
      )
      const caller = yield* owner.authorize({ credentials })
      yield* caller.writeFile("/file", new Uint8Array([1, 2]))
      const before = yield* caller.stat("/file")
      let completed = false
      const writing = yield* Effect.withFiber((fiber) => {
        interrupt = () => {
          interrupt = undefined
          fiber.interruptUnsafe()
        }
        return Effect.uninterruptible(Effect.gen(function*() {
          yield* caller.writeFile("/file", new Uint8Array([8, 9, 10]))
          completed = true
        }))
      }).pipe(Effect.forkChild({ startImmediately: true }))
      assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(writing)))
      assert.isTrue(completed)
      const after = yield* caller.stat("/file")
      assert.isFalse(VFS.equalsObjectRevision(after.revision, before.revision))
      assert.deepStrictEqual(yield* caller.readFile("/file"), new Uint8Array([8, 9, 10]))
      assert.strictEqual((yield* owner.usage).operations, 0)
      assert.strictEqual((yield* owner.usage).reservedTransientBytes, 0n)
    }).pipe(withClock))

  it.effect("should preserve the previous file when interruption arrives through the write clock", () =>
    Effect.gen(function*() {
      const clock = yield* Clock.Clock
      let interrupt: (() => void) | undefined
      const owner = yield* VFS.make().pipe(
        Effect.provideService(Clock.Clock, {
          ...clock,
          currentTimeNanosUnsafe: () => {
            interrupt?.()
            return clock.currentTimeNanosUnsafe()
          }
        })
      )
      const caller = yield* owner.authorize({ credentials })
      yield* caller.writeFile("/file", new Uint8Array([1, 2]))
      const before = yield* caller.stat("/file")
      const writing = yield* Effect.withFiber((fiber) => {
        interrupt = () => {
          interrupt = undefined
          fiber.interruptUnsafe()
        }
        return caller.writeFile("/file", new Uint8Array([8, 9, 10]))
      }).pipe(Effect.forkChild({ startImmediately: true }))
      assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(writing)))
      const after = yield* caller.stat("/file")
      assert.deepStrictEqual(after.metadata, before.metadata)
      assert.isTrue(VFS.equalsObjectRevision(after.revision, before.revision))
      assert.deepStrictEqual(yield* caller.readFile("/file"), new Uint8Array([1, 2]))
      assert.strictEqual((yield* owner.usage).operations, 0)
      assert.strictEqual((yield* owner.usage).reservedTransientBytes, 0n)
    }).pipe(withClock))

  it.effect("should join all session closes after the admitted write when its clock starts shutdown", () =>
    Effect.gen(function*() {
      const clock = yield* Clock.Clock
      let shutdown: (() => void) | undefined
      const owner = yield* VFS.make().pipe(
        Effect.provideService(Clock.Clock, {
          ...clock,
          currentTimeNanosUnsafe: () => {
            shutdown?.()
            return clock.currentTimeNanosUnsafe()
          }
        })
      )
      const caller = yield* owner.authorize({ credentials })
      const before = yield* owner.usage
      const scope = yield* makeScope
      const operation = yield* caller.acquireOperation().pipe(Scope.provide(scope))
      const view = yield* operation.traversal()
      yield* operation.budget.reservePayload(5)
      const closes: Array<Fiber.Fiber<void>> = []
      let completed = 0
      shutdown = () => {
        shutdown = undefined
        for (const close of [operation.close, view.close, Scope.close(scope, Exit.void)]) {
          closes.push(Effect.runFork(Effect.tap(close, () => Effect.sync(() => completed++))))
        }
        assert.strictEqual(completed, 0)
      }
      yield* operation.files.writeFile("/committed", new Uint8Array([4, 5]))
      assert.strictEqual(closes.length, 3)
      yield* Effect.forEach(closes, Fiber.join)
      assert.strictEqual(completed, 3)
      assert.deepStrictEqual(yield* caller.readFile("/committed"), new Uint8Array([4, 5]))
      const usage = yield* owner.usage
      assert.strictEqual(usage.callers, before.callers)
      assert.strictEqual(usage.operations, before.operations)
      assert.strictEqual(usage.reservedTransientBytes, before.reservedTransientBytes)
      assert.strictEqual(
        (yield* Effect.flip(operation.files.writeFile("/late", new Uint8Array([6]))))._tag,
        "InvalidResource"
      )
      yield* operation.close
    }).pipe(withClock))
})

describe("VirtualFileSystem recursive mkdir dot components", () => {
  for (const suffix of [".", ".."] as const) {
    it.effect(`should create directories before resolving a terminal ${suffix}`, () =>
      Effect.gen(function*() {
        const owner = yield* VFS.make()
        const caller = yield* owner.authorize({ credentials })
        const created = yield* caller.makeDirectory(`/a/./b/../c/${suffix}`, { recursive: true })
        for (const path of ["/a/b", "/a/c"]) {
          assert.strictEqual((yield* caller.stat(path)).kind, "directory")
        }
        const selected = yield* caller.stat(suffix === "." ? "/a/c" : "/a")
        assert.isTrue(VFS.equalsObjectReference(created.reference, selected.reference))
      }).pipe(withClock))
  }

  it.effect("should resolve a terminal parent with a tight transient budget", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make({ limits: { transientBytes: 11 } })
      const caller = yield* owner.authorize({ credentials })
      const root = yield* caller.stat("/")
      const created = yield* caller.makeDirectory("/n/..", { recursive: true })
      assert.isTrue(VFS.equalsObjectReference(created.reference, root.reference))
      assert.strictEqual((yield* caller.stat("/n")).kind, "directory")
      assert.strictEqual((yield* owner.usage).reservedTransientBytes, 0n)
    }).pipe(withClock))

  it.effect("should resolve dot components in byte paths", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make()
      const caller = yield* owner.authorize({ credentials })
      const path = Result.getOrThrow(BytePath.fromBytes(new Uint8Array([47, 255, 47, 46, 46])))
      const child = Result.getOrThrow(BytePath.fromBytes(new Uint8Array([47, 255])))
      const root = yield* caller.stat("/")
      const created = yield* caller.makeDirectory(path, { recursive: true })
      assert.isTrue(VFS.equalsObjectReference(created.reference, root.reference))
      assert.strictEqual((yield* caller.stat(child)).kind, "directory")
    }).pipe(withClock))

  it.effect("should follow intermediate symlinks before resolving parent components inside its root", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make()
      const admin = yield* owner.authorize({ credentials })
      yield* admin.makeDirectory("/jail/target", { recursive: true })
      const caller = yield* admin.withRoot("/jail")
      yield* caller.makeSymlink("/link", "/target")
      const created = yield* caller.makeDirectory("/../../link/new/..", { recursive: true })
      assert.isTrue(VFS.equalsObjectReference(created.reference, yield* admin.lookup("/jail/target")))
      assert.strictEqual((yield* admin.stat("/jail/target/new")).kind, "directory")
      assert.strictEqual((yield* Effect.flip(admin.stat("/new")))._tag, "NotFound")
      assert.strictEqual((yield* Effect.flip(admin.stat("/target")))._tag, "NotFound")
    }).pipe(withClock))

  it.effect("should roll back staged dot-component creation when later traversal is denied", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make()
      const admin = yield* owner.authorize({ credentials })
      yield* admin.setAttributes("/", { mode: 0o777 })
      yield* admin.makeDirectory("/blocked", { mode: 0 })
      const caller = yield* owner.authorize({ credentials: { uid: 7, gid: 7 } })
      const before = yield* admin.stat("/")
      const usage = yield* owner.usage
      const error = yield* Effect.flip(caller.makeDirectory("/new/../blocked/x/.", { recursive: true }))
      assert.strictEqual(error._tag, "AccessDenied")
      assert.strictEqual((yield* Effect.flip(admin.stat("/new")))._tag, "NotFound")
      assert.isTrue(VFS.equalsObjectRevision(before.revision, (yield* admin.stat("/")).revision))
      assert.deepStrictEqual(yield* owner.usage, usage)
    }).pipe(withClock))

  it.effect("should roll back staged dot-component creation when the entry limit is reached", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make({ limits: { entries: 1 } })
      const caller = yield* owner.authorize({ credentials })
      const before = yield* caller.stat("/")
      const usage = yield* owner.usage
      const error = yield* Effect.flip(caller.makeDirectory("/first/../second/.", { recursive: true }))
      assert.strictEqual(error._tag, "LimitExceeded")
      if (error._tag === "LimitExceeded") assert.strictEqual(error.domain, "entries")
      for (const path of ["/first", "/second"]) {
        assert.strictEqual((yield* Effect.flip(caller.stat(path)))._tag, "NotFound")
      }
      assert.isTrue(VFS.equalsObjectRevision(before.revision, (yield* caller.stat("/")).revision))
      assert.deepStrictEqual(yield* owner.usage, usage)
    }).pipe(withClock))

  it.effect("should retain final-entry conditions after traversing dot components", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make()
      const caller = yield* owner.authorize({ credentials })
      yield* caller.makeDirectory("/existing")
      const before = yield* caller.stat("/")
      const usage = yield* owner.usage
      const error = yield* Effect.flip(caller.makeDirectory("/new/../existing", {
        recursive: true,
        conditions: { entry: { expected: "absent" } }
      }))
      assert.strictEqual(error._tag, "ConditionFailed")
      assert.strictEqual((yield* Effect.flip(caller.stat("/new")))._tag, "NotFound")
      assert.isTrue(VFS.equalsObjectRevision(before.revision, (yield* caller.stat("/")).revision))
      assert.deepStrictEqual(yield* owner.usage, usage)
      yield* caller.makeDirectory("/new/../created", {
        recursive: true,
        conditions: { entry: { expected: "absent" } }
      })
      assert.strictEqual((yield* caller.stat("/new")).kind, "directory")
      assert.strictEqual((yield* caller.stat("/created")).kind, "directory")
    }).pipe(withClock))

  for (const suffix of [".", ".."] as const) {
    it.effect(`should retain rejection of entry conditions on a terminal ${suffix}`, () =>
      Effect.gen(function*() {
        const owner = yield* VFS.make()
        const caller = yield* owner.authorize({ credentials })
        const usage = yield* owner.usage
        const error = yield* Effect.flip(caller.makeDirectory(`/new/${suffix}`, {
          recursive: true,
          conditions: { entry: { expected: "absent" } }
        }))
        assert.strictEqual(error._tag, "InvalidInput")
        if (error._tag === "InvalidInput") assert.strictEqual(error.field, "name")
        assert.strictEqual((yield* Effect.flip(caller.stat("/new")))._tag, "NotFound")
        assert.deepStrictEqual(yield* owner.usage, usage)
      }).pipe(withClock))
  }
})

describe("VirtualFileSystem current-time attributes", () => {
  for (const boundary of ["caller", "operation", "handle", "sync", "syncHandle"] as const) {
    it.effect(`should let a write-authorized non-owner touch both times through ${boundary}`, () =>
      Effect.gen(function*() {
        const owner = yield* VFS.make({ limits: { synchronous: true } })
        const admin = yield* owner.authorize({ credentials })
        yield* admin.createFile("/file")
        yield* admin.setAttributes("/file", { mode: 0o666 })
        const caller = yield* owner.authorize({ credentials: { uid: 7, gid: 7 } })
        yield* TestClock.adjust("2 seconds")
        const attributes = { atime: "now", mtime: "now" } as const
        if (boundary === "caller") yield* caller.setAttributes("/file", attributes)
        else if (boundary === "operation") {
          const operation = yield* caller.acquireOperation()
          yield* operation.files.setAttributes("/file", attributes)
        } else if (boundary === "handle") {
          const handle = yield* caller.open("/file")
          yield* handle.setAttributes(attributes)
        } else if (boundary === "sync") {
          const sync = yield* caller.acquireSync
          yield* Effect.fromResult(sync.setAttributes("/file", attributes))
        } else {
          const handle = yield* caller.open("/file")
          const sync = yield* handle.sync()
          yield* Effect.fromResult(sync.setAttributes(attributes))
        }
        const metadata = (yield* admin.stat("/file")).metadata
        assert.strictEqual(metadata.atime, 2_000_000_000n)
        assert.strictEqual(metadata.mtime, metadata.atime)
        assert.strictEqual(metadata.ctime, metadata.atime)
        assert.strictEqual(metadata.uid, 0)
        assert.strictEqual(metadata.mode, 0o666)
      }).pipe(withClock))
  }

  it.effect("should preserve omitted and literal times when an owner requests a current time", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make()
      const caller = yield* owner.authorize({ credentials })
      yield* caller.createFile("/file")
      const before = yield* caller.stat("/file")
      yield* TestClock.adjust("1 second")
      yield* caller.setAttributes("/file", { atime: "now" })
      const first = (yield* caller.stat("/file")).metadata
      assert.strictEqual(first.atime, 1_000_000_000n)
      assert.strictEqual(first.mtime, before.metadata.mtime)
      yield* TestClock.adjust("1 second")
      const literal = DateTime.unixNanoFromNanoseconds(-1n)
      yield* caller.setAttributes("/file", { atime: literal, mtime: "now" })
      const next = (yield* caller.stat("/file")).metadata
      assert.strictEqual(next.atime, literal)
      assert.strictEqual(next.mtime, 2_000_000_000n)
      assert.strictEqual(next.ctime, next.mtime)
      assert.strictEqual(next.birthtime, before.metadata.birthtime)
    }).pipe(withClock))

  it.effect("should retain prestate authority and publish nothing when a timestamp request is denied", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make()
      const admin = yield* owner.authorize({ credentials })
      yield* admin.createFile("/file")
      yield* admin.setAttributes("/file", { mode: 0o666 })
      const caller = yield* owner.authorize({ credentials: { uid: 7, gid: 7 } })
      yield* TestClock.adjust("1 second")
      const literal = DateTime.unixNanoFromNanoseconds(1_000_000_000n)
      const before = yield* admin.stat("/file")
      const usage = yield* owner.usage
      const requests: ReadonlyArray<VFS.Attributes> = [
        { atime: "now" },
        { atime: "now", mtime: literal },
        { atime: literal, mtime: literal },
        { atime: "now", mtime: "now", mode: 0o600 },
        { atime: "now", mtime: "now", uid: 7 }
      ]
      for (const attributes of requests) {
        const error = yield* Effect.flip(caller.setAttributes("/file", attributes))
        assert.strictEqual(error._tag, "AccessDenied")
        if (error._tag === "AccessDenied") assert.strictEqual(error.reason, "ownership")
        assert.deepStrictEqual(yield* admin.stat("/file"), before)
        assert.deepStrictEqual(yield* owner.usage, usage)
      }
      yield* admin.setAttributes("/file", { mode: 0o444 })
      const readonly = yield* admin.stat("/file")
      const denied = yield* Effect.flip(caller.setAttributes("/file", { atime: "now", mtime: "now" }))
      assert.strictEqual(denied._tag, "AccessDenied")
      if (denied._tag === "AccessDenied") assert.strictEqual(denied.reason, "permission")
      assert.deepStrictEqual(yield* admin.stat("/file"), readonly)
    }).pipe(withClock))

  it.effect("should use one transaction clock sample for all requested current times", () =>
    Effect.gen(function*() {
      const clock = yield* Clock.Clock
      let samples = 0
      const owner = yield* VFS.make().pipe(Effect.provideService(Clock.Clock, {
        ...clock,
        currentTimeNanosUnsafe: () => BigInt(++samples)
      }))
      const caller = yield* owner.authorize({ credentials })
      yield* caller.createFile("/file")
      const before = samples
      yield* caller.setAttributes("/file", { mode: 0o600, atime: "now", mtime: "now" })
      const metadata = (yield* caller.stat("/file")).metadata
      assert.strictEqual(samples, before + 1)
      assert.strictEqual(metadata.atime, BigInt(samples))
      assert.strictEqual(metadata.mtime, metadata.atime)
      assert.strictEqual(metadata.ctime, metadata.atime)
    }).pipe(withClock))

  it.effect("should retain revision guards when requesting current times", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make()
      const caller = yield* owner.authorize({ credentials })
      yield* caller.createFile("/file")
      const stale = yield* caller.stat("/file")
      yield* caller.writeFile("/file", new Uint8Array([1]))
      const before = yield* caller.stat("/file")
      const usage = yield* owner.usage
      yield* TestClock.adjust("1 second")
      const error = yield* Effect.flip(caller.setAttributes("/file", { atime: "now", mtime: "now" }, {
        expectedRevision: stale.revision
      }))
      assert.strictEqual(error._tag, "ConditionFailed")
      assert.deepStrictEqual(yield* caller.stat("/file"), before)
      assert.deepStrictEqual(yield* owner.usage, usage)
    }).pipe(withClock))

  it.effect("should roll back current-time updates when interrupted before publication", () =>
    Effect.gen(function*() {
      const clock = yield* Clock.Clock
      let interrupt: (() => void) | undefined
      const owner = yield* VFS.make().pipe(Effect.provideService(Clock.Clock, {
        ...clock,
        currentTimeNanosUnsafe: () => {
          interrupt?.()
          return clock.currentTimeNanosUnsafe()
        }
      }))
      const caller = yield* owner.authorize({ credentials })
      yield* caller.createFile("/file")
      const before = yield* caller.stat("/file")
      const usage = yield* owner.usage
      yield* TestClock.adjust("1 second")
      const updating = yield* Effect.withFiber((fiber) => {
        interrupt = () => {
          interrupt = undefined
          fiber.interruptUnsafe()
        }
        return caller.setAttributes("/file", { atime: "now", mtime: "now" })
      }).pipe(Effect.forkChild({ startImmediately: true }))
      assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(updating)))
      assert.deepStrictEqual(yield* caller.stat("/file"), before)
      assert.deepStrictEqual(yield* owner.usage, usage)
    }).pipe(withClock))

  it.effect("should preserve the revision when current times already equal the transaction clock", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make()
      const caller = yield* owner.authorize({ credentials })
      yield* caller.createFile("/file")
      const before = yield* caller.stat("/file")
      yield* caller.setAttributes("/file", { atime: "now", mtime: "now" })
      const after = yield* caller.stat("/file")
      assert.isTrue(VFS.equalsObjectRevision(before.revision, after.revision))
      assert.deepStrictEqual(after.metadata, before.metadata)
    }).pipe(withClock))
})

describe("VirtualFileSystem atomic resize attributes", () => {
  for (const boundary of ["caller", "operation", "handle", "sync", "syncHandle"] as const) {
    it.effect(`should resize and apply metadata atomically through ${boundary}`, () =>
      Effect.gen(function*() {
        const owner = yield* VFS.make({ limits: { synchronous: true } })
        const caller = yield* owner.authorize({ credentials })
        yield* caller.writeFile("/file", new Uint8Array([1, 2]))
        yield* caller.makeHardLink({ entry: "/file" }, "/alias")
        const before = yield* caller.stat("/file")
        const handle = yield* caller.open("/file", { access: "readwrite", truncateCursor: "clamp" })
        yield* handle.seek({ from: "start", offset: 9n })
        yield* TestClock.adjust("2 seconds")
        const attributes = { size: 4n, mode: 0o600, atime: "now", mtime: DateTime.unixNanoFromNanoseconds(-1n) } as const
        if (boundary === "caller") yield* caller.setAttributes("/file", attributes)
        else if (boundary === "operation") {
          const operation = yield* caller.acquireOperation()
          yield* operation.files.setAttributes("/file", attributes)
        } else if (boundary === "handle") yield* handle.setAttributes(attributes)
        else if (boundary === "sync") {
          const sync = yield* caller.acquireSync
          yield* Effect.fromResult(sync.setAttributes("/file", attributes))
        } else {
          const sync = yield* handle.sync()
          yield* Effect.fromResult(sync.setAttributes(attributes))
        }
        const after = yield* handle.stat()
        assert.isTrue(VFS.equalsObjectReference(before.reference, after.reference))
        assert.isTrue(VFS.equalsObjectReference(after.reference, yield* caller.lookup("/alias")))
        assert.strictEqual(after.metadata.size, 4n)
        assert.strictEqual(after.metadata.mode, 0o600)
        assert.strictEqual(after.metadata.atime, 2_000_000_000n)
        assert.strictEqual(after.metadata.mtime, -1n)
        assert.strictEqual(after.metadata.ctime, 2_000_000_000n)
        assert.strictEqual(after.metadata.birthtime, before.metadata.birthtime)
        assert.strictEqual(yield* handle.position(), 9n)
        assert.deepStrictEqual(yield* caller.readFile("/alias"), new Uint8Array([1, 2, 0, 0]))
        yield* caller.setAttributes("/file", { size: 1n })
        assert.deepStrictEqual(yield* caller.readFile("/alias"), new Uint8Array([1]))
        assert.strictEqual(yield* handle.position(), 9n)
      }).pipe(withClock))
  }

  it.effect("should check metadata ownership before write access and publish nothing on denial", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make()
      const admin = yield* owner.authorize({ credentials })
      yield* admin.writeFile("/file", new Uint8Array([1, 2]), { mode: 0o444 })
      const caller = yield* owner.authorize({ credentials: { uid: 7, gid: 7 } })
      const before = yield* admin.stat("/file")
      const usage = yield* owner.usage
      const error = yield* Effect.flip(caller.setAttributes("/file", { size: 0n, mode: 0o600 }))
      assert.strictEqual(error._tag, "AccessDenied")
      if (error._tag === "AccessDenied") assert.strictEqual(error.reason, "ownership")
      assert.deepStrictEqual(yield* admin.stat("/file"), before)
      assert.deepStrictEqual(yield* owner.usage, usage)
      assert.deepStrictEqual(yield* admin.readFile("/file"), new Uint8Array([1, 2]))
    }).pipe(withClock))

  it.effect("should authorize resize against the original mode before applying a new mode", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make()
      const admin = yield* owner.authorize({ credentials })
      yield* admin.setAttributes("/", { mode: 0o777 })
      const caller = yield* owner.authorize({ credentials: { uid: 7, gid: 7 } })
      yield* caller.createFile("/file", { mode: 0o400 })
      const before = yield* caller.stat("/file")
      const error = yield* Effect.flip(caller.setAttributes("/file", { size: 1n, mode: 0o600 }))
      assert.strictEqual(error._tag, "AccessDenied")
      if (error._tag === "AccessDenied") assert.strictEqual(error.reason, "permission")
      assert.deepStrictEqual(yield* caller.stat("/file"), before)
    }).pipe(withClock))

  it.effect("should use a handle's open-time write grant and reject resize through a read-only handle", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make()
      const admin = yield* owner.authorize({ credentials })
      yield* admin.writeFile("/file", new Uint8Array([1, 2]))
      yield* admin.setAttributes("/file", { mode: 0o666 })
      const caller = yield* owner.authorize({ credentials: { uid: 7, gid: 7 } })
      const read = yield* caller.open("/file")
      const write = yield* caller.open("/file", { access: "write" })
      const before = yield* admin.stat("/file")
      assert.strictEqual((yield* Effect.flip(read.setAttributes({ size: 0n })))._tag, "AccessDenied")
      assert.deepStrictEqual(yield* admin.stat("/file"), before)
      yield* admin.setAttributes("/file", { mode: 0o444 })
      assert.strictEqual((yield* Effect.flip(caller.setAttributes("/file", { size: 1n })))._tag, "AccessDenied")
      yield* write.setAttributes({ size: 1n })
      assert.strictEqual((yield* write.stat()).metadata.size, 1n)
    }).pipe(withClock))

  for (const domain of ["file", "content", "transient"] as const) {
    it.effect(`should roll back all resize attributes when the ${domain} limit is exceeded`, () =>
      Effect.gen(function*() {
        const limits = domain === "file" ? { fileBytes: 2 } : domain === "content" ? { contentBytes: 2 } : { transientBytes: 16 }
        const owner = yield* VFS.make({ limits })
        const caller = yield* owner.authorize({ credentials })
        yield* caller.writeFile("/f", new Uint8Array([1, 2]))
        const before = yield* caller.stat("/f")
        const usage = yield* owner.usage
        yield* TestClock.adjust("1 second")
        const error = yield* Effect.flip(caller.setAttributes("/f", { size: 32n, mode: 0o600, atime: "now" }))
        assert.strictEqual(error._tag, "LimitExceeded")
        if (error._tag === "LimitExceeded") assert.strictEqual(error.domain, domain)
        assert.deepStrictEqual(yield* caller.stat("/f"), before)
        assert.deepStrictEqual(yield* owner.usage, usage)
        assert.deepStrictEqual(yield* caller.readFile("/f"), new Uint8Array([1, 2]))
      }).pipe(withClock))
  }

  it.effect("should use one clock sample for resize and current timestamps", () =>
    Effect.gen(function*() {
      const clock = yield* Clock.Clock
      let samples = 0
      const owner = yield* VFS.make().pipe(Effect.provideService(Clock.Clock, {
        ...clock,
        currentTimeNanosUnsafe: () => BigInt(++samples)
      }))
      const caller = yield* owner.authorize({ credentials })
      yield* caller.createFile("/file")
      const before = samples
      yield* caller.setAttributes("/file", { size: 2n, atime: "now", mtime: "now" })
      const metadata = (yield* caller.stat("/file")).metadata
      assert.strictEqual(samples, before + 1)
      assert.strictEqual(metadata.atime, BigInt(samples))
      assert.strictEqual(metadata.mtime, metadata.atime)
      assert.strictEqual(metadata.ctime, metadata.atime)
    }).pipe(withClock))

  it.effect("should apply metadata when the size is unchanged and preserve revisions for a complete no-op", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make()
      const caller = yield* owner.authorize({ credentials })
      yield* caller.createFile("/file")
      yield* caller.setAttributes("/file", { size: "0 B", mode: 0o600 })
      const before = yield* caller.stat("/file")
      assert.strictEqual(before.metadata.mode, 0o600)
      yield* caller.setAttributes("/file", { size: 0n, mode: 0o600 })
      assert.isTrue(VFS.equalsObjectRevision(before.revision, (yield* caller.stat("/file")).revision))
    }).pipe(withClock))

  it.effect("should retain stale revision guards without publishing resize or metadata", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make()
      const caller = yield* owner.authorize({ credentials })
      yield* caller.createFile("/file")
      const stale = yield* caller.stat("/file")
      yield* caller.writeFile("/file", new Uint8Array([1]))
      const before = yield* caller.stat("/file")
      const usage = yield* owner.usage
      const error = yield* Effect.flip(caller.setAttributes("/file", { size: 0n, mode: 0o600 }, {
        expectedRevision: stale.revision
      }))
      assert.strictEqual(error._tag, "ConditionFailed")
      assert.deepStrictEqual(yield* caller.stat("/file"), before)
      assert.deepStrictEqual(yield* owner.usage, usage)
    }).pipe(withClock))

  it.effect("should validate a size before resolving a missing path and reject non-file targets", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make()
      const caller = yield* owner.authorize({ credentials })
      assert.strictEqual((yield* Effect.flip(caller.setAttributes("/missing", { size: -1n })))._tag, "InvalidInput")
      yield* caller.makeSymlink("/link", "/")
      for (const path of ["/", "/link"]) {
        const error = yield* Effect.flip(caller.setAttributes(path, { size: 0n }, { followFinalSymlink: false }))
        assert.strictEqual(error._tag, "InvalidResource")
      }
    }).pipe(withClock))

  it.effect("should roll back resize and metadata when interrupted before publication", () =>
    Effect.gen(function*() {
      const clock = yield* Clock.Clock
      let interrupt: (() => void) | undefined
      const owner = yield* VFS.make().pipe(Effect.provideService(Clock.Clock, {
        ...clock,
        currentTimeNanosUnsafe: () => {
          interrupt?.()
          return clock.currentTimeNanosUnsafe()
        }
      }))
      const caller = yield* owner.authorize({ credentials })
      yield* caller.writeFile("/file", new Uint8Array([1, 2]))
      const before = yield* caller.stat("/file")
      const usage = yield* owner.usage
      yield* TestClock.adjust("1 second")
      const updating = yield* Effect.withFiber((fiber) => {
        interrupt = () => {
          interrupt = undefined
          fiber.interruptUnsafe()
        }
        return caller.setAttributes("/file", { size: 0n, mode: 0o600 })
      }).pipe(Effect.forkChild({ startImmediately: true }))
      assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(updating)))
      assert.deepStrictEqual(yield* caller.stat("/file"), before)
      assert.deepStrictEqual(yield* owner.usage, usage)
    }).pipe(withClock))
})


describe("atomic mkdir timestamps", () => {
  const times = {
    atime: DateTime.unixNanoFromNanoseconds(11n),
    mtime: DateTime.unixNanoFromNanoseconds(12n)
  }

  it.effect("should publish exact initial times with the original directory identity and parent change", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make()
      const caller = yield* owner.authorize({ credentials })
      const before = yield* caller.stat("/")
      yield* TestClock.adjust("1 second")
      const made = yield* caller.makeDirectory({ directory: "/", name: "child" }, { mode: 0o750, preserveTimes: times })
      const observed = yield* caller.stat("/child")
      assert.deepStrictEqual(observed, made)
      assert.strictEqual(observed.metadata.atime, 11n)
      assert.strictEqual(observed.metadata.mtime, 12n)
      assert.strictEqual(observed.metadata.ctime, 1000000000n)
      assert.strictEqual(observed.metadata.birthtime, 1000000000n)
      assert.strictEqual(observed.metadata.mode, 0o750)
      const parent = yield* caller.stat("/")
      assert.strictEqual(parent.metadata.atime, before.metadata.atime)
      assert.strictEqual(parent.metadata.mtime, 1000000000n)
      if (before.kind !== "directory" || parent.kind !== "directory") throw new Error("Expected directory")
      assert.isFalse(VFS.equalsNamespaceRevision(parent.namespaceRevision, before.namespaceRevision))
    }))

  for (const constrained of [false, true]) {
    it.effect(`should preserve only final recursive directory times with ${constrained ? "constrained" : "ordinary"} budgets`, () =>
      Effect.gen(function*() {
        const owner = yield* VFS.make(constrained ? { limits: { transientBytes: 11 } } : undefined)
        const caller = yield* owner.authorize({ credentials })
        yield* TestClock.adjust("1 second")
        const made = yield* caller.makeDirectory("/a/b", { recursive: true, preserveTimes: times })
        assert.strictEqual(made.metadata.atime, 11n)
        assert.strictEqual(made.metadata.mtime, 12n)
        const parent = yield* caller.stat("/a")
        assert.strictEqual(parent.metadata.atime, 1000000000n)
        assert.strictEqual(parent.metadata.mtime, 1000000000n)
        assert.strictEqual(parent.metadata.birthtime, 1000000000n)
      }))
  }

  it.effect("should apply final times through byte paths and terminal dot traversal", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make()
      const caller = yield* owner.authorize({ credentials })
      const made = yield* caller.makeDirectory(Result.getOrThrow(BytePath.fromString("/a/b/.")), {
        recursive: true, preserveTimes: times
      })
      assert.deepStrictEqual(made, yield* caller.stat("/a/b"))
      assert.strictEqual(made.metadata.atime, 11n)
      assert.strictEqual((yield* caller.stat("/a")).metadata.atime, 0n)
    }))

  it.effect("should leave existing final directories unchanged and retain ordinary creation defaults", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make()
      const caller = yield* owner.authorize({ credentials })
      yield* caller.makeDirectory("/existing")
      const before = yield* caller.stat("/existing")
      const parent = yield* caller.stat("/")
      yield* TestClock.adjust("1 second")
      assert.deepStrictEqual(yield* caller.makeDirectory("/existing", { recursive: true, preserveTimes: times }), before)
      assert.deepStrictEqual(yield* caller.stat("/"), parent)
      const ordinary = yield* caller.makeDirectory("/ordinary")
      assert.strictEqual(ordinary.metadata.atime, 1000000000n)
      assert.strictEqual(ordinary.metadata.mtime, 1000000000n)
    }))

  it.effect("should return preserved times through directory-entry creation and operation sessions", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make()
      const caller = yield* owner.authorize({ credentials })
      const entry = yield* caller.makeDirectoryEntry({ directory: "/", name: "entry" }, { preserveTimes: times })
      assert.strictEqual(entry.object.metadata.atime, 11n)
      assert.strictEqual(entry.object.metadata.mtime, 12n)
      const operation = yield* caller.acquireOperation()
      const made = yield* operation.files.makeDirectory("/session", { preserveTimes: times })
      assert.strictEqual(made.metadata.atime, 11n)
      assert.strictEqual(made.metadata.mtime, 12n)
    }))

  it.effect("should reject invalid timestamp records without publishing recursive prefixes", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make()
      const caller = yield* owner.authorize({ credentials })
      const before = yield* caller.stat("/")
      const usage = yield* owner.usage
      for (const invalid of [null, {}, { atime: 11n }, { atime: 11n, mtime: "now" }, { ...times, extra: true }]) {
        const options: VFS.MkdirOptions = { recursive: true }
        Object.defineProperty(options, "preserveTimes", { value: invalid })
        assert.strictEqual((yield* Effect.flip(caller.makeDirectory("/a/b", options)))._tag, "InvalidInput")
        assert.deepStrictEqual(yield* caller.stat("/"), before)
        assert.deepStrictEqual(yield* owner.usage, usage)
      }
    }))

  it.effect("should preserve stale parent conditions without changing existing directories", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make()
      const caller = yield* owner.authorize({ credentials })
      const root = yield* caller.stat("/")
      if (root.kind !== "directory") throw new Error("Expected directory")
      yield* caller.makeDirectory("/other")
      const before = yield* caller.stat("/")
      const error = yield* Effect.flip(caller.makeDirectory("/child", {
        preserveTimes: times, conditions: { parentNamespace: root.namespaceRevision }
      }))
      assert.strictEqual(error._tag, "ConditionFailed")
      assert.deepStrictEqual(yield* caller.stat("/"), before)
      assert.strictEqual((yield* Effect.flip(caller.stat("/child")))._tag, "NotFound")
    }))

  it.effect("should roll back recursive creation and timestamps when entry capacity is exceeded", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make({ limits: { entries: 1 } })
      const caller = yield* owner.authorize({ credentials })
      const before = yield* caller.stat("/")
      const usage = yield* owner.usage
      assert.strictEqual((yield* Effect.flip(caller.makeDirectory("/a/b", { recursive: true, preserveTimes: times })))._tag, "LimitExceeded")
      assert.deepStrictEqual(yield* caller.stat("/"), before)
      assert.deepStrictEqual(yield* owner.usage, usage)
      assert.strictEqual((yield* Effect.flip(caller.stat("/a")))._tag, "NotFound")
    }))

  it.effect("should enforce parent permissions before publishing timestamps or entries", () =>
    Effect.gen(function*() {
      const owner = yield* VFS.make()
      const admin = yield* owner.authorize({ credentials })
      const guest = yield* owner.authorize({ credentials: { uid: 1, gid: 1 } })
      yield* admin.makeDirectory("/locked", { mode: 0o555 })
      const before = yield* admin.stat("/locked")
      assert.strictEqual((yield* Effect.flip(guest.makeDirectory("/locked/child", { preserveTimes: times })))._tag, "AccessDenied")
      assert.deepStrictEqual(yield* admin.stat("/locked"), before)
      assert.strictEqual((yield* Effect.flip(admin.stat("/locked/child")))._tag, "NotFound")
    }))

  it.effect("should roll back initial timestamps and prefixes when interrupted before publication", () =>
    Effect.gen(function*() {
      const clock = yield* Clock.Clock
      let interrupt: (() => void) | undefined
      const owner = yield* VFS.make().pipe(Effect.provideService(Clock.Clock, {
        ...clock,
        currentTimeNanosUnsafe: () => {
          interrupt?.()
          return clock.currentTimeNanosUnsafe()
        }
      }))
      const caller = yield* owner.authorize({ credentials })
      const before = yield* caller.stat("/")
      const usage = yield* owner.usage
      const creating = yield* Effect.withFiber((fiber) => {
        interrupt = () => {
          interrupt = undefined
          fiber.interruptUnsafe()
        }
        return caller.makeDirectory("/a/b", { recursive: true, preserveTimes: times })
      }).pipe(Effect.forkChild({ startImmediately: true }))
      assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(creating)))
      assert.deepStrictEqual(yield* caller.stat("/"), before)
      assert.deepStrictEqual(yield* owner.usage, usage)
      assert.strictEqual((yield* Effect.flip(caller.stat("/a")))._tag, "NotFound")
    }))
})
