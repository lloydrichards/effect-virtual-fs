import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Effect } from "effect"
import { Testing, VirtualFileSystem as Vfs } from "../src/index.js"

const name = (value: string) => new TextEncoder().encode(value)

describe("reference mutation regressions", () => {
  it.effect("preserves invalid path encoding for symbolic-link targets", () =>
    Effect.gen(function*() {
      const caller = yield* Vfs.Caller
      const root = yield* caller.root

      const error = yield* Effect.flip(caller.symlink("\ud800", Vfs.Entry(root, name("link"))))

      assert.strictEqual(error.code, "InvalidPathEncoding")
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("rejects initial timestamps when child creation is disabled", () =>
    Effect.gen(function*() {
      const caller = yield* Vfs.Caller
      const root = yield* caller.root

      const times = {
        access: { kind: "value" as const, nanoseconds: 1n },
        modification: { kind: "value" as const, nanoseconds: 2n }
      }

      const omitted = yield* Effect.flip(caller.open(Vfs.Entry(root, name("missing")), {
        access: "read",
        times
      }))

      const never = yield* Effect.flip(caller.open(Vfs.Entry(root, name("missing")), {
        access: "read",
        create: "never",
        times
      }))

      assert.strictEqual(omitted.code, "InvalidArgument")
      assert.strictEqual(never.code, "InvalidArgument")
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("applies the total-path limit to symlink expansion, not the reference name", () =>
    Effect.gen(function*() {
      const caller = yield* Vfs.Caller
      const root = yield* caller.root

      const target = yield* caller.open(Vfs.Entry(root, name("x")), {
        access: "readWrite",
        create: "exclusive"
      })

      yield* target.handle.close
      yield* caller.symlink("x", Vfs.Entry(root, name("long-name")))

      const opened = yield* caller.open(Vfs.Entry(root, name("long-name")), { access: "read" })

      assert.strictEqual(opened.reference, target.reference)
      yield* opened.handle.close
    }).pipe(Effect.provide(Testing.layer({ volume: { maxPathBytes: ByteSize.bytes(1) } }))))

  it.effect("creates through a dangling final symlink and reports the target directory change", () =>
    Effect.gen(function*() {
      const caller = yield* Vfs.Caller
      const root = yield* caller.root
      const target = yield* caller.mkdir(Vfs.Entry(root, name("target")))
      yield* caller.symlink("/target/new", Vfs.Entry(root, name("link")))
      const rootBefore = (yield* caller.readDirectory(root)).revision
      const targetBefore = (yield* caller.readDirectory(target.reference)).revision

      const opened = yield* caller.open(Vfs.Entry(root, name("link")), {
        access: "readWrite",
        create: "ifMissing"
      })

      assert.isTrue(opened.created)
      assert.strictEqual(opened.directory.before, targetBefore)
      assert.isTrue(opened.directory.after > opened.directory.before)
      assert.strictEqual((yield* caller.readDirectory(root)).revision, rootBefore)
      assert.strictEqual(yield* caller.lookup(Vfs.Entry(target.reference, name("new"))), opened.reference)
      yield* opened.handle.close
    }).pipe(Effect.provide(Testing.layer())))
})
