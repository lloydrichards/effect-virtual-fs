import * as Data from "effect/Data"
import * as Schema from "effect/Schema"

export class ImageSourceError extends Data.TaggedError("ImageSourceError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class WorkshopError extends Schema.TaggedError<WorkshopError>()("WorkshopError", {
  message: Schema.String
}) {}

export const workshopError = (cause: unknown) =>
  Schema.is(WorkshopError)(cause)
    ? cause
    : new WorkshopError({ message: cause instanceof Error ? cause.message : String(cause) })
