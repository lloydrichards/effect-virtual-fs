/**
 * Failure construction and image digests shared by the live-image stores.
 *
 * @internal
 * @since 0.6.0
 */
import { VfsError, type VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { Crypto, Effect } from "effect"

/**
 * The two failure constructors of one store, both naming the store as the operation.
 *
 * @internal
 */
export const storeFailures = (operation: string) => ({
  fail: (code: Vfs.StoreCode, cause?: unknown): Vfs.StoreFailure => VfsError.make({ code, operation, cause }),
  // A rejected option names the option; the store cannot open until the caller fixes it.
  invalid: (field: string): Vfs.ArgumentFailure => VfsError.make({ code: "InvalidArgument", operation, field })
})

const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

/**
 * Captures the application's `Crypto` once, so the store's methods compute lowercase hex SHA-256 digests
 * without requiring it.
 *
 * @internal
 */
export const makeDigest = Effect.map(
  Crypto.Crypto,
  (crypto) => (image: Uint8Array) => Effect.map(crypto.digest("SHA-256", image), hex)
)
