/* oxlint-disable effecttsgo/async-function */
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { Effect } from "effect"
import { assert, test } from "vitest"
import * as Vfs from "../dist/VirtualFileSystem.js"

const directory = "/one/two/three/four/five/six/seven/eight"

const file = `${directory}/file`

const link = `${directory}/alias`

const batchSize = 64

const newFiles = Array.from({ length: batchSize }, (_, index) => `${directory}/new-${String(index).padStart(2, "0")}`)

const seed = new Uint8Array(4096).fill(0x40)

const initial = new Uint8Array(4096).fill(0x41)

const replacement = new Uint8Array(4096).fill(0x42)

const options = { access: "write", create: "ifMissing", truncate: true } as const

const workloads = [
  { name: "overwrite existing file", paths: Array<string>(batchSize).fill(file) },
  { name: "create new files", paths: newFiles },
  { name: "overwrite through symlink", paths: Array<string>(batchSize).fill(link) }
] as const

const rounds = workloads.flatMap((workload) =>
  Array.from({ length: 6 }, (_, index) => ({ ...workload, round: index + 1 }))
)

test.for(rounds)(
  "core 4 KiB whole-file write: $name (64 operations, round $round)",
  async ({ name, paths }, { bench }) => {
    let caller: Vfs.Caller

    const setup = Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const owner = yield* volume.caller()
      yield* owner.mkdir(directory, { recursive: true })

      if (name !== "create new files") yield* owner.writeFile(file, seed, options)

      if (name === "overwrite through symlink") yield* owner.symlink(file, link)

      return owner
    }).pipe(Effect.provide(NodeCrypto.layer))

    const batch = Effect.gen(function*() {
      for (const [index, path] of paths.entries()) {
        yield* caller.writeFile(path, index % 2 === 0 ? initial : replacement, options)
      }
    })

    const verify = Effect.gen(function*() {
      if (name === "create new files") {
        assert.strictEqual((yield* caller.readDirectory(directory)).value.length, batchSize)

        for (const [index, path] of paths.entries()) {
          assert.deepEqual(yield* caller.readFile(path), index % 2 === 0 ? initial : replacement)
        }

        return
      }

      assert.deepEqual(yield* caller.readFile(file), replacement)

      if (name === "overwrite through symlink") {
        assert.deepEqual(yield* caller.readLink(link), new TextEncoder().encode(file))
      }
    })

    await bench(name, {
      async: true,
      beforeEach: async () => {
        caller = await Effect.runPromise(setup)
      },
      afterEach: () => Effect.runPromise(verify)
    }, () => Effect.runPromise(batch)).run({
      time: 0,
      iterations: 1,
      warmupTime: 0,
      warmupIterations: 3,
      retainSamples: true
    })
  }
)
