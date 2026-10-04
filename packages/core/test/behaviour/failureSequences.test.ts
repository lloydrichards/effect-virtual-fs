import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Effect, Schema, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { VirtualFileSystem as Vfs } from "../../src/index.js"
import { entryNames, pathText } from "../support/text.js"

const Slot = Schema.Literals([0, 1, 2])

const Command = Schema.Struct({
  operation: Schema.Literals(["create", "open", "close", "rename", "link", "unlink", "write"]),
  from: Slot,
  to: Slot
})

type Command = typeof Command.Type

const Script = Schema.Array(Command).check(Schema.isMaxLength(20))

const path = (slot: number) => `/f${slot}`

const bytes = (value: number) => new Uint8Array([value])

interface ObjectState {
  readonly reference: Vfs.ObjectReference
  value: number
}

// Every run exercises path reuse and last unlink; generated commands compose further transitions.
const identityMotif: ReadonlyArray<Command> = [
  { operation: "create", from: 0, to: 0 },
  { operation: "open", from: 0, to: 0 },
  { operation: "rename", from: 0, to: 1 },
  { operation: "create", from: 0, to: 0 },
  { operation: "write", from: 0, to: 1 },
  { operation: "link", from: 1, to: 2 },
  { operation: "unlink", from: 1, to: 0 },
  { operation: "unlink", from: 2, to: 0 }
]

const runIdentity = Effect.fnUntraced(function*(script: ReadonlyArray<Command>) {
  const volume = yield* Vfs.make()
  const caller = yield* volume.caller()
  const names = new Map<number, ObjectState>()
  const objects: Array<ObjectState> = []
  const handles = new Map<number, { object: ObjectState; handle: Vfs.FileHandle }>()
  const commands = [...identityMotif, ...script, { operation: "close", from: 0, to: 0 } as const]

  for (const [index, command] of commands.entries()) {
    const object = names.get(command.from)
    const retained = handles.get(command.from)

    switch (command.operation) {
      case "create": {
        if (object !== undefined) break
        const value = objects.length + 1
        yield* caller.writeFile(path(command.from), bytes(value), { access: "write", create: "exclusive" })
        const created = { reference: yield* caller.lookup(path(command.from)), value }
        assert.isTrue(objects.every((previous) => previous.reference !== created.reference))
        objects.push(created)
        names.set(command.from, created)
        break
      }

      case "open": {
        if (object === undefined || handles.has(command.to)) break
        const handle = yield* caller.open(path(command.from), { access: "readWrite" })
        handles.set(command.to, { object, handle })
        break
      }

      case "close": {
        if (retained === undefined) break
        yield* retained.handle.close
        handles.delete(command.from)
        assert.strictEqual((yield* Effect.flip(retained.handle.read(1))).code, "InvalidHandle")
        break
      }

      case "rename":
      case "link": {
        if (object === undefined || names.has(command.to)) break
        yield* caller[command.operation](path(command.from), path(command.to))
        names.set(command.to, object)

        if (command.operation === "rename") names.delete(command.from)
        break
      }

      case "unlink": {
        if (object === undefined) break
        yield* caller.unlink(path(command.from))
        names.delete(command.from)
        break
      }

      case "write": {
        if (retained === undefined) break
        const value = 40 + command.to
        assert.strictEqual(yield* retained.handle.pwrite(bytes(value), 0n), 1)
        retained.object.value = value
        break
      }
    }

    const context = `command ${index}: ${command.operation} ${command.from} ${command.to}`
    assert.deepStrictEqual(
      entryNames(yield* caller.readDirectory("/")).sort(),
      [...names.keys()].map((s) => `f${s}`).sort(),
      context
    )

    for (const slot of [0, 1, 2]) {
      const expected = names.get(slot)

      if (expected === undefined) {
        assert.strictEqual((yield* Effect.flip(caller.lookup(path(slot)))).code, "NotFound", context)
      } else {
        assert.strictEqual(yield* caller.lookup(path(slot)), expected.reference, context)
        assert.deepStrictEqual(yield* caller.readFile(path(slot)), bytes(expected.value), context)
      }
    }

    let alive = 0

    for (const expected of objects) {
      const links = [...names.values()].filter((value) => value === expected).length
      const held = [...handles.values()].filter((value) => value.object === expected)

      if (links === 0 && held.length === 0) {
        assert.strictEqual((yield* Effect.flip(caller.stat(expected.reference))).code, "StaleReference", context)
        continue
      }

      alive++
      assert.strictEqual((yield* caller.stat(expected.reference)).nlink, links, context)

      for (const { handle } of held) {
        assert.deepStrictEqual((yield* handle.pread(1, 0n)).bytes, bytes(expected.value), context)
      }

      if (links === 0) {
        assert.strictEqual(
          (yield* Effect.flip(caller.open(expected.reference, { access: "read" }))).code,
          "StaleReference",
          context
        )
      } else {
        assert.deepStrictEqual(yield* caller.readFile(expected.reference), bytes(expected.value), context)
      }
    }

    assert.deepStrictEqual(yield* volume.usage, { usedBytes: BigInt(alive), entries: names.size }, context)
  }

  for (const { handle } of handles.values()) yield* handle.close
  assert.deepStrictEqual(yield* volume.usage, { usedBytes: BigInt(new Set(names.values()).size), entries: names.size })
})

