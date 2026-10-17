import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Effect, type Scope, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { VirtualFileSystem as Vfs } from "../../src/index.js"
import { describeTree } from "../support/describeTree.js"
import { hardLinkedSymlinks } from "../support/hardLinkedSymlinks.js"
import { entryNames, text } from "../support/text.js"

const bytes = (value: string) => new TextEncoder().encode(value)

const fixture: Vfs.Fixture = {
  ...hardLinkedSymlinks,
  entries: [
    ...hardLinkedSymlinks.entries,
    { kind: "hardLink", path: "/peer", target: "/a/target" },
    { kind: "directory", path: "/cache" },
    { kind: "file", path: "/cache/old", bytes: bytes("obsolete") }
  ]
}

const compare = Effect.fnUntraced(function*<A, E>(
  scenario: (caller: Vfs.Caller) => Effect.Effect<A, E, Scope.Scope>,
  options?: (usage: Vfs.VolumeUsage) => Vfs.VolumeOptions
) {
  yield* TestClock.setTime(0)
  const source = yield* Vfs.fromFixture(fixture)
  const base = yield* source.snapshot
  const limits = options?.(yield* source.usage)
  const overlay = yield* Vfs.makeOverlay(base, limits)
  const restored = yield* Vfs.fromSnapshot(base, limits)
  const outcomes = []

  for (const volume of [restored, overlay]) {
    yield* TestClock.setTime(1_000)
    const caller = yield* volume.caller()
    // Settle relatime reads before watching; observation must not masquerade as a mutation.
    yield* describeTree(caller)
    const watch = yield* volume.watch()
    const result = yield* scenario(caller)
    const state = yield* describeTree(caller)
    yield* caller.mkdir("/sentinel")

    const events = yield* watch.pipe(
      Stream.mapEffect((event) => Effect.map(Vfs.pathToBytes(event.path), (path) => `${event._tag} ${text(path)}`)),
      Stream.takeUntil((event) => event === "Create /sentinel"),
      Stream.runCollect
    )

    outcomes.push({ result, state, events, usage: yield* volume.usage })
  }

  assert.deepStrictEqual(outcomes[1], outcomes[0], "overlay differs from restored snapshot")

  return outcomes[1]!
})

