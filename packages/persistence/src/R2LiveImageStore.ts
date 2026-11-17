/**
 * Compatibility entrypoint for the R2 store and AWS SDK transport.
 * Use `@effect-vfs/persistence/R2Store` for the transport-independent
 * store and `@effect-vfs/persistence/R2S3Transport` for the S3 adapter.
 *
 * @since 0.5.0
 */
export {
  /**
   * Client supplies a borrowed transport.
   *
   * @example
   * ```ts
   * import { Client } from "@effect-vfs/persistence/R2LiveImageStore"
   * ```
   *
   * @since 0.12.0
   */
  Client,
  /**
   * Build a store layer for one R2 key.
   *
   * @example
   * ```ts
   * import { layer } from "@effect-vfs/persistence/R2LiveImageStore"
   * ```
   *
   * @since 0.5.0
   */
  layer,
  /**
   * Bytes and metadata returned by a transport.
   *
   * @example
   * ```ts
   * import type { ObjectRecord } from "@effect-vfs/persistence/R2LiveImageStore"
   * ```
   *
   * @since 0.5.0
   */
  type ObjectRecord,
  /**
   * Options for a single R2 store.
   *
   * @example
   * ```ts
   * import type { Options } from "@effect-vfs/persistence/R2LiveImageStore"
   * ```
   *
   * @since 0.5.0
   */
  type Options,
  /**
   * The capability supplied to the store.
   *
   * @example
   * ```ts
   * import type { R2Client } from "@effect-vfs/persistence/R2LiveImageStore"
   * ```
   *
   * @since 0.5.0
   */
  type R2Client
} from "./R2Store.js"

export {
  /**
   * Adapt an application-owned AWS SDK client.
   *
   * @example
   * ```ts
   * import { fromS3 } from "@effect-vfs/persistence/R2LiveImageStore"
   * ```
   *
   * @since 0.5.0
   */
  fromS3
} from "./R2S3Transport.js"
