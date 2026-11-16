import * as Vfs from "@effect-vfs/core/VirtualFileSystem"
import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto"
import { ByteSize, Effect } from "effect"

const encoder = new TextEncoder()

const decoder = new TextDecoder()

const limits = {
  maxEncodedBytes: ByteSize.mebibytes(2),
  maxDecodedBytes: ByteSize.mebibytes(1),
  maxRecords: 128,
  maxEntries: 128
}

export async function openVolume(image?: Uint8Array) {
  const program = image
    ? Effect.flatMap(Vfs.decodeSnapshot(image, limits), (snapshot) => Vfs.fromSnapshot(snapshot))
    : Vfs.fromFixture({
      entries: [
        {
          kind: "file",
          path: "/main.js",
          bytes: encoder.encode("import { value } from \"./value.js\"\nexport const answer = value + 22\n")
        },
        { kind: "file", path: "/value.js", bytes: encoder.encode("export const value = 20\n") }
      ]
    })

  const volume = await Effect.runPromise(program.pipe(Effect.provide(BrowserCrypto.layer)))
  const caller = await Effect.runPromise(volume.caller())

  return {
    resolve: (path: string) =>
      Effect.runPromise(
        caller.realPath(path).pipe(Effect.flatMap(Vfs.pathToBytes), Effect.map((bytes) => decoder.decode(bytes)))
      ),
    files: () =>
      Effect.runPromise(
        caller.readDirectory("/").pipe(
          Effect.map(({ value }) => value.map(({ name }) => "/" + decoder.decode(name)))
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
      })),
    snapshot: () =>
      Effect.runPromise(volume.snapshot.pipe(Effect.flatMap((snapshot) => Vfs.encodeSnapshot(snapshot, limits))))
  }
}

export type Workspace = Awaited<ReturnType<typeof openVolume>>
