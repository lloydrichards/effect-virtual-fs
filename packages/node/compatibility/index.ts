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
