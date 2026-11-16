import { Effect, Schema } from "effect"
import { PlaygroundError } from "./error"
import runnerPage from "./runner.html?raw"

const decodeReply = Schema.decodeUnknownEffect(Schema.Struct({
  lines: Schema.Array(Schema.String),
  error: Schema.optional(Schema.String)
}))

export const runBundle = Effect.fnUntraced(function*(code: string) {
  const frame = document.createElement("iframe")
  const channel = new MessageChannel()
  frame.hidden = true
  frame.title = "Playground bundle runner"
  frame.sandbox.add("allow-scripts")
  frame.srcdoc = runnerPage

  const message = yield* Effect.callback<unknown>((resume) => {
    frame.onload = () => frame.contentWindow?.postMessage(code, "*", [channel.port2])
    channel.port1.onmessage = (event) => resume(Effect.succeed(event.data))
    document.body.append(frame)
  }).pipe(
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () => new PlaygroundError({ message: "Execution timed out after 5 seconds." })
    }),
    Effect.ensuring(Effect.sync(() => {
      frame.remove()
      channel.port1.close()
      channel.port2.close()
    }))
  )

  return yield* decodeReply(message).pipe(Effect.mapError(PlaygroundError.fromCause))
})
