import * as Vfs from "@effect-vfs/core/VirtualFileSystem"
import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto"
import { ByteSize, Effect, Stream } from "effect"

const encoder = new TextEncoder()

const decoder = new TextDecoder()

const limits = {
  maxEncodedBytes: ByteSize.mebibytes(2),
  maxDecodedBytes: ByteSize.mebibytes(1),
  maxRecords: 128,
  maxEntries: 128
}

export const openVolume = Effect.fnUntraced(function*(image?: Uint8Array) {
  const program = image
    ? Effect.flatMap(Vfs.decodeSnapshot(image, limits), (snapshot) => Vfs.fromSnapshot(snapshot))
    : Vfs.fromFixture({
      rootMetadata: { uid: 0, gid: 1000, mode: 0o1775 },
      entries: [
        { kind: "directory", path: "/src", metadata: { uid: 1000, mode: 0o755 } },
        {
          kind: "file",
          path: "/main.js",
          metadata: { uid: 1000, mode: 0o644 },
          bytes: encoder.encode(
            [
              'import { value } from "./src/value.js"',
              "// Uncomment to run the private calibration.",
              '// import "./secret.js"',
              "",
              'console.log(`Reading: ${value}`)',
              ""
            ].join("\n")
          )
        },
        {
          kind: "file",
          path: "/secret.js",
          metadata: { uid: 0, mode: 0o600 },
          bytes: encoder.encode(
            [
              'import { value } from "./src/value.js"',
              "",
              "const offset = 22",
              "const calibrated = value + offset",
              'console.log(`Secret: ${calibrated} (${value} + ${offset})`)',
              ""
            ].join("\n")
          )
        },
        {
          kind: "file",
          path: "/src/value.js",
          metadata: { uid: 1000, mode: 0o644 },
          bytes: encoder.encode("export const value = 20\n")
        }
      ]
    })

  const volume = yield* program.pipe(Effect.provide(BrowserCrypto.layer))
  const admin = yield* volume.caller({ identity: { uid: 0, gid: 0, groups: [], privileged: true }, umask: 0o022 })

  const editor = yield* volume.caller({
    identity: { uid: 1000, gid: 1000, groups: [], privileged: false },
    umask: 0o022
  })

  const reader = yield* volume.caller({
    identity: { uid: 2000, gid: 2000, groups: [], privileged: false }
  })

  const bind = (caller: Vfs.Caller) => ({
    setFileMode: (path: string, mode: 0o600 | 0o644) => caller.chmod(path, mode),
    permissions: (path: string) => caller.access(path, 6),
    resolve: (path: string) =>
      caller.realPath(path).pipe(Effect.flatMap(Vfs.pathToBytes), Effect.map((bytes) => decoder.decode(bytes))),
    files: () =>
      caller.walk("/").pipe(
        Stream.mapEffect(Effect.fnUntraced(function*(entry) {
          const path = "/" + decoder.decode(yield* Vfs.pathToBytes(entry.path))
          const directory = entry.kind === "directory"
          const readable = directory || ((yield* caller.access(path, 4)) & 4) !== 0

          const policy = entry.kind === "file"
            ? yield* Effect.all({
              metadata: caller.stat(entry.reference),
              reader: reader.access(path, 6),
              editor: editor.access(path, 6)
            })
            : undefined

          return { path, directory, readable, policy }
        })),
        Stream.runCollect
      ),
    read: (path: string) => caller.readFile(path).pipe(Effect.map((bytes) => decoder.decode(bytes))),
    write: (path: string, text: string) =>
      caller.writeFile(path, encoder.encode(text), {
        access: "write",
        truncate: true
      }),
    mkdir: (path: string) => caller.mkdir(path),
    rename: (from: string, to: string) => caller.rename(from, to),
    removeFolder: (path: string) => caller.remove(path, { recursive: true }),
    unlink: (path: string) => caller.unlink(path),
    create: (path: string) =>
      caller.writeFile(path, new Uint8Array(), {
        access: "write",
        create: "exclusive"
      })
  })

  return {
    admin: bind(admin),
    editor: bind(editor),
    reader: bind(reader),
    snapshot: () => volume.snapshot.pipe(Effect.flatMap((snapshot) => Vfs.encodeSnapshot(snapshot, limits)))
  }
})

export type Workspace = Effect.Success<ReturnType<typeof openVolume>>

export type FileAccess = Workspace["editor"]
