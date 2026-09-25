/**
 * Tagged errors shared by the public filesystem API and its implementation.
 *
 * @since 0.1.0
 */
import * as Data from "effect/Data"
import type { ImageError } from "./Snapshot.js"
import type { FsCode, PathInput } from "./VirtualFileSystem.js"

/**
 * An expected filesystem operation failure.
 *
 * The `code` distinguishes portable failures while `operation` names the action.
 * Byte paths are intentionally omitted from the formatted message.
 *
 * @example
 * ```ts
 * import { VirtualFileSystemError } from "@effect-vfs/core"
 *
 * const error = new VirtualFileSystemError.FsError({ code: "NotFound", operation: "readFile" })
 * console.log(error.code, error.message)
 * // NotFound readFile failed with NotFound
 * ```
 *
 * @category errors
 * @since 0.1.0
 */
export class FsError extends Data.TaggedError("FsError")<{
  readonly code: FsCode
  readonly operation: string
  readonly path?: PathInput
  /** Underlying failure that this error classifies, when one exists. */
  readonly cause?: FsError | ImageError | TypeError
}> {
  override get message(): string {
    return `${this.operation} failed with ${this.code}`
  }
}

/**
 * An invalid volume or caller option, identified by its field name.
 *
 * @example
 * ```ts
 * import { VirtualFileSystemError } from "@effect-vfs/core"
 *
 * const error = new VirtualFileSystemError.ConfigurationError({ field: "maxEntries" })
 * console.log(error.field, error.message)
 * // maxEntries Invalid option: maxEntries
 * ```
 *
 * @category errors
 * @since 0.1.0
 */
export class ConfigurationError extends Data.TaggedError("ConfigurationError")<{
  readonly field: string
}> {
  override get message(): string {
    return `Invalid option: ${this.field}`
  }
}
