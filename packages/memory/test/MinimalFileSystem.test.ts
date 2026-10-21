import { assert, it } from "@effect/vitest"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as FileSystemTest from "./FileSystemTest.js"
import * as Minimal from "./support/minimalFileSystem.js"

FileSystemTest.suite("private minimal engine", Minimal.layer, "memory", { watch: "unsupported" })

it.effect("minimal construction and copy need no Crypto provider and retain the seeded defaults", () =>
  Effect.gen(function*() {
    assert.isTrue(Option.isNone(yield* Effect.serviceOption(Crypto.Crypto)))
    const fs = yield* Minimal.make()
    assert.strictEqual(Option.getOrThrow((yield* fs.stat("/")).mtime).getTime(), 0)
    assert.strictEqual(Option.getOrThrow((yield* fs.stat("/tmp")).mtime).getTime(), 0)
    yield* fs.writeFileString("/tmp/source", "minimal")
    yield* fs.copy("/tmp/source", "/tmp/copy")
    assert.strictEqual(yield* fs.readFileString("/tmp/copy"), "minimal")
  }))
