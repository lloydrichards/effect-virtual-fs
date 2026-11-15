// Compare the explicit community baseline with the pinned upstream API. Ordinary core constructors use preview.
// Calls with incompatible shapes are deliberate runtime probes, not typed production adapters.
/* eslint-disable effecttsgo/node-builtin-import, effecttsgo/async-function, effecttsgo/any-unknown-in-error-context, effecttsgo/experimental-api-usage */
import { VirtualFileSystem as Current } from "../../dist/index.js"
import { makeCommunityVolume, VolumeSource, memoryCommitProvider } from "../../dist/internal/virtualFileSystem.js"

const Core = {
  ...Current,
  make: options => Effect.map(makeCommunityVolume(VolumeSource.Empty(), memoryCommitProvider, options), result => result.volume)
}

import { BytePath as PreviewPath, VirtualFileSystem as Preview } from "@effect-vfs/effect-preview"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { Effect, Result } from "effect"
import { isDeepStrictEqual } from "node:util"

const section = process.argv[2] ?? "core"

const comparisons = []

const outcome = async (program) => {
  try {
    const result = await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(NodeCrypto.layer), Effect.result))

    return Result.isFailure(result)
      ? { ok: false, error: { type: result.failure._tag, ...result.failure } }
      : { ok: true, value: result.success }
  } catch (cause) {
    return { ok: false, error: String(cause) }
  }
}

const compare = async (name, kind, baseline, preview) => {
  const old = await outcome(baseline)
  const next = await outcome(preview)
  comparisons.push({ name, kind, equivalent: old.ok && next.ok && isDeepStrictEqual(old.value, next.value), baseline: old, preview: next })
}

const legacy = (use) => Effect.gen(function*() {
  const volume = yield* Core.make({ execution: "sync" })

  return yield* use(yield* volume.caller(), volume)
})

const proposed = (use) => Effect.gen(function*() {
  const owner = yield* Preview.make({ limits: { synchronous: true } })

  return yield* use(yield* owner.authorize({ credentials: { uid: 0, gid: 0, privileged: true } }), owner)
})

const bytes = Uint8Array.of(1, 2, 3)

const oldWrite = { access: "write", create: "ifMissing", truncate: true }

const newWrite = { access: "write", create: "ifmissing", placement: "replace" }

if (section === "core" || section === "all") {
  await compare("whole-file reads and replacement", "adapter-mapping",
    legacy(fs => Effect.gen(function*() {
      yield* fs.writeFile("/f", bytes, oldWrite)
      yield* fs.writeFile("/f", Uint8Array.of(9), oldWrite)

      return Array.from(yield* fs.readFile("/f"))
    })),
    proposed(fs => Effect.gen(function*() {
      yield* fs.writeFile("/f", bytes, newWrite)
      yield* fs.writeFile("/f", Uint8Array.of(9), newWrite)

      return Array.from(yield* fs.readFile("/f"))
    })))
  await compare("atomic exact final mode", "upstream-gap",
    legacy(fs => Effect.gen(function*() {
      yield* fs.writeFile("/f", bytes, { ...oldWrite, finalMode: 0o600 })

      return (yield* fs.stat("/f")).mode
    })),
    proposed(fs => Effect.gen(function*() {
      yield* fs.publishCopiedFile("/f", bytes, { finalMode: 0o600 })

      return (yield* fs.stat("/f")).metadata.mode
    })))
  await compare("atomic final symlink replacement", "upstream-gap",
    legacy(fs => Effect.gen(function*() {
      yield* fs.symlink("missing", "/link")
      yield* fs.writeFile("/link", bytes, { ...oldWrite, replaceFinalSymlink: true })

      return Array.from(yield* fs.readFile("/link"))
    })),
    proposed(fs => Effect.gen(function*() {
      yield* fs.makeSymlink("/link", "missing")
      yield* fs.publishCopiedFile("/link", bytes, { overwrite: true, replaceFinalSymlink: true })

      return Array.from(yield* fs.readFile("/link"))
    })))
  await compare("watch subscription", "upstream-gap",
    legacy((_, volume) => Effect.as(volume.watch(), "subscribed")),
    proposed((_, owner) => Effect.suspend(() => Effect.as(owner.watch(), "subscribed"))))
  await compare("regular-file special mode bits", "upstream-gap",
    legacy(fs => Effect.gen(function*() {
      yield* fs.writeFile("/f", bytes, oldWrite)
      yield* fs.chmod("/f", 0o4755)

      return (yield* fs.stat("/f")).mode
    })),
    proposed(fs => Effect.gen(function*() {
      yield* fs.writeFile("/f", bytes, newWrite)
      yield* fs.setAttributes("/f", { mode: 0o4755 })

      return (yield* fs.stat("/f")).metadata.mode
    })))
  await compare("numeric object revisions", "contract-gap",
    legacy(fs => Effect.gen(function*() { return (yield* fs.stat("/")).revision === 1n })),
    proposed(fs => Effect.gen(function*() { return (yield* fs.stat("/")).revision === 1n })))
  await compare("directory listing order", "behavior-gap",
    legacy(fs => Effect.gen(function*() {
      yield* fs.mkdir("/z"); yield* fs.mkdir("/a")

      return (yield* fs.readDirectory("/")).value.map(entry => new TextDecoder().decode(entry.name))
    })),
    proposed(fs => Effect.gen(function*() {
      yield* fs.makeDirectory("/z"); yield* fs.makeDirectory("/a")

      return (yield* fs.readDirectory("/")).names.map(name => new TextDecoder().decode(PreviewPath.toBytes(name)))
    })))
}

if (section === "memory" || section === "all") {
  const { MemoryFileSystem } = await import("../../../memory/dist/index.js")
  await compare("existing MemoryFileSystem.bind contract", "adapter-work",
    Effect.gen(function*() {
      const fs = yield* MemoryFileSystem.bind(yield* Core.make())
      yield* fs.writeFile("/f", bytes)

      return Array.from(yield* fs.readFile("/f"))
    }),
    Effect.gen(function*() {
      const fs = yield* MemoryFileSystem.bind(yield* Preview.make())
      yield* fs.writeFile("/f", bytes)

      return Array.from(yield* fs.readFile("/f"))
    }))
}

if (section === "node" || section === "all") {
  const { NodeVirtualProvider: Adapter } = await import("../../../node/dist/index.js")
  await compare("existing NodeVirtualProvider.bind contract", "adapter-work",
    Effect.as(Effect.flatMap(Core.make({ execution: "sync" }), volume => Adapter.bind(volume)), "bound"),
    Effect.as(Effect.flatMap(Preview.make({ limits: { synchronous: true } }), owner => Adapter.bind(owner)), "bound"))
}

if (!["all", "core", "memory", "node"].includes(section)) throw new Error(`Unknown contract: ${section}`)

const blocked = comparisons.filter(entry => !entry.equivalent)

process.stdout.write(JSON.stringify({ section, pinnedCommit: "161258278d6618bb5a10804827bb7a5f34b04c4d", dropIn: blocked.length === 0, comparisons }, null, 2) + "\n")

process.exitCode = blocked.length === 0 ? 0 : 1
