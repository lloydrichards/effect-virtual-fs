import * as Effect from "effect/Effect"
import { SharedMemory } from "effect/workers"
import { largestGrid, maxImageEdge } from "./domain.ts"
import { ImageSourceError } from "./errors.ts"

export interface Picture {
  readonly canvas: HTMLCanvasElement
  readonly name: string
}

const surface = Effect.fnUntraced(function*(width: number, height: number) {
  const { canvas, context } = yield* Effect.try({
    try: () => {
      const canvas = document.createElement("canvas")
      canvas.width = width
      canvas.height = height

      return { canvas, context: canvas.getContext("2d") }
    },
    catch: (cause) => new ImageSourceError({ message: "The browser could not create a canvas.", cause })
  })

  if (!context) return yield* new ImageSourceError({ message: "The browser could not open a 2D canvas." })

  return { canvas, context }
})

export const sampleImage = { width: 960, height: 600, name: "Evening ridgeline" }

export const samplePicture = Effect.gen(function*() {
  const { canvas, context } = yield* surface(sampleImage.width, sampleImage.height)

  return yield* Effect.try({
    try: () => {
      const sky = context.createLinearGradient(0, 0, 0, 600)
      sky.addColorStop(0, "#315465")
      sky.addColorStop(0.53, "#b8b5a5")
      sky.addColorStop(0.76, "#dfac7a")
      sky.addColorStop(1, "#b56f55")
      context.fillStyle = sky
      context.fillRect(0, 0, 960, 600)

      context.fillStyle = "#ffe1a1"
      context.beginPath()
      context.arc(690, 196, 63, 0, 2 * Math.PI)
      context.fill()

      for (
        const [height, color, scale] of [
          [383, "#78838a", 0.68],
          [447, "#596c73", 0.54],
          [501, "#385356", 0.53],
          [563, "#243e40", 0.35],
          [634, "#172e2d", 0.35]
        ] as const
      ) {
        context.beginPath()
        context.moveTo(0, 600)

        for (let x = 0; x <= 960; x += 3) {
          const ridge = 151 * Math.abs(Math.sin(x / 163 + height)) +
            54 * Math.abs(Math.sin(x / 72 + height)) + 20 * Math.sin(x / 27) + 8 * Math.cos(x / 9)

          context.lineTo(x, height - scale * ridge)
        }

        context.lineTo(960, 600)
        context.fillStyle = color
        context.fill()
      }

      let seed = 42

      for (let i = 0; i < 26000; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        const x = seed % 960
        const y = (seed >>> 10) % 600
        context.fillStyle = (seed & 32) === 0 ? "#fff4d62a" : "#111f2730"
        context.fillRect(x, y, 1, 1)
      }

      return { canvas, name: sampleImage.name }
    },
    catch: (cause) => new ImageSourceError({ message: "The browser could not draw the sample image.", cause })
  })
})

export const loadPicture = Effect.fnUntraced(function*(file: File) {
  const bitmap = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => createImageBitmap(file),
      catch: (cause) => new ImageSourceError({ message: "That image could not be opened.", cause })
    }),
    (bitmap) => Effect.sync(() => bitmap.close())
  )

  const scale = Math.min(1, maxImageEdge / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(largestGrid.columns, Math.round(bitmap.width * scale))
  const height = Math.max(largestGrid.rows, Math.round(bitmap.height * scale))
  const { canvas, context } = yield* surface(width, height)

  yield* Effect.try({
    try: () => context.drawImage(bitmap, 0, 0, width, height),
    catch: (cause) => new ImageSourceError({ message: "The browser could not draw the imported image.", cause })
  })

  return { canvas, name: file.name }
}, Effect.scoped)

export const sharePixels = Effect.fnUntraced(function*({ canvas }: Picture) {
  if (!SharedMemory.isAvailable()) {
    return yield* new ImageSourceError({
      message: "Shared pixels require a secure context and cross-origin isolation. Check the workshop response headers."
    })
  }

  const { height, width } = canvas

  const context = yield* Effect.try({
    try: () => canvas.getContext("2d"),
    catch: (cause) => new ImageSourceError({ message: "The browser could not open the image canvas.", cause })
  })

  if (!context) return yield* new ImageSourceError({ message: "The browser could not read the image pixels." })

  return yield* Effect.try({
    try: () => {
      const source = context.getImageData(0, 0, width, height).data
      const pixels = SharedMemory.make(Uint8ClampedArray, source.length)
      pixels.set(source)

      return { height, width, pixels }
    },
    catch: (cause) => new ImageSourceError({ message: "The browser could not share the image pixels.", cause })
  })
})

export function pngUrl(bytes: Uint8Array) {
  return URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "image/png" }))
}

export function downloadPng(bytes: Uint8Array) {
  const url = pngUrl(bytes)
  const link = document.createElement("a")
  link.href = url
  link.download = "result.png"
  link.click()
  // oxlint-disable-next-line effecttsgo/global-timers -- Keep the browser URL alive until the download starts.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