describe("overlay parity with restored snapshots", () => {
  it.layer(BunCrypto.layer)((it) => {
    it.effect("should retain old handles and aliases when a file is edited, unlinked and recreated", () =>
      Effect.gen(function*() {
        const { result: observed } = yield* compare(Effect.fnUntraced(function*(caller) {
          const reference = yield* caller.lookup("/a/target")
          const old = yield* caller.open("/a/target", { access: "readWrite" })
          yield* old.pwrite(bytes("edited"), 0n)
          yield* caller.unlink("/a/target")
          yield* caller.writeFile("/a/target", bytes("fresh"), { access: "write", create: "exclusive" })

          return {
            old: text((yield* old.pread(16, 0n)).bytes),
            peer: text(yield* caller.readFile("/peer")),
            current: text(yield* caller.readFile("/a/link")),
            peerRetainsIdentity: (yield* caller.lookup("/peer")) === reference,
            recreatedHasNewIdentity: (yield* caller.lookup("/a/target")) !== reference
          }
        }))

        assert.deepStrictEqual(observed, {
          old: "edited",
          peer: "edited",
          current: "fresh",
          peerRetainsIdentity: true,
          recreatedHasNewIdentity: true
        })
      }))

    it.effect("should retain directory callers and relative links when a base directory moves", () =>
      Effect.gen(function*() {
        const { result: observed } = yield* compare(Effect.fnUntraced(function*(caller) {
          const directory = yield* caller.openDirectory("/c")
          const reference = yield* caller.lookup("/c")
          yield* caller.rename("/c", "/moved")

          return {
            relative: text(yield* caller.readFile(Vfs.Target.Path({ path: "link", relativeTo: directory }))),
            path: text(yield* caller.readFile("/moved/link")),
            sameDirectory: (yield* caller.lookup("/moved")) === reference,
            oldPath: (yield* Effect.flip(caller.stat("/c"))).code
          }
        }))

        assert.deepStrictEqual(observed, { relative: "c", path: "c", sameDirectory: true, oldPath: "NotFound" })
      }))

    it.effect("should keep replaced destination handles readable when renaming over a base file", () =>
      Effect.gen(function*() {
        const { result: observed } = yield* compare(Effect.fnUntraced(function*(caller) {
          const old = yield* caller.open("/b/target", { access: "read" })
          yield* caller.rename("/a/target", "/b/target")

          return {
            oldDestination: text((yield* old.pread(16, 0n)).bytes),
            currentDestination: text(yield* caller.readFile("/b/link")),
            missingSourceTarget: (yield* Effect.flip(caller.readFile("/a/link"))).code,
            peerSharesDestination: (yield* caller.lookup("/peer")) === (yield* caller.lookup("/b/target"))
          }
        }))

        assert.deepStrictEqual(observed, {
          oldDestination: "b",
          currentDestination: "a",
          missingSourceTarget: "NotFound",
          peerSharesDestination: true
        })
      }))

    it.effect("should keep deleted children absent when a base directory is removed and recreated", () =>
      Effect.gen(function*() {
        const { result: observed } = yield* compare(Effect.fnUntraced(function*(caller) {
          const old = yield* caller.lookup("/cache")
          yield* caller.unlink("/cache/old")
          yield* caller.rmdir("/cache")
          yield* caller.mkdir("/cache")

          return {
            names: entryNames(yield* caller.readDirectory("/cache")),
            missingChild: (yield* Effect.flip(caller.stat("/cache/old"))).code,
            staleDirectory: (yield* Effect.flip(caller.stat(old))).code,
            newIdentity: (yield* caller.lookup("/cache")) !== old
          }
        }))

        assert.deepStrictEqual(observed, {
          names: [],
          missingChild: "NotFound",
          staleDirectory: "StaleReference",
          newIdentity: true
        })
      }))

    it.effect("should leave state and watch events unchanged when mutations are rejected", () =>
      Effect.gen(function*() {
        const observed = yield* compare(Effect.fnUntraced(function*(caller) {
          const before = yield* describeTree(caller)
          const root = yield* caller.stat("/")

          const codes = [
            (yield* Effect.flip(caller.rename("/missing", "/a/target"))).code,
            (yield* Effect.flip(caller.mkdir("/a/target"))).code,
            (yield* Effect.flip(
              caller.writeFile("/a/target", bytes("wrong"), { access: "write", create: "exclusive" })
            )).code
          ]

          assert.deepStrictEqual(yield* describeTree(caller), before)
          assert.deepStrictEqual(yield* caller.stat("/"), root)

          return codes
        }))

        assert.deepStrictEqual(observed.result, ["NotFound", "AlreadyExists", "AlreadyExists"])
        assert.deepStrictEqual(observed.events, ["Create /sentinel"])
      }))

    it.effect("should retain the allowed prefix and reject further growth when a write reaches the byte quota", () =>
      Effect.gen(function*() {
        const { result: observed } = yield* compare(
          Effect.fnUntraced(function*(caller) {
            const handle = yield* caller.open("/a/target", { access: "readWrite" })
            const written = yield* handle.pwrite(bytes("WXYZ"), 1n)
            const before = yield* caller.stat("/a/target")
            const rejected = yield* Effect.flip(handle.pwrite(bytes("!"), 3n))
            assert.deepStrictEqual(yield* caller.stat("/a/target"), before)

            return {
              written,
              code: rejected.code,
              content: text(yield* caller.readFile("/a/target")),
              peer: text(yield* caller.readFile("/peer"))
            }
          }),
          (usage) => ({ maxBytes: ByteSize.bytes(Number(usage.usedBytes) + 2) })
        )

        assert.deepStrictEqual(observed, { written: 2, code: "NoSpace", content: "aWX", peer: "aWX" })
      }))
  })
})
