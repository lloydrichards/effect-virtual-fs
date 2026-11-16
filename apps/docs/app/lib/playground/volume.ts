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

// oxlint-disable-next-line effecttsgo/async-function -- React opens this workspace and awaits its caller-bound operations.
export async function openVolume(image?: Uint8Array) {
  const program = image
    ? Effect.flatMap(Vfs.decodeSnapshot(image, limits), (snapshot) => Vfs.fromSnapshot(snapshot))
    : Vfs.fromFixture({
      entries: [
        { kind: "directory", path: "/src", metadata: { mode: 0o755 } },
        {
          kind: "file",
          path: "/main.js",
          metadata: { mode: 0o644 },
          bytes: encoder.encode("import { value } from \"./src/value.js\"\nexport const answer = value + 22\n")
        },
        {
          kind: "file",
          path: "/src/value.js",
          metadata: { mode: 0o644 },
          bytes: encoder.encode("export const value = 20\n")
        }
      ]
    })

  const volume = await Effect.runPromise(program.pipe(Effect.provide(BrowserCrypto.layer)))
  const editor = await Effect.runPromise(volume.caller({ umask: 0o022 }))

  const reader = await Effect.runPromise(volume.caller({
    identity: { uid: 2000, gid: 2000, groups: [], privileged: false }
  }))

  const bind = (caller: Vfs.Caller) => ({
    permissions: (path: string) => Effect.runPromise(caller.access(path, 6)),
    resolve: (path: string) =>
      Effect.runPromise(
        caller.realPath(path).pipe(Effect.flatMap(Vfs.pathToBytes), Effect.map((bytes) => decoder.decode(bytes)))
      ),
    files: () =>
      Effect.runPromise(
        caller.walk("/").pipe(
          Stream.mapEffect((entry) =>
            Vfs.pathToBytes(entry.path).pipe(
              Effect.map((bytes) => ({
                path: "/" + decoder.decode(bytes),
                directory: entry.kind === "directory"
              }))
            )
          ),
          Stream.runCollect
        )
      ),
    read: (path: string) => Effect.runPromise(caller.readFile(path).pipe(Effect.map((bytes) => decoder.decode(bytes)))),
    write: (path: string, text: string) =>
      Effect.runPromise(caller.writeFile(path, encoder.encode(text), {
        access: "write",
        truncate: true
      })),
    create: (path: string) =>
      Effect.runPromise(caller.writeFile(path, new Uint8Array(), {
        access: "write",
        create: "exclusive"
      }))
  })

  return {
    editor: bind(editor),
    reader: bind(reader),
    snapshot: () =>
      Effect.runPromise(volume.snapshot.pipe(Effect.flatMap((snapshot) => Vfs.encodeSnapshot(snapshot, limits))))
  }
}

export type Workspace = Awaited<ReturnType<typeof openVolume>>

export type FileAccess = Workspace["editor"]
