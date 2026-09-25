/**
 * Change events published by a volume's watch stream.
 *
 * @since 0.6.0
 */
import * as Schema from "effect/Schema"
import { BytePath } from "./BytePath.js"

/**
 * Schema for one committed change. `Rescan` at `/` means the subscriber lost
 * events and must rescan; events are never replayed.
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
