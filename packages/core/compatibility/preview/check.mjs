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
import { Clock, Deferred, Effect, Fiber, Predicate, Result, Stream } from "effect"
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

const adapted = (use) => Effect.gen(function*() {
  const volume = yield* Current.make({ execution: "sync" })

  return yield* use(yield* volume.caller(), volume)
})

const proposed = (use) => Effect.gen(function*() {
  const owner = yield* Preview.make({ limits: { synchronous: true } })

  return yield* use(yield* owner.authorize({ credentials: { uid: 0, gid: 0, privileged: true } }), owner)
})

const withClock = (use) => Effect.gen(function*() {
  const original = yield* Clock.Clock
  let now = 0n

  const clock = {
    currentTimeMillisUnsafe: () => original.currentTimeMillisUnsafe(), currentTimeMillis: original.currentTimeMillis,
    currentTimeNanosUnsafe: () => now, currentTimeNanos: Effect.sync(() => now),
    monotonicTimeNanosUnsafe: () => original.monotonicTimeNanosUnsafe(), monotonicTimeNanos: original.monotonicTimeNanos,
    sleep: duration => original.sleep(duration)
  }

  return yield* use(value => { now = value }).pipe(Effect.provideService(Clock.Clock, clock))
})

const maskedCleanup = (cleanup, query) => Effect.gen(function*() {
  const ready = yield* Deferred.make()

  const child = yield* Effect.forkChild(Deferred.succeed(ready, undefined).pipe(
    Effect.andThen(Effect.never), Effect.ensuring(cleanup)
  ))

  yield* Deferred.await(ready)
  yield* Fiber.interrupt(child)

  return Result.isSuccess(yield* Effect.result(query))
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
      yield* fs.writeFile("/f", bytes, oldWrite)
      yield* fs.writeFile("/f", bytes, { ...oldWrite, finalMode: 0o600 })

      return (yield* fs.stat("/f")).mode
    })),
    proposed(fs => Effect.gen(function*() {
      yield* fs.writeFile("/f", bytes, newWrite)
      yield* fs.publishCopiedFile("/f", bytes, { overwrite: true, finalMode: 0o600 })

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
  await compare("numeric object revisions", "adapter-mapping",
    legacy(fs => Effect.gen(function*() { return (yield* fs.stat("/")).revision === 1n })),
    adapted(fs => Effect.gen(function*() { return (yield* fs.stat("/")).revision === 1n })))
  await compare("directory listing order", "adapter-mapping",
    legacy(fs => Effect.gen(function*() {
      yield* fs.mkdir("/z"); yield* fs.mkdir("/a")

      return (yield* fs.readDirectory("/")).value.map(entry => new TextDecoder().decode(entry.name))
    })),
    adapted(fs => Effect.gen(function*() {
      yield* fs.mkdir("/z"); yield* fs.mkdir("/a")

      return (yield* fs.readDirectory("/")).value.map(entry => new TextDecoder().decode(entry.name))
    })))
}

if (section === "core" || section === "all") {
  await compare("write-authorized non-owner UTIME_NOW", "upstream-gap",
    legacy((fs, volume) => Effect.gen(function*() {
      yield* fs.writeFile("/f", bytes, { ...oldWrite, mode: 0o666 })
      yield* fs.chmod("/f", 0o666)
      const guest = yield* volume.caller({identity: {uid: 7, gid: 7, groups: [], privileged: false}})
      yield* guest.utimes("/f", {access: {kind: "now"}, modification: {kind: "now"}})

      return "supported"
    })),
    proposed((fs, owner) => Effect.gen(function*() {
      yield* fs.writeFile("/f", bytes, { ...newWrite, mode: 0o666 })
      yield* fs.setAttributes("/f", {mode: 0o666})
      const guest = yield* owner.authorize({ credentials: { uid: 7, gid: 7 } })
      yield* guest.setAttributes("/f", { atime: 0n, mtime: 0n })

      return "supported"
    })))
  await compare("file handle rechecks a moved confined object", "raw-api-difference",
    legacy(fs => Effect.gen(function*() {
      yield* fs.mkdir("/inside"); yield* fs.mkdir("/outside")
      yield* fs.writeFile("/inside/f", bytes, oldWrite)
      const confined = yield* fs.withRoot("/inside")
      const handle = yield* confined.open("/f", { access: "read" })
      yield* fs.rename("/inside/f", "/outside/f")
      const observed = yield* Effect.result(handle.read(3))

      return Result.isFailure(observed) ? observed.failure.code : Array.from(observed.success)
    })),
    proposed(fs => Effect.gen(function*() {
      yield* fs.makeDirectory("/inside"); yield* fs.makeDirectory("/outside")
      yield* fs.writeFile("/inside/f", bytes, newWrite)
      const confined = yield* fs.withRoot("/inside")
      const handle = yield* confined.open("/f", { access: "read" })
      yield* fs.rename("/inside/f", "/outside/f")
      const observed = yield* Effect.result(handle.readAlloc(3))

      return Result.isFailure(observed) ? observed.failure._tag : Array.from(observed.success)
    })))
  await compare("caller-authorized orphan handle metadata", "upstream-gap",
    legacy((fs, volume) => Effect.gen(function*() {
      const handle = yield* fs.open("/f", { access: "write", create: "exclusive" })
      yield* fs.chown("/f", { uid: 7, gid: 7 })
      const owner = yield* volume.caller({ identity: { uid: 7, gid: 7, groups: [], privileged: false } })
      yield* fs.unlink("/f")
      yield* owner.chmod(handle, 0o400)

      return (yield* handle.stat).mode
    })),
    proposed((fs, volume) => Effect.gen(function*() {
      const handle = yield* fs.open("/f", { access: "write", create: "exclusive" })
      yield* fs.setAttributes("/f", { uid: 7, gid: 7 })
      const owner = yield* volume.authorize({ credentials: { uid: 7, gid: 7, privileged: false } })
      const object = yield* handle.stat()
      yield* fs.unlink("/f")
      yield* owner.setAttributes(object.reference, { mode: 0o400 })

      return (yield* handle.stat()).metadata.mode
    })))
  await compare("atomic size and metadata update", "upstream-gap",
    legacy(fs => Effect.gen(function*() {
      yield* fs.writeFile("/f", bytes, oldWrite)
      yield* fs.setattr("/f", { size: 1n, mode: 0o600 })
      const info = yield* fs.stat("/f")

      return { size: info.size, mode: info.mode }
    })),
    proposed(fs => Effect.gen(function*() {
      yield* fs.writeFile("/f", bytes, newWrite)
      yield* fs.setAttributes("/f", { size: 1n, mode: 0o600 })
      const info = (yield* fs.stat("/f")).metadata

      return { size: info.size, mode: info.mode }
    })))
  await compare("recursive mkdir with terminal parent component", "upstream-gap",
    legacy(fs => Effect.gen(function*() {
      yield* fs.mkdir("/new/..", { recursive: true })

      return (yield* fs.stat("/new")).kind
    })),
    proposed(fs => Effect.gen(function*() {
      yield* fs.makeDirectory("/new/..", { recursive: true })

      return (yield* fs.stat("/new")).metadata.kind
    })))
  await compare("empty literal symlink target", "upstream-gap",
    legacy(fs => Effect.gen(function*() {
      yield* fs.symlink("", "/link")

      return Array.from(yield* fs.readLink("/link"))
    })),
    proposed(fs => Effect.gen(function*() {
      yield* fs.makeSymlink("/link", "")

      return Array.from(PreviewPath.toBytes(yield* fs.readLink("/link")))
    })))
  await compare("symlink mode round trip", "upstream-gap",
    legacy(fs => Effect.gen(function*() {
      yield* fs.symlink("target", "/link")
      yield* fs.chmod(Current.Target.Path({ path: "/link", followFinalSymlink: false }), 0o700)

      return (yield* fs.stat(Current.Target.Path({ path: "/link", followFinalSymlink: false }))).mode
    })),
    proposed(fs => Effect.gen(function*() {
      yield* fs.makeSymlink("/link", "target")
      yield* fs.setAttributes("/link", { mode: 0o700 }, { followFinalSymlink: false })

      return (yield* fs.linkStat("/link")).metadata.mode
    })))
}

if (section === "core" || section === "all") {
  await compare("relatime suppresses a second recent file atime refresh", "upstream-gap",
    withClock(set => legacy(fs => Effect.gen(function*() {
      yield* fs.writeFile("/f", bytes, oldWrite)
      set(1000000000n); yield* fs.readFile("/f")
      set(2000000000n); yield* fs.readFile("/f")

      return (yield* fs.stat("/f")).atimeNs
    }))),
    withClock(set => proposed(fs => Effect.gen(function*() {
      yield* fs.writeFile("/f", bytes, newWrite)
      set(1000000000n); yield* fs.readFile("/f")
      set(2000000000n); yield* fs.readFile("/f")

      return (yield* fs.stat("/f")).metadata.atime
    }))))
  await compare("walk lists a readable nonsearchable directory without touching times", "upstream-gap",
    legacy((fs, volume) => Effect.gen(function*() {
      yield* fs.mkdir("/dir")
      yield* fs.writeFile("/dir/f", bytes, oldWrite)
      yield* fs.chmod("/dir", 0o444)
      const guest = yield* volume.caller({identity: {uid: 7, gid: 7, groups: [], privileged: false}})
      const entries = yield* Stream.runCollect(guest.walk("/dir"))

      return entries.map(entry => new TextDecoder().decode(entry.name))
    })),
    proposed((fs, owner) => Effect.gen(function*() {
      yield* fs.makeDirectory("/dir")
      yield* fs.writeFile("/dir/f", bytes, newWrite)
      yield* fs.setAttributes("/dir", {mode: 0o444})
      const guest = yield* owner.authorize({credentials: {uid: 7, gid: 7}})
      const entries = yield* Stream.runCollect(guest.walk("/dir"))

      return entries.filter(entry => !entry.root).map(entry => new TextDecoder().decode(PreviewPath.toBytes(entry.entry.name)))
    })))
  await compare("literal initial directory timestamps", "upstream-gap",
    legacy(fs => Effect.gen(function*() {
      yield* fs.mkdir("/d", { times: { access: { kind: "value", nanoseconds: 5n }, modification: { kind: "value", nanoseconds: 9n } } })

      return { atime: (yield* fs.stat("/d")).atimeNs, mtime: (yield* fs.stat("/d")).mtimeNs }
    })),
    proposed(fs => Effect.gen(function*() {
      yield* fs.makeDirectory("/d", { times: { access: { kind: "value", nanoseconds: 5n }, modification: { kind: "value", nanoseconds: 9n } } })

      return { atime: (yield* fs.stat("/d")).metadata.atime, mtime: (yield* fs.stat("/d")).metadata.mtime }
    })))
  await compare("owner identifiers above unsigned 32-bit range", "upstream-gap",
    legacy(fs => Effect.gen(function*() {
      yield* fs.writeFile("/f", bytes, oldWrite)
      yield* fs.chown("/f", { uid: 2 ** 40 })

      return (yield* fs.stat("/f")).uid
    })),
    proposed(fs => Effect.gen(function*() {
      yield* fs.writeFile("/f", bytes, newWrite)
      yield* fs.setAttributes("/f", { uid: 2 ** 40 })

      return (yield* fs.stat("/f")).metadata.uid
    })))
  await compare("atomic initial file size and owner", "upstream-gap",
    legacy(fs => Effect.gen(function*() {
      const opened = yield* fs.open(Current.Entry(yield* fs.root, "f"), {access: "write", create: "exclusive", initialSize: 1n, owner: {uid: 7}})
      const info = yield* opened.handle.stat

      return {size: info.size, uid: info.uid}
    })),
    proposed(fs => Effect.gen(function*() {
      const opened = yield* fs.open("/f", {access: "write", create: "exclusive", initialSize: 1n, owner: {uid: 7}})
      const info = (yield* opened.stat()).metadata

      return {size: info.size, uid: info.uid}
    })))
}

if (section === "core" || section === "all") {
  await compare("a masked finalizer can finish filesystem cleanup after interruption", "upstream-gap",
    legacy(fs => maskedCleanup(fs.mkdir("/cleanup"), fs.stat("/cleanup"))),
    proposed(fs => maskedCleanup(fs.makeDirectory("/cleanup"), fs.stat("/cleanup"))))
}

if (section === "memory" || section === "all") {
  const { MemoryFileSystem } = await import("../../../memory/dist/index.js")
  await compare("existing MemoryFileSystem.bind contract", "adapter-mapping",
    Effect.gen(function*() {
      const fs = yield* MemoryFileSystem.bind(yield* Core.make())
      yield* fs.writeFile("/f", bytes)

      return Array.from(yield* fs.readFile("/f"))
    }),
    Effect.gen(function*() {
      const fs = yield* MemoryFileSystem.bind(yield* Current.make())
      yield* fs.writeFile("/f", bytes)

      return Array.from(yield* fs.readFile("/f"))
    }))
}

if (section === "node" || section === "all") {
  const { NodeVirtualProvider: Adapter } = await import("../../../node/dist/index.js")
  await compare("existing NodeVirtualProvider.bind contract", "adapter-mapping",
    Effect.as(Effect.flatMap(Core.make({ execution: "sync" }), volume => Adapter.bind(volume)), "bound"),
    Effect.as(Effect.flatMap(Current.make({ execution: "sync" }), volume => Adapter.bind(volume)), "bound"))
}

if (!["all", "core", "memory", "node"].includes(section)) throw new Error(`Unknown contract: ${section}`)

const blocked = comparisons.filter(entry => !entry.equivalent)

process.stdout.write(JSON.stringify({ section, pinnedCommit: "161258278d6618bb5a10804827bb7a5f34b04c4d", dropIn: blocked.length === 0, comparisons }, (_key, value) => Predicate.isBigInt(value) ? String(value) : value, 2) + "\n")

process.exitCode = blocked.length === 0 ? 0 : 1
