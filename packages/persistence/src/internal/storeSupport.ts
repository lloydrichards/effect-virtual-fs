/**
 * Failure construction and image digests shared by the live-image stores.
 *
 * @internal
 * @since 0.6.0
 */
import { VfsError, type VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { Effect } from "effect"
import * as Digest from "effect/crypto/Digest"
import * as Hex from "effect/encoding/Hex"

/**
 * The two failure constructors of one store entry point, both naming that entry point, such as
 * `SqliteLiveImageStore.layer`, as the operation.
 *
 * @internal
 */
export const storeFailures = (operation: string) => ({
  fail: (code: Vfs.StoreCode, cause?: unknown): Vfs.StoreFailure => VfsError.make({ code, operation, cause }),
  // A rejected option names the option; the store cannot open until the caller fixes it.
  invalid: (field: string): Vfs.ArgumentFailure => VfsError.make({ code: "InvalidArgument", operation, field })
})

/**
 * The failure constructors `storeFailures` returns for one entry point.
 *
 * @internal
 */
export type StoreFailures = ReturnType<typeof storeFailures>

/**
 * Captures the application's `Digest` once, so the store's methods compute lowercase hex SHA-256 digests
 * without requiring it.
 *
 * @internal
 */
export const makeDigest = Effect.map(
  Digest.Digest,
  (digest) => (image: Uint8Array) =>
    Effect.suspend(() => digest.digest(Digest.sha256, image)).pipe(Effect.map(Hex.encode))
)
