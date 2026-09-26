import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { BunRuntime } from "@effect/platform-bun"
import { ByteSize, Console, Effect, Schema } from "effect"

const utf8 = new TextEncoder()

const Config = Schema.fromJsonString(Schema.Struct({ feature: Schema.Literal("preview") }))

const program = Effect.scoped(Effect.gen(function*() {
  const volume = yield* Vfs.Volume

  // const base = yield* volume.snapshot

  const admin = yield* volume.caller()
  yield* admin.mkdir("/workspace", { mode: 0o770 }) // mkdir -m 770 /workspace
  yield* admin.chown("/workspace", { uid: 1000, gid: 1000 }) // chown 1000:1000 /workspace

  const developer = yield* volume.caller({
    identity: { uid: 1000, gid: 1000, groups: [], privileged: false },
    umask: 0o027
  })

  yield* developer.writeFile(
    "/workspace/config.json",
    utf8.encode(yield* Schema.encodeEffect(Config)({ feature: "preview" })),
    { access: "write", create: "exclusive", mode: 0o666 }
  ) // echo '{"feature":"preview"}' > /workspace/config.json

  const file = yield* developer.open("/workspace/config.json", { access: "read" }) // cat /workspace/config.json
  const contents = yield* file.read(100_000)
  const metadata = yield* file.stat // stat /workspace/config.json

  // const diff = yield* Vfs.diffSnapshots(base, yield* volume.snapshot)

  // const changes = yield* Vfs.inspectSnapshotDelta(base, diff)

  return {
    // changes: changes.map((change) =>
    //   Match.valueTags(change, {
    //     Added: (value) => `<Added: ${value.path}>`,
    //     Removed: (value) => `<Removed: ${value.path}>`,
    //     Updated: (value) => `<Updated: ${value.path}>`
    //   })
    // ),
    config: yield* Schema.decodeEffect(Config)(new TextDecoder().decode(contents)),
    mode: metadata.mode.toString(8)
  }
})).pipe(Effect.provide(Vfs.Volume.layer({
  maxEntries: 100,
  maxBytes: ByteSize.megabytes(1),
  maxFileBytes: ByteSize.kilobytes(100)
})))

const main = Effect.gen(function*() {
  const result = yield* program

  yield* Console.log(result)
})

BunRuntime.runMain(main)
