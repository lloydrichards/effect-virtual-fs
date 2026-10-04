import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { Testing, VirtualFileSystem as Vfs } from "../src/index.js"
import { pathText } from "./support/text.js"

const bytes = (value: string) => new TextEncoder().encode(value)

const options = { access: "write", create: "exclusive" } as const

const rendered = (changes: ReadonlyArray<Vfs.Change>) =>
  Effect.forEach(changes, (change) => Effect.map(pathText(change.path), (path) => `${change._tag} ${path}`))

const setup = Effect.gen(function*() {
  const owner = yield* Vfs.Caller
  yield* owner.mkdir("/tenant/dir", { recursive: true })
  yield* owner.mkdir("/outside")
  yield* owner.writeFile("/tenant/file", bytes("initial"), options)

  return { owner, caller: yield* owner.withRoot("/tenant") }
})

describe("caller watch", () => {
  it.layer(BunCrypto.layer)((it) => {
    it.effect("filters outside changes before bounded capacity and rebases inside names", () =>
      Effect.gen(function*() {
        const { owner, caller } = yield* setup
        const stream = yield* caller.watch("/")

        for (let index = 0; index < 12; index++) yield* owner.mkdir(`/outside/${index}`)
        yield* owner.mkdir("/tenant/visible")
        assert.deepStrictEqual(yield* rendered(yield* Stream.runCollect(Stream.take(stream, 1))), ["Create /visible"])
      }).pipe(Effect.provide(Testing.layer({ volume: { maxWatchEvents: 3 } }))))

    it.effect("rebases queued events at publication across a later root rename", () =>
      Effect.gen(function*() {
        const { owner, caller } = yield* setup
        const stream = yield* caller.watch("/")
        yield* owner.mkdir("/tenant/before")
        yield* owner.rename("/tenant", "/moved")
        yield* owner.mkdir("/moved/after")
        assert.deepStrictEqual(yield* rendered(yield* Stream.runCollect(Stream.take(stream, 2))), [
          "Create /before",
          "Create /after"
        ])
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("reports all authorized file aliases while excluding outside hard links", () =>
      Effect.gen(function*() {
        const { owner, caller } = yield* setup
        yield* owner.link("/tenant/file", "/tenant/alias")
        yield* owner.link("/tenant/file", "/outside/alias")
        const stream = yield* caller.watch("/file")
        yield* owner.writeFile("/tenant/file", bytes("changed"), { access: "write" })
        assert.deepStrictEqual((yield* rendered(yield* Stream.runCollect(Stream.take(stream, 2)))).sort(), [
          "Update /alias",
          "Update /file"
        ])
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("reports removal when one watched hard-link alias is replaced by rename", () =>
      Effect.gen(function*() {
        const { owner, caller } = yield* setup
        yield* owner.link("/tenant/file", "/tenant/alias")
        yield* owner.writeFile("/tenant/source", bytes("replacement"), options)
        const stream = yield* caller.watch("/file")
        const resolved = yield* caller.watch("/file", { alias: "resolved" })
        yield* owner.rename("/tenant/source", "/tenant/file")
        yield* owner.writeFile("/tenant/alias", bytes("changed"), { access: "write" })
        yield* owner.remove("/tenant/alias")
        assert.deepStrictEqual(yield* rendered(yield* Stream.runCollect(stream)), [
          "Remove /file",
          "Update /alias",
          "Remove /alias"
        ])
        assert.deepStrictEqual(yield* rendered(yield* Stream.runCollect(resolved)), ["Remove /file"])
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("resolved watches follow the selected alias through rename and end on its unlink", () =>
      Effect.gen(function*() {
        const { owner, caller } = yield* setup
        yield* owner.link("/tenant/file", "/tenant/alias")
        const stream = yield* caller.watch("/file", { alias: "resolved" })
        yield* owner.rename("/tenant/file", "/tenant/renamed")
        yield* owner.writeFile("/tenant/alias", bytes("changed"), { access: "write" })
        yield* owner.remove("/tenant/renamed")
        assert.deepStrictEqual(yield* rendered(yield* Stream.runCollect(stream)), [
          "Remove /file",
          "Create /renamed",
          "Update /renamed",
          "Remove /renamed"
        ])
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("resolved watches do not select another alias when the original name is unlinked", () =>
      Effect.gen(function*() {
        const { owner, caller } = yield* setup
        yield* owner.link("/tenant/file", "/tenant/alias")
        const stream = yield* caller.watch("/file", { alias: "resolved" })
        yield* owner.remove("/tenant/file")
        yield* owner.link("/tenant/alias", "/tenant/file")
        assert.deepStrictEqual(yield* rendered(yield* Stream.runCollect(stream)), ["Remove /file"])
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("ends with the last confined name when the watched object moves outside", () =>
      Effect.gen(function*() {
        const { owner, caller } = yield* setup
        const stream = yield* caller.watch("/dir")
        yield* owner.mkdir("/tenant/dir/child")
        yield* owner.rename("/tenant/dir", "/outside/dir")
        yield* owner.rename("/outside/dir", "/tenant/returned")
        assert.deepStrictEqual(yield* rendered(yield* Stream.runCollect(stream)), [
          "Create /dir/child",
          "Remove /dir"
        ])
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("drains already authorized events before root removal reports ClosedCaller", () =>
      Effect.gen(function*() {
        const { owner, caller } = yield* setup
        const stream = yield* caller.watch("/")
        yield* owner.mkdir("/tenant/queued")
        yield* owner.remove("/tenant", { recursive: true })
        const first = yield* Stream.runCollect(Stream.take(stream, 1))
        assert.deepStrictEqual(yield* rendered(first), ["Create /queued"])
        assert.strictEqual((yield* Effect.flip(Stream.runDrain(stream))).code, "ClosedCaller")
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("fails nested watches when their root leaves the ancestor boundary", () =>
      Effect.gen(function*() {
        const { owner, caller } = yield* setup
        const nested = yield* caller.withRoot("/dir")
        const stream = yield* nested.watch("/")
        yield* owner.rename("/tenant/dir", "/outside/dir")
        assert.strictEqual((yield* Effect.flip(Stream.runDrain(stream))).code, "AccessDenied")
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("bounds terminal hard-link alias removal with one Rescan", () =>
      Effect.gen(function*() {
        const { owner, caller } = yield* setup

        for (let index = 0; index < 8; index++) yield* owner.link("/tenant/file", `/tenant/dir/alias-${index}`)
        yield* owner.remove("/tenant/file")
        const stream = yield* caller.watch("/dir/alias-0")
        yield* owner.remove("/tenant/dir", { recursive: true })
        const events = yield* Stream.runCollect(stream)
        assert.strictEqual(events.length, 1)
        assert.strictEqual(events[0]!._tag, "Rescan")
        assert.strictEqual(yield* pathText(events[0]!.path), "/dir/alias-7")
      }).pipe(Effect.provide(Testing.layer({ volume: { maxWatchEvents: 3 } }))))

    it.effect("applies recursive depth to directory children at publication", () =>
      Effect.gen(function*() {
        const { owner, caller } = yield* setup
        const recursive = yield* caller.watch("/")
        const shallow = yield* caller.watch("/", { recursive: false })
        yield* owner.mkdir("/tenant/direct")
        yield* owner.mkdir("/tenant/dir/deep")
        yield* owner.remove("/tenant/dir", { recursive: true })
        assert.deepStrictEqual(yield* rendered(yield* Stream.runCollect(Stream.take(recursive, 4))), [
          "Create /direct",
          "Create /dir/deep",
          "Remove /dir/deep",
          "Remove /dir"
        ])
        assert.deepStrictEqual(yield* rendered(yield* Stream.runCollect(Stream.take(shallow, 2))), [
          "Create /direct",
          "Remove /dir"
        ])
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("resolved file aliases follow ancestor identity through directory renames", () =>
      Effect.gen(function*() {
        const { owner, caller } = yield* setup
        yield* owner.rename("/tenant/file", "/tenant/dir/file")
        yield* owner.link("/tenant/dir/file", "/tenant/alias")
        const stream = yield* caller.watch("/dir/file", { alias: "resolved" })
        yield* owner.rename("/tenant/dir", "/tenant/renamed")
        yield* owner.writeFile("/tenant/alias", bytes("changed"), { access: "write" })
        yield* owner.remove("/tenant/renamed/file")
        assert.deepStrictEqual(yield* rendered(yield* Stream.runCollect(stream)), [
          "Update /renamed/file",
          "Remove /renamed/file"
        ])
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("retains imported handle authority while publishing another caller's authorized alias", () =>
      Effect.gen(function*() {
        const { owner, caller } = yield* setup
        yield* owner.mkdir("/second")
        yield* owner.link("/tenant/file", "/second/file")
        const second = yield* owner.withRoot("/second")
        const handle = yield* caller.open("/file", { access: "read" })
        const stream = yield* second.watch(handle)
        yield* owner.writeFile("/tenant/file", bytes("changed"), { access: "write" })
        yield* owner.remove("/tenant/file")
        assert.deepStrictEqual(yield* rendered(yield* Stream.runCollect(stream)), [
          "Update /file",
          "Remove /file"
        ])
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("reports imported ancestor boundary loss after queued events drain", () =>
      Effect.gen(function*() {
        const { owner, caller } = yield* setup
        yield* owner.mkdir("/second")
        yield* owner.rename("/tenant/file", "/tenant/dir/file")
        yield* owner.link("/tenant/dir/file", "/second/file")
        const nested = yield* caller.withRoot("/dir")
        const second = yield* owner.withRoot("/second")
        const handle = yield* nested.open("/file", { access: "read" })
        const stream = yield* second.watch(handle)
        yield* owner.writeFile("/tenant/dir/file", bytes("changed"), { access: "write" })
        yield* owner.rename("/tenant/dir", "/outside/dir")
        assert.deepStrictEqual(yield* rendered(yield* Stream.runCollect(Stream.take(stream, 1))), ["Update /file"])
        assert.strictEqual((yield* Effect.flip(Stream.runDrain(stream))).code, "AccessDenied")
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("rejects resolved file references without a selected alias", () =>
      Effect.gen(function*() {
        const { caller } = yield* setup
        const reference = yield* caller.lookup("/file")
        assert.strictEqual((yield* Effect.flip(caller.watch(reference, { alias: "resolved" }))).code, "InvalidArgument")
      }).pipe(Effect.provide(Testing.layer())))
  })
})
