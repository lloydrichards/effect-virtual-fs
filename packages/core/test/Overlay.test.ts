import { assert, describe } from "@effect/vitest"
import { ByteSize, Deferred, Effect, Exit, Fiber, Predicate, Scope, Stream } from "effect"
import { VirtualFileSystem as Vfs } from "../src/index.js"
import { withVolumeTestSeams } from "../src/internal/testSeams.js"

const bytes = (value: string) => new TextEncoder().encode(value)

const text = (value: Uint8Array) => new TextDecoder().decode(value)

const pathText = (path: Vfs.BytePath) => Vfs.pathToBytes(path).pipe(Effect.map(text))

const changePaths = (changes: ReadonlyArray<Vfs.OverlayChange>) =>
  Effect.forEach(changes, (change): Effect.Effect<string, Vfs.FsError> => {
    if (Predicate.isTagged("Renamed")(change)) {
      return Effect.all({ from: pathText(change.from), to: pathText(change.to) }).pipe(
        Effect.map(({ from, to }) => `${change._tag}:${from}->${to}`)
      )
    }

    return pathText(change.path).pipe(Effect.map((path) => `${change._tag}:${path}`))
  })

import { it } from "./TestEffect.js"

describe("overlay volumes", () => {
  it.effect("is an ordinary Volume with an isolated base and sibling namespace", () =>
    Effect.gen(function*() {
      const source = yield* Vfs.fromFixture({
        entries: [
          { kind: "file", path: "/shared", bytes: bytes("base") },
          { kind: "hardLink", path: "/alias", target: "/shared" }
        ]
      })

      const base = yield* source.snapshot
      const first = yield* Vfs.makeOverlay(base)
      const second = yield* Vfs.makeOverlay(base)
      const ordinary: Vfs.Volume = first
      const a = yield* ordinary.caller()
      const b = yield* second.caller()

      const old = yield* a.open("/shared", { access: "readWrite" })
      yield* old.pwrite(bytes("X"), 1n)
      yield* a.chmod("/alias", 0o600)
      yield* a.rename("/shared", "/moved")

      assert.strictEqual(text(yield* a.readFile("/alias")), "bXse")
      assert.strictEqual(text(yield* old.pread(4, 0n)), "bXse")
      assert.strictEqual((yield* a.stat("/alias")).ino, (yield* a.stat("/moved")).ino)
      assert.strictEqual(text(yield* b.readFile("/shared")), "base")
      assert.strictEqual((yield* b.stat("/shared")).mode, 0o644)
      assert.strictEqual(text(yield* (yield* source.caller()).readFile("/shared")), "base")
    }))

  it.effect("keeps whole-volume quota semantics across promotion and short writes", () =>
    Effect.gen(function*() {
      const source = yield* Vfs.fromFixture({ entries: [{ kind: "file", path: "/f", bytes: bytes("abcd") }] })
      const base = yield* source.snapshot
      const tooSmall = yield* Effect.flip(Vfs.makeOverlay(base, { maxBytes: ByteSize.bytes(3) }))
      assert.instanceOf(tooSmall, Vfs.ImageError)
      assert.strictEqual(tooSmall.code, "LimitExceeded")

      const overlay = yield* Vfs.makeOverlay(base, { maxBytes: ByteSize.bytes(5) })
      const fs = yield* overlay.caller()
      const handle = yield* fs.open("/f", { access: "readWrite" })
      assert.strictEqual(yield* handle.pwrite(bytes("WXYZ"), 4n), 1)
      assert.strictEqual(text(yield* fs.readFile("/f")), "abcdW")
      assert.strictEqual(yield* handle.pwrite(bytes("Q"), 0n), 1)
      assert.strictEqual(text(yield* fs.readFile("/f")), "QbcdW")

      const before = yield* fs.stat("/f")
      const noSpace = yield* Effect.flip(fs.writeFile("/f", bytes("longer"), { access: "write", truncate: true }))
      assert.strictEqual(noSpace.code, "NoSpace")
      assert.deepStrictEqual(yield* fs.stat("/f"), before)
      assert.strictEqual(text(yield* fs.readFile("/f")), "QbcdW")
    }))

  it.effect(
    "isolates every whole-file content mutation path from the base and siblings",
    () =>
      Effect.gen(function*() {
        const base = yield* (yield* Vfs.fromFixture({
          entries: [{ kind: "file", path: "/f", bytes: bytes("abcd") }]
        })).snapshot

        const cases: ReadonlyArray<
          readonly [string, (fs: Vfs.Caller) => Effect.Effect<void, Vfs.FsError, Scope.Scope>]
        > = [
          ["handle write", (fs) =>
            Effect.gen(function*() {
              const file = yield* fs.open("/f", { access: "write" })
              yield* file.write(bytes("WXYZ"))
            })],
          ["append", (fs) =>
            Effect.gen(function*() {
              const file = yield* fs.open("/f", { access: "write", append: true })
              yield* file.write(bytes("!"))
            })],
          ["handle truncate", (fs) =>
            Effect.gen(function*() {
              const file = yield* fs.open("/f", { access: "write" })
              yield* file.truncate(2n)
            })],
          ["path truncate", (fs) => fs.truncate("/f", 2n)],
          ["writeFile", (fs) => fs.writeFile("/f", bytes("WXYZ"), { access: "write", truncate: true })],
          ["open truncate", (fs) => Effect.asVoid(fs.open("/f", { access: "write", truncate: true }))]
        ]

        for (const [label, mutate] of cases) {
          const changed = yield* Vfs.makeOverlay(base)
          const sibling = yield* Vfs.makeOverlay(base)
          yield* mutate(yield* changed.caller())
          assert.deepStrictEqual(yield* (yield* sibling.caller()).readFile("/f"), bytes("abcd"), label)
          assert.deepStrictEqual(
            yield* (yield* (yield* Vfs.fromSnapshot(base)).caller()).readFile("/f"),
            bytes("abcd"),
            label
          )
        }
      })
  )

  it.effect("charges unlinked open contents until the final handle closes", () =>
    Effect.gen(function*() {
      const base = yield* (yield* Vfs.fromFixture({
        entries: [{ kind: "file", path: "/held", bytes: bytes("abc") }]
      })).snapshot

      const overlay = yield* Vfs.makeOverlay(base, { maxBytes: ByteSize.bytes(3) })
      const fs = yield* overlay.caller()
      const scope = yield* Scope.make()
      const held = yield* fs.open("/held", { access: "read" }).pipe(Scope.provide(scope))
      yield* fs.unlink("/held")

      const blocked = yield* Effect.flip(
        fs.writeFile("/new", bytes("x"), { access: "write", create: "exclusive" })
      )

      assert.strictEqual(blocked.code, "NoSpace")
      assert.strictEqual(text(yield* held.pread(3, 0n)), "abc")
      yield* Scope.close(scope, Exit.void)
      yield* fs.writeFile("/new", bytes("x"), { access: "write", create: "exclusive" })
      assert.strictEqual(text(yield* fs.readFile("/new")), "x")
    }))

  it.effect("keeps permissions and rejects handles from another workspace", () =>
    Effect.gen(function*() {
      const base = yield* (yield* Vfs.fromFixture({
        entries: [{ kind: "file", path: "/private", bytes: bytes("secret"), metadata: { mode: 0o600, uid: 7 } }]
      })).snapshot

      const first = yield* Vfs.makeOverlay(base)
      const second = yield* Vfs.makeOverlay(base)
      const owner = yield* first.caller({ identity: { uid: 7, gid: 7, groups: [], privileged: false } })
      const stranger = yield* first.caller({ identity: { uid: 8, gid: 8, groups: [], privileged: false } })
      const foreign = yield* (yield* second.caller()).open("/private", { access: "read" })
      assert.strictEqual((yield* Effect.flip(stranger.readFile("/private"))).code, "AccessDenied")
      assert.strictEqual((yield* Effect.flip(owner.chmodHandle(foreign, 0o644))).code, "ForeignHandle")
      assert.strictEqual(text(yield* owner.readFile("/private")), "secret")
    }))

  it.effect("treats raw names and .wh. names literally", () =>
    Effect.gen(function*() {
      const raw = yield* Vfs.pathFromBytes(new Uint8Array([47, 255]))

      const base = yield* (yield* Vfs.fromFixture({
        entries: [
          { kind: "file", path: raw, bytes: bytes("raw") },
          { kind: "file", path: "/.wh.hidden", bytes: bytes("literal") }
        ]
      })).snapshot

      const overlay = yield* Vfs.makeOverlay(base)
      const fs = yield* overlay.caller()
      yield* fs.unlink(raw)
      yield* fs.writeFile("/.wh.hidden", bytes("changed"), { access: "write", truncate: true })
      const changes = yield* overlay.changes()
      const removed = changes.find(Predicate.isTagged("Removed"))
      assert.isDefined(removed)

      if (!Predicate.isTagged("Removed")(removed)) return yield* Effect.die("expected a removed change")
      assert.deepStrictEqual(yield* Vfs.pathToBytes(removed.path), new Uint8Array([47, 255]))
      assert.strictEqual(text(yield* fs.readFile("/.wh.hidden")), "changed")
      assert.deepStrictEqual(yield* changePaths(changes.filter((change) => !Predicate.isTagged("Removed")(change))), [
        "Updated:/.wh.hidden"
      ])
    }))

  it.effect(
    "should keep a complete capture stable when an existing alias handle later overwrites equal-sized content",
    () =>
      Effect.gen(function*() {
        const base = yield* (yield* Vfs.fromFixture({
          entries: [
            { kind: "file", path: "/f", bytes: bytes("base") },
            { kind: "hardLink", path: "/alias", target: "/f" }
          ]
        })).snapshot

        const overlay = yield* Vfs.makeOverlay(base)
        const fs = yield* overlay.caller()
        const preexistingAlias = yield* fs.open("/alias", { access: "readWrite" })
        yield* fs.writeFile("/f", bytes("edit"), { access: "write", truncate: true })
        const captured = yield* overlay.capture()
        yield* preexistingAlias.pwrite(bytes("LATE"), 0n)

        const capturedFs = yield* (yield* Vfs.fromSnapshot(captured.snapshot)).caller()
        assert.strictEqual(text(yield* capturedFs.readFile("/f")), "edit")
        assert.strictEqual(text(yield* capturedFs.readFile("/alias")), "edit")
        assert.deepStrictEqual(yield* changePaths(captured.changes), ["Updated:/alias", "Updated:/f"])
        const restoredOverlay = yield* Vfs.makeOverlay(captured.snapshot)
        assert.deepStrictEqual(yield* restoredOverlay.changes(), [])
        assert.strictEqual(text(yield* (yield* restoredOverlay.caller()).readFile("/f")), "edit")
      })
  )

  it.effect(
    "should block a rename while capture observes its matching snapshot and summary",
    () =>
      Effect.gen(function*() {
        const base = yield* (yield* Vfs.fromFixture({
          entries: [{ kind: "file", path: "/before", bytes: bytes("value") }]
        })).snapshot

        const observationReady = yield* Deferred.make<void>()
        const releaseObservation = yield* Deferred.make<void>()

        const betweenSnapshotAndSummary = Deferred.succeed(observationReady, undefined).pipe(
          Effect.andThen(Deferred.await(releaseObservation))
        )

        const overlay = yield* Vfs.makeOverlay(base)
        const fs = yield* overlay.caller()

        const captureFiber = yield* overlay.capture().pipe(
          withVolumeTestSeams({ betweenSnapshotAndSummary }),
          Effect.forkChild({ startImmediately: true })
        )

        yield* Deferred.await(observationReady)
        const renameStarted = yield* Deferred.make<void>()

        const renameFiber = yield* Deferred.succeed(renameStarted, undefined).pipe(
          Effect.andThen(fs.rename("/before", "/after")),
          Effect.forkChild({ startImmediately: true })
        )

        yield* Deferred.await(renameStarted)
        yield* Effect.yieldNow
        assert.isUndefined(renameFiber.pollUnsafe())
        yield* Deferred.succeed(releaseObservation, undefined)
        const captured = yield* Fiber.join(captureFiber)
        yield* Fiber.join(renameFiber)
        const capturedFs = yield* (yield* Vfs.fromSnapshot(captured.snapshot)).caller()
        assert.deepStrictEqual(yield* capturedFs.readDirectory("/"), ["before"])
        assert.deepStrictEqual(yield* changePaths(captured.changes), [])
      })
  )

  it.effect(
    "should block an equal-sized handle write while capture observes its matching snapshot and summary",
    () =>
      Effect.gen(function*() {
        const base = yield* (yield* Vfs.fromFixture({
          entries: [{ kind: "file", path: "/file", bytes: bytes("base") }]
        })).snapshot

        const observationReady = yield* Deferred.make<void>()
        const releaseObservation = yield* Deferred.make<void>()

        const betweenSnapshotAndSummary = Deferred.succeed(observationReady, undefined).pipe(
          Effect.andThen(Deferred.await(releaseObservation))
        )

        const overlay = yield* Vfs.makeOverlay(base)
        const fs = yield* overlay.caller()
        const handle = yield* fs.open("/file", { access: "readWrite" })

        const captureFiber = yield* overlay.capture().pipe(
          withVolumeTestSeams({ betweenSnapshotAndSummary }),
          Effect.forkChild({ startImmediately: true })
        )

        yield* Deferred.await(observationReady)
        const writeStarted = yield* Deferred.make<void>()

        const writeFiber = yield* Deferred.succeed(writeStarted, undefined).pipe(
          Effect.andThen(handle.pwrite(bytes("EDIT"), 0n)),
          Effect.forkChild({ startImmediately: true })
        )

        yield* Deferred.await(writeStarted)
        yield* Effect.yieldNow
        assert.isUndefined(writeFiber.pollUnsafe())
        yield* Deferred.succeed(releaseObservation, undefined)
        const captured = yield* Fiber.join(captureFiber)
        yield* Fiber.join(writeFiber)
        const capturedFs = yield* (yield* Vfs.fromSnapshot(captured.snapshot)).caller()
        assert.strictEqual(text(yield* capturedFs.readFile("/file")), "base")
        assert.deepStrictEqual(yield* changePaths(captured.changes), [])
      })
  )

  it.effect("should reject invalid summary options without changing workspace state", () =>
    Effect.gen(function*() {
      const base = yield* (yield* Vfs.fromFixture({ entries: [{ kind: "file", path: "/f", bytes: bytes("base") }] }))
        .snapshot

      const overlay = yield* Vfs.makeOverlay(base)

      // SAFETY: These deliberately malformed objects exercise runtime option validation.
      const invalid = [
        // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- Runtime validation requires an invalid typed input.
        { includeTimestamps: "yes" } as unknown as Vfs.OverlayChangesOptions,
        // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- Runtime validation requires an invalid typed input.
        { unexpected: true } as unknown as Vfs.OverlayChangesOptions
      ]

      for (const options of invalid) {
        assert.instanceOf(yield* Effect.flip(overlay.changes(options)), Vfs.ConfigurationError)
        assert.instanceOf(yield* Effect.flip(overlay.capture(options)), Vfs.ConfigurationError)
      }

      assert.deepStrictEqual(yield* overlay.changes(), [])
      assert.strictEqual(text(yield* (yield* overlay.caller()).readFile("/f")), "base")
    }))

  it.effect("should report an occupied destination rename through the overlay volume", () =>
    Effect.gen(function*() {
      const base = yield* (yield* Vfs.fromFixture({
        entries: [
          { kind: "file", path: "/from", bytes: bytes("moving") },
          { kind: "file", path: "/to", bytes: bytes("displaced") }
        ]
      })).snapshot

      const overlay = yield* Vfs.makeOverlay(base)
      yield* (yield* overlay.caller()).rename("/from", "/to")
      assert.deepStrictEqual(yield* changePaths(yield* overlay.changes()), [
        "Renamed:/from->/to",
        "Removed:/to"
      ])
    }))

  it.effect("should report both retained identities when overlay paths swap", () =>
    Effect.gen(function*() {
      const base = yield* (yield* Vfs.fromFixture({
        entries: [
          { kind: "file", path: "/a", bytes: bytes("one") },
          { kind: "file", path: "/b", bytes: bytes("two") }
        ]
      })).snapshot

      const overlay = yield* Vfs.makeOverlay(base)
      const fs = yield* overlay.caller()
      yield* fs.rename("/a", "/temporary")
      yield* fs.rename("/b", "/a")
      yield* fs.rename("/temporary", "/b")
      assert.deepStrictEqual(yield* changePaths(yield* overlay.changes()), [
        "Renamed:/a->/b",
        "Renamed:/b->/a"
      ])
    }))

  it.effect("should avoid guessing renames when every hard-link alias moves", () =>
    Effect.gen(function*() {
      const base = yield* (yield* Vfs.fromFixture({
        entries: [
          { kind: "file", path: "/a", bytes: bytes("shared") },
          { kind: "hardLink", path: "/b", target: "/a" }
        ]
      })).snapshot

      const overlay = yield* Vfs.makeOverlay(base)
      const fs = yield* overlay.caller()
      yield* fs.rename("/a", "/c")
      yield* fs.rename("/b", "/d")
      assert.deepStrictEqual(yield* changePaths(yield* overlay.changes()), [
        "Removed:/a",
        "Removed:/b",
        "Added:/c",
        "Added:/d"
      ])
    }))

  it.effect(
    "should report replacement when a path receives a new equal-content identity",
    () =>
      Effect.gen(function*() {
        const base = yield* (yield* Vfs.fromFixture({ entries: [{ kind: "file", path: "/x", bytes: bytes("same") }] }))
          .snapshot

        const overlay = yield* Vfs.makeOverlay(base)
        const fs = yield* overlay.caller()
        yield* fs.unlink("/x")
        yield* fs.writeFile("/x", bytes("same"), { access: "write", create: "exclusive" })
        assert.deepStrictEqual(yield* changePaths(yield* overlay.changes()), ["Replaced:/x"])
      })
  )

  it.effect("hides timestamp-only changes unless explicitly requested", () =>
    Effect.gen(function*() {
      const base = yield* (yield* Vfs.fromFixture({
        entries: [{ kind: "file", path: "/f", bytes: bytes("value") }]
      })).snapshot

      const overlay = yield* Vfs.makeOverlay(base)
      const fs = yield* overlay.caller()
      yield* fs.utimes("/f", {
        access: { kind: "value", nanoseconds: 10n },
        modification: { kind: "value", nanoseconds: 20n }
      })
      assert.deepStrictEqual(yield* overlay.changes(), [])
      assert.deepStrictEqual(yield* changePaths(yield* overlay.changes({ includeTimestamps: true })), ["Updated:/f"])
    }))

  it.effect("creates a fresh reset workspace without retargeting old resources", () =>
    Effect.gen(function*() {
      const base = yield* (yield* Vfs.fromFixture({ entries: [{ kind: "file", path: "/f", bytes: bytes("base") }] }))
        .snapshot

      const old = yield* Vfs.makeOverlay(base)
      const oldCaller = yield* old.caller()
      const oldHandle = yield* oldCaller.open("/f", { access: "readWrite" })

      const oldWatch = yield* (yield* old.watch).pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true })
      )

      const fresh = yield* Vfs.makeOverlay(base)
      const freshCaller = yield* fresh.caller()
      yield* freshCaller.writeFile("/f", bytes("new"), { access: "write", truncate: true })
      yield* Effect.yieldNow
      assert.isUndefined(oldWatch.pollUnsafe())
      yield* oldHandle.pwrite(bytes("X"), 0n)
      assert.strictEqual(text(yield* oldHandle.pread(4, 0n)), "Xase")
      assert.strictEqual(text(yield* oldCaller.readFile("/f")), "Xase")
      assert.strictEqual(text(yield* freshCaller.readFile("/f")), "new")
      assert.strictEqual((yield* Fiber.join(oldWatch)).length, 1)
    }))

  it.effect("reports an unambiguous alias rename", () =>
    Effect.gen(function*() {
      const base = yield* (yield* Vfs.fromFixture({
        entries: [
          { kind: "file", path: "/a", bytes: bytes("shared") },
          { kind: "hardLink", path: "/b", target: "/a" }
        ]
      })).snapshot

      const overlay = yield* Vfs.makeOverlay(base)
      yield* (yield* overlay.caller()).rename("/b", "/c")
      assert.deepStrictEqual(yield* changePaths(yield* overlay.changes()), ["Renamed:/b->/c"])
    }))

  it.effect("does not infer a rename from equal content", () =>
    Effect.gen(function*() {
      const base = yield* (yield* Vfs.fromFixture({ entries: [{ kind: "file", path: "/a", bytes: bytes("same") }] }))
        .snapshot

      const overlay = yield* Vfs.makeOverlay(base)
      const fs = yield* overlay.caller()
      yield* fs.unlink("/a")
      yield* fs.writeFile("/b", bytes("same"), { access: "write", create: "exclusive" })
      assert.deepStrictEqual(yield* changePaths(yield* overlay.changes()), ["Removed:/a", "Added:/b"])
    }))

  it.effect("reports one-sided alias changes", () =>
    Effect.gen(function*() {
      const single = yield* (yield* Vfs.fromFixture({ entries: [{ kind: "file", path: "/a", bytes: bytes("x") }] }))
        .snapshot

      const linked = yield* Vfs.makeOverlay(single)
      yield* (yield* linked.caller()).link("/a", "/b")
      assert.deepStrictEqual(yield* changePaths(yield* linked.changes()), ["Added:/b"])

      const aliased = yield* (yield* Vfs.fromFixture({
        entries: [
          { kind: "file", path: "/a", bytes: bytes("x") },
          { kind: "hardLink", path: "/b", target: "/a" }
        ]
      })).snapshot

      const unlinked = yield* Vfs.makeOverlay(aliased)
      yield* (yield* unlinked.caller()).unlink("/b")
      assert.deepStrictEqual(yield* changePaths(yield* unlinked.changes()), ["Removed:/b"])
    }))

  it.effect("omits a reverted edit", () =>
    Effect.gen(function*() {
      const base = yield* (yield* Vfs.fromFixture({ entries: [{ kind: "file", path: "/a", bytes: bytes("base") }] }))
        .snapshot

      const overlay = yield* Vfs.makeOverlay(base)
      const fs = yield* overlay.caller()
      yield* fs.writeFile("/a", bytes("edit"), { access: "write", truncate: true })
      yield* fs.writeFile("/a", bytes("base"), { access: "write", truncate: true })
      assert.deepStrictEqual(yield* overlay.changes(), [])
    }))

  it.effect("reports a new occupant at a rename source", () =>
    Effect.gen(function*() {
      const base = yield* (yield* Vfs.fromFixture({ entries: [{ kind: "file", path: "/a", bytes: bytes("moved") }] }))
        .snapshot

      const overlay = yield* Vfs.makeOverlay(base)
      const fs = yield* overlay.caller()
      yield* fs.rename("/a", "/b")
      yield* fs.writeFile("/a", bytes("new"), { access: "write", create: "exclusive" })
      assert.deepStrictEqual(yield* changePaths(yield* overlay.changes()), ["Added:/a", "Renamed:/a->/b"])
    }))

  it.effect("orders differences in a fixed sequence", () =>
    Effect.gen(function*() {
      const base = yield* (yield* Vfs.fromFixture({ entries: [{ kind: "file", path: "/a", bytes: bytes("v") }] }))
        .snapshot

      const overlay = yield* Vfs.makeOverlay(base)
      const fs = yield* overlay.caller()
      yield* fs.chmod("/a", 0o600)
      yield* fs.utimes("/a", {
        access: { kind: "value", nanoseconds: 10n },
        modification: { kind: "value", nanoseconds: 20n }
      })

      const plain = yield* overlay.changes()
      const timed = yield* overlay.changes({ includeTimestamps: true })
      const [first] = plain
      const [firstTimed] = timed
      assert.isDefined(first)
      assert.isDefined(firstTimed)

      if (!Predicate.isTagged("Updated")(first) || !Predicate.isTagged("Updated")(firstTimed)) {
        return yield* Effect.die("expected updated changes")
      }

      assert.deepStrictEqual(first.differences, ["mode"])
      // Explicit utimes values report atime and mtime; the chmod's ctime bump is not reported.
      assert.deepStrictEqual(firstTimed.differences, ["mode", "atimeNs", "mtimeNs"])
    }))

  it.effect("sorts changed paths bytewise", () =>
    Effect.gen(function*() {
      const base = yield* (yield* Vfs.fromFixture({ entries: [] })).snapshot
      const overlay = yield* Vfs.makeOverlay(base)
      const fs = yield* overlay.caller()

      for (const raw of [[47, 255], [47, 1, 1], [47, 1]]) {
        const path = yield* Vfs.pathFromBytes(new Uint8Array(raw))
        yield* fs.writeFile(path, bytes("x"), { access: "write", create: "exclusive" })
      }

      const changes = yield* overlay.changes()

      const paths = yield* Effect.forEach(changes, (change) =>
        Predicate.isTagged("Renamed")(change)
          ? Effect.die("expected path changes")
          : Effect.map(Vfs.pathToBytes(change.path), (value) => [...value]))

      assert.deepStrictEqual(paths, [[47, 1], [47, 1, 1], [47, 255]])
    }))

  it.effect("lists a directory and its descendants separately", () =>
    Effect.gen(function*() {
      const base = yield* (yield* Vfs.fromFixture({ entries: [] })).snapshot
      const overlay = yield* Vfs.makeOverlay(base)
      const fs = yield* overlay.caller()
      yield* fs.mkdir("/dir")
      yield* fs.writeFile("/dir/file", bytes("x"), { access: "write", create: "exclusive" })
      assert.deepStrictEqual(yield* changePaths(yield* overlay.changes()), ["Added:/dir", "Added:/dir/file"])
    }))

  it.effect("returns frozen changes", () =>
    Effect.gen(function*() {
      const base = yield* (yield* Vfs.fromFixture({ entries: [{ kind: "file", path: "/a", bytes: bytes("v") }] }))
        .snapshot

      const overlay = yield* Vfs.makeOverlay(base)
      const fs = yield* overlay.caller()
      yield* fs.chmod("/a", 0o600)
      yield* fs.mkdir("/dir")
      const changes = yield* overlay.changes()
      assert.strictEqual(changes.length, 2)
      assert.isTrue(Object.isFrozen(changes))
    }))

  it.effect("rejects an invalid overlay limit without touching the base", () =>
    Effect.gen(function*() {
      const base = yield* (yield* Vfs.fromFixture({ entries: [{ kind: "file", path: "/a", bytes: bytes("v") }] }))
        .snapshot

      const before = yield* Vfs.encodeSnapshot(base)
      // @ts-expect-error exercises runtime rejection of a value outside the public ByteSize contract
      assert.instanceOf(yield* Effect.flip(Vfs.makeOverlay(base, { maxBytes: -1 })), Vfs.ConfigurationError)
      assert.deepStrictEqual(yield* Vfs.encodeSnapshot(base), before)
    }))

  it.effect("lets observations run beside a capture while a change waits for it", () =>
    Effect.gen(function*() {
      const base = yield* (yield* Vfs.fromFixture({ entries: [{ kind: "file", path: "/a", bytes: bytes("v") }] }))
        .snapshot

      const overlay = yield* Vfs.makeOverlay(base)
      const fs = yield* overlay.caller()
      const held = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()

      const capturing = yield* overlay.capture().pipe(
        withVolumeTestSeams({
          betweenSnapshotAndSummary: Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release)))
        }),
        Effect.forkChild({ startImmediately: true })
      )

      yield* Deferred.await(held)
      assert.strictEqual((yield* fs.stat("/a")).kind, "file")
      const changing = yield* fs.mkdir("/dir").pipe(Effect.forkChild({ startImmediately: true }))

      for (let i = 0; i < 4; i++) yield* Effect.yieldNow
      assert.isUndefined(changing.pollUnsafe())
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(changing)
      assert.deepStrictEqual(yield* changePaths((yield* Fiber.join(capturing)).changes), [])
      assert.deepStrictEqual(yield* changePaths(yield* overlay.changes()), ["Added:/dir"])
    }))
})
