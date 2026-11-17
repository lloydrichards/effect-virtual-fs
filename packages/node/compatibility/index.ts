// Compile-only native promise calls verify the public handle overloads.
/* eslint-disable effecttsgo/async-function, effecttsgo/node-builtin-import */
import * as Adapter from "@effect-vfs/core/SynchronousAdapter"
import type { FsFailure, Volume } from "@effect-vfs/core/VirtualFileSystem"
import type { NodeVirtualProvider } from "@effect-vfs/node"
import * as ProviderModule from "@effect-vfs/node/NodeVirtualProvider"
import type * as Effect from "effect/Effect"
import type * as Scope from "effect/Scope"
import type { Dirent } from "node:fs"
import type { VirtualProvider } from "node:vfs"

type Equal<Left, Right> = [Left, Right] extends [Right, Left] ? true : false

type Assert<Condition extends true> = Condition

export const bind: (volume: Volume) => Effect.Effect<NodeVirtualProvider.Provider, FsFailure, Scope.Scope> =
  ProviderModule.bind

export const binding: (volume: Volume) => Effect.Effect<Adapter.Binding, FsFailure, Scope.Scope> = Adapter.bind

export const provider: (value: NodeVirtualProvider.Provider) => VirtualProvider = (value) => value

export const bigintSize = (value: NodeVirtualProvider.Provider): bigint => value.statSync("/", { bigint: true }).size

export const numberSize = (value: NodeVirtualProvider.Provider): number => value.statSync("/").size

export const directories = async (
  value: NodeVirtualProvider.Provider,
  withFileTypes: boolean,
  encoding: BufferEncoding | "buffer"
) => {
  const names: Array<string> = value.readdirSync("/")
  const textNames: Array<string> = await value.readdir("/", "utf8")
  const nullNames: Array<string> = await value.readdir("/", { encoding: null })
  const byteNames: Array<Buffer> = value.readdirSync("/", { encoding: "buffer" })
  const asyncByteNames: Array<Buffer> = await value.readdir("/", { encoding: "buffer" })
  const entries: Array<Dirent> = value.readdirSync("/", { withFileTypes: true })
  const textEntries: Array<Dirent> = await value.readdir("/", { withFileTypes: true, encoding: "utf8" })
  const byteEntries: Array<Dirent<Buffer>> = value.readdirSync("/", { withFileTypes: true, encoding: "buffer" })
  const asyncByteEntries: Array<Dirent<Buffer>> = await value.readdir("/", { withFileTypes: true, encoding: "buffer" })
  const dynamicEntries = await value.readdir("/", { withFileTypes: true, encoding })
  const dynamic = value.readdirSync("/", { withFileTypes, encoding })
  // @ts-expect-error These entries have text names.
  const _wrongEntries: Array<Dirent<Buffer>> = entries
  // @ts-expect-error A dynamic withFileTypes option may produce plain names.
  const _dynamicDirents: Array<Dirent<string | Buffer>> = dynamic

  return {
    names,
    textNames,
    nullNames,
    byteNames,
    asyncByteNames,
    entries,
    textEntries,
    byteEntries,
    asyncByteEntries,
    dynamicEntries,
    dynamic
  }
}

type DirectoryResults = Awaited<ReturnType<typeof directories>>

export type DynamicEntryNames = Assert<Equal<DirectoryResults["dynamicEntries"][number]["name"], string | Buffer>>

type DynamicDirectoryResult = DirectoryResults["dynamic"][number]

export type DynamicPlainNames = Assert<Equal<Extract<DynamicDirectoryResult, string | Buffer>, string | Buffer>>

export type DynamicDirectoryEntries = Assert<
  Equal<Extract<DynamicDirectoryResult, Dirent<string | Buffer>>["name"], string | Buffer>
>

export const encodedReads = async (
  value: NodeVirtualProvider.Provider,
  encoding: BufferEncoding | "buffer" | null
) => {
  const file: Buffer = value.readFileSync("/typed")
  const fileWithFlag: Buffer = await value.readFile("/typed", { flag: "r", encoding: null })
  const textFile: string = value.readFileSync("/typed", "utf8")
  const asyncTextFile: string = await value.readFile("/typed", { flag: "r", encoding: "utf8" })
  const link: string = value.readlinkSync("/link")
  const textLink: string = await value.readlink("/link", { encoding: null })
  const byteLink: Buffer = value.readlinkSync("/link", { encoding: "buffer" })
  const asyncByteLink: Buffer = await value.readlink("/link", { encoding: "buffer" })
  const path: string = value.realpathSync("/link", { encoding: null })
  const textPath: string = await value.realpath("/link")
  const bytePath: Buffer = value.realpathSync("/link", { encoding: "buffer" })
  const asyncBytePath: Buffer = await value.realpath("/link", { encoding: "buffer" })
  const handle = value.openSync("/typed")
  const handleFile: Buffer = handle.readFileSync(null)
  const asyncHandleFile: Buffer = await handle.readFile()
  const textHandleFile: string = handle.readFileSync({ encoding: "utf8" })
  const asyncTextHandleFile: string = await handle.readFile("utf8")
  const dynamic = await value.readFile("/typed", { encoding })
  // @ts-expect-error An unsupported encoding is invalid.
  value.readFileSync("/typed", "invalid")

  return {
    file,
    fileWithFlag,
    textFile,
    asyncTextFile,
    link,
    textLink,
    byteLink,
    asyncByteLink,
    path,
    textPath,
    bytePath,
    asyncBytePath,
    handleFile,
    asyncHandleFile,
    textHandleFile,
    asyncTextHandleFile,
    dynamic
  }
}

export type DynamicRead = Assert<Equal<Awaited<ReturnType<typeof encodedReads>>["dynamic"], string | Buffer>>

export const handleArguments = async (value: NodeVirtualProvider.Provider): Promise<void> => {
  const handle = await value.open("/typed", "w+")
  const view = new DataView(new ArrayBuffer(4))
  const readView: DataView = (await handle.read({ buffer: view, length: 1, position: 0 })).buffer
  const readBuffer: Buffer = (await handle.read({ length: 0 })).buffer
  const writeView: DataView = (await handle.write(view, { offset: 0, length: 1, position: 0 })).buffer
  const writeString: string = (await handle.write("value", 0, "utf8")).buffer
  handle.readSync(readView, { length: 0 })
  handle.writeSync(readBuffer, { length: 0 })
  handle.writeSync(writeView, 0, 0, 0)
  handle.writeSync(writeString, 0, "utf8")
  await handle.close()
}
