// Mounted qualification uses native callbacks, promises and explicit scopes.
/* eslint-disable effecttsgo/async-function, effecttsgo/node-builtin-import */
import * as Vfs from "@effect-vfs/core/VirtualFileSystem"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Scope from "effect/Scope"
import * as fs from "node:fs"
import type { FileHandle } from "node:fs/promises"
import type { Readable, Writable } from "node:stream"
import { finished } from "node:stream/promises"
import { create, type VirtualFileSystem } from "node:vfs"
import * as Provider from "../src/NodeVirtualProvider.js"

// @types/node 26.6.3 omits the mount methods present in the qualified runtime.
interface Mountable extends VirtualFileSystem {
  mount(): string
  unmount(): void
}

export const mount = async (options?: Provider.Options, volume?: Vfs.Volume) => {
  const shared = volume ??
    await Effect.runPromise(Vfs.make({ execution: "sync" }).pipe(Effect.provide(NodeCrypto.layer)))

  const scope = Scope.makeUnsafe()

  const provider = await Effect.runPromise(
    Provider.bind(shared, options).pipe(Effect.provideService(Scope.Scope, scope))
  )

  // SAFETY: Node 26.11.1 exposes mount/unmount; the pinned runtime tests invoke both.
  const routing = create(provider) as Mountable
  const root = routing.mount()
  const caller = await Effect.runPromise(shared.caller())
  const descriptors = new Set<number>()
  const handles = new Set<FileHandle>()
  const streams = new Set<Readable | Writable>()
  let closed = false

  return {
    volume: shared,
    provider,
    caller,
    root,
    path: (path: string) => `${root}${path}`,
    ownFd(fd: number) {
      descriptors.add(fd)

      return fd
    },
    ownHandle(handle: FileHandle) {
      handles.add(handle)

      return handle
    },
    ownStream<A extends Readable | Writable>(stream: A): A {
      streams.add(stream)

      return stream
    },
    async close() {
      if (closed) return
      const errors: Array<unknown> = []

      // Node owns these registrations. Drain streams before closing their descriptors.
      for (const stream of streams) {
        const done = finished(stream, { cleanup: true }).catch((cause: unknown) => {
          if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ERR_STREAM_PREMATURE_CLOSE") {
            errors.push(cause)
          }
        })

        stream.destroy()
        await done
      }

      for (const handle of handles) {
        try {
          await handle.close()
        } catch (cause) {
          errors.push(cause)
        }
      }

      for (const fd of descriptors) {
        try {
          fs.closeSync(fd)
        } catch (cause) {
          if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "EBADF") errors.push(cause)
        }
      }

      // The binding must remain live while Node removes its descriptor registrations.
      try {
        await Effect.runPromise(Scope.close(scope, Exit.void))
      } finally {
        routing.unmount()
        closed = true
      }

      if (errors.length > 0) throw new AggregateError(errors, "Mounted resource cleanup failed")
    }
  }
}

export type Mounted = Awaited<ReturnType<typeof mount>>
