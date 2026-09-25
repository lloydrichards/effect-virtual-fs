/**
 * Change events published by a volume's watch stream, and the options that
 * narrow a watch to one object's subtree.
 *
 * @since 0.6.0
 */
import * as Schema from "effect/Schema"
import { BytePath } from "./BytePath.js"
import { ObjectReferenceSchema } from "./Caller.js"
import type { ObjectReference } from "./VirtualFileSystem.js"

/**
 * Schema for one committed change. `Rescan` means the subscriber lost events
 * and must rescan what it watches, whose path it names; events are never
 * replayed.
 *
 * @category schemas
 * @since 0.6.0
 */
export const Change = Schema.TaggedUnion({
  Create: { path: BytePath },
  Update: { path: BytePath },
  Remove: { path: BytePath },
  Rescan: { path: BytePath }
})

/**
 * One committed change observed through a watch subscription.
 *
 * @category models
 * @since 0.6.0
 */
export type Change = typeof Change.Type

/**
 * Schema for the options of a watch. `scope` narrows the watch to one object
 * and, when `recursive` is not `false`, everything below it; without a scope
 * the watch covers the volume.
 *
 * **Details**
 *
 * The scope is an object, not a path: a watch on a directory keeps receiving
 * its changes, at their current paths, after the directory or one of its
 * ancestors is renamed. Each change is tested against the scope on its own,
 * so a move out of the scope arrives as `Remove` and a move into it as
 * `Create`. With `recursive: false` only the object itself and its direct
 * children are reported. When the object's last name is removed the watch
 * reports `Remove` for it and ends.
 *
 * @category schemas
 * @since 0.6.0
 */
export const WatchOptions = Schema.Struct({
  // Naming the type keeps `ObjectReference` in the rendered `WatchOptions` type.
  scope: Schema.optionalKey<Schema.declare<ObjectReference>>(ObjectReferenceSchema),
  recursive: Schema.optionalKey(Schema.Boolean)
})

/**
 * Options of a watch.
 *
 * @category models
 * @since 0.6.0
 */
export type WatchOptions = typeof WatchOptions.Type
