import { Data } from "effect"

export class PlaygroundError extends Data.TaggedError("PlaygroundError")<{
  readonly message: string
  readonly cause?: unknown
}> {
  static fromCause(this: void, cause: unknown) {
    return new PlaygroundError({ message: cause instanceof Error ? cause.message : String(cause), cause })
  }
}
