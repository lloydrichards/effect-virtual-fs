import * as Effect from "effect/Effect"
import { WorkshopError, workshopError } from "../errors.ts"

export const makeCanvas = (width: number, height: number) =>
  Effect.try({ try: () => new OffscreenCanvas(width, height), catch: workshopError })

export const canvasContext = Effect.fnUntraced(function*(canvas: OffscreenCanvas) {
  const context = yield* Effect.try({ try: () => canvas.getContext("2d"), catch: workshopError })

  if (!context) return yield* new WorkshopError({ message: "The worker could not open a 2D canvas." })

  return context
})

export const encodePng = (canvas: OffscreenCanvas) =>
  Effect.tryPromise({
    try: () =>
      canvas.convertToBlob({ type: "image/png" }).then((png) => png.arrayBuffer()).then((bytes) =>
        new Uint8Array(bytes)
      ),
    catch: workshopError
  })