const Rejection = Schema.Literals(["create", "link", "rename", "chmod", "truncate", "write"])

const Rejections = Schema.Array(Rejection).check(Schema.isMaxLength(24))

const rejectionMotif: ReadonlyArray<typeof Rejection.Type> = ["create", "link", "rename", "chmod", "truncate", "write"]

const runRejections = Effect.fnUntraced(function*(script: ReadonlyArray<typeof Rejection.Type>) {
  // Freeze timestamps so equality detects mutation rather than elapsed test time.
  yield* TestClock.setTime(0)
  const volume = yield* Vfs.make({ maxBytes: ByteSize.bytes(2) })
  const caller = yield* volume.caller()
  yield* caller.writeFile("/f", new Uint8Array([1, 2]), { access: "write", create: "exclusive" })
  const handle = yield* caller.open("/f", { access: "readWrite" })
  yield* handle.seek(2n, "start")
  const root = yield* caller.root
  const reference = yield* caller.lookup("/f")

  const state = Effect.gen(function*() {
    const content = yield* caller.readFile("/f")
    const listing = yield* caller.readDirectory(root)

    return {
      content,
      listing,
      root: yield* caller.stat(root),
      file: yield* caller.stat(reference),
      cursor: yield* handle.seek(0n, "current"),
      usage: yield* volume.usage
    }
  })

  const rejected = {
    create: { effect: caller.open("/f", { access: "write", create: "exclusive" }), code: "AlreadyExists" },
    link: { effect: caller.link("/f", "/f"), code: "AlreadyExists" },
    rename: { effect: caller.rename("/missing", "/f"), code: "NotFound" },
    chmod: { effect: caller.chmod("/f", -1), code: "InvalidArgument" },
    truncate: { effect: handle.truncate(3n), code: "NoSpace" },
    write: { effect: handle.write(bytes(3)), code: "NoSpace" }
  }

  for (const [index, operation] of [...rejectionMotif, ...script].entries()) {
    yield* handle.pwrite(bytes(10 + index), 0n)
    yield* caller.chmod("/f", index % 2 === 0 ? 0o600 : 0o644)
    yield* Effect.scoped(Effect.gen(function*() {
      const watch = yield* volume.watch()
      const before = yield* state
      const { effect, code } = rejected[operation]
      const error = yield* Effect.flip(effect)
      const context = `command ${index}: ${operation}`
      assert.strictEqual(error.code, code, context)
      assert.deepStrictEqual(yield* state, before, context)
      // A later committed event makes an unexpected rejection event observable without a sleep.
      yield* caller.mkdir("/sentinel")
      const events = yield* Stream.runCollect(Stream.take(watch, 1))

      const rendered = yield* Effect.forEach(
        events,
        (event) => Effect.map(pathText(event.path), (path) => `${event._tag} ${path}`)
      )

      assert.deepStrictEqual(rendered, ["Create /sentinel"], context)
    }))
    yield* caller.rmdir("/sentinel")
  }

  yield* handle.close
})

describe("v1 failure sequences", () => {
  it.layer(BunCrypto.layer)((it) => {
    it.effect.prop(
      "should preserve object identity and retained content when generated names and handles change",
      { script: Script },
      ({ script }) => runIdentity(script),
      { arbitrary: { runs: 100, seed: 27701 } }
    )
    it.effect.prop(
      "should preserve committed state and emit no events when generated mutations are rejected",
      { script: Rejections },
      ({ script }) => runRejections(script),
      { arbitrary: { runs: 100, seed: 27702 } }
    )
  })
})
