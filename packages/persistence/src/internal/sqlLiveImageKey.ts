/**
 * Key identity shared by the SQL live-image adapters.
 *
 * @internal
 */
import { Schema } from "effect"

/**
 * Lone surrogates collapse to U+FFFD during UTF-8 transport. Admit only scalar
 * values and paired surrogates so distinct accepted strings remain distinct.
 *
 * @internal
 */
export const SqlLiveImageKey = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.isPattern(/^(?:[^\0\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])+$/)
)
