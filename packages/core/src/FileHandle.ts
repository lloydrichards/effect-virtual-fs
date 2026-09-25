/**
 * Identity brands and schemas for open file and directory handles.
 *
 * @since 0.6.0
 */
import * as Schema from "effect/Schema"

/**
 * Brand key that marks an open file handle.
 *
 * @category type IDs
 * @since 0.6.0
 */
export const FileHandleId: unique symbol = Symbol.for("@effect-vfs/core/FileHandle")

/**
 * Brand key that marks an open file handle.
 *
 * @category type IDs
 * @since 0.6.0
 */
export type FileHandleId = typeof FileHandleId

/**
 * Brand key that marks an open directory handle.
 *
 * @category type IDs
 * @since 0.6.0
 */
export const DirectoryHandleId: unique symbol = Symbol.for("@effect-vfs/core/DirectoryHandle")

/**
 * Brand key that marks an open directory handle.
 *
 * @category type IDs
 * @since 0.6.0
 */
export type DirectoryHandleId = typeof DirectoryHandleId

/**
 * Schema for the origin of a seek: the file start, the current position, the
 * end, or the next data or hole region.
 *
 * @category schemas
 * @since 0.6.0
 */
export const SeekMode = Schema.Literals(["start", "current", "end", "data", "hole"])

/**
 * The origin of a seek.
 *
 * @category models
 * @since 0.6.0
 */
export type SeekMode = typeof SeekMode.Type
