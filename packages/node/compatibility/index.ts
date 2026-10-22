// Compile-only native promise calls verify the public handle overloads.
/* eslint-disable effecttsgo/async-function */
import * as Adapter from "@effect-vfs/core/SynchronousAdapter"
import type { FsFailure, Volume } from "@effect-vfs/core/VirtualFileSystem"
import type { NodeVirtualProvider } from "@effect-vfs/node"
import * as ProviderModule from "@effect-vfs/node/NodeVirtualProvider"
import type * as Effect from "effect/Effect"
import type * as Scope from "effect/Scope"
import type { VirtualProvider } from "node:vfs"

export const bind: (volume: Volume) => Effect.Effect<NodeVirtualProvider.Provider, FsFailure, Scope.Scope> =
  ProviderModule.bind

export const binding: (volume: Volume) => Effect.Effect<Adapter.Binding, FsFailure, Scope.Scope> = Adapter.bind

export const provider: (value: NodeVirtualProvider.Provider) => VirtualProvider = (value) => value

export const bigintSize = (value: NodeVirtualProvider.Provider): bigint => value.statSync("/", { bigint: true }).size

export const numberSize = (value: NodeVirtualProvider.Provider): number => value.statSync("/").size

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
