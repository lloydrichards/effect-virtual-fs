import { largestGrid, maxImageEdge, type Source } from "./domain.ts"

export interface Picture {
  readonly canvas: HTMLCanvasElement
  readonly name: string
}

function surface(width: number, height: number) {
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext("2d")

  if (!context) throw new Error("The browser could not open a 2D canvas.")

  return { canvas, context }
}

export const sampleImage = { width: 960, height: 600, name: "Evening ridgeline" }

export function samplePicture(): Picture {
  const { canvas, context } = surface(sampleImage.width, sampleImage.height)
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
}

// oxlint-disable-next-line effecttsgo/async-function -- Decode the browser File at the image input boundary.
export async function loadPicture(file: File): Promise<Picture> {
  const bitmap = await createImageBitmap(file)

  try {
    const scale = Math.min(1, maxImageEdge / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(largestGrid.columns, Math.round(bitmap.width * scale))
    const height = Math.max(largestGrid.rows, Math.round(bitmap.height * scale))
    const { canvas, context } = surface(width, height)
    context.drawImage(bitmap, 0, 0, width, height)

    return { canvas, name: file.name }
  } finally {
    bitmap.close()
  }
}

export function sharePixels({ canvas }: Picture): Source {
  if (!crossOriginIsolated || typeof SharedArrayBuffer === "undefined") {
    throw new Error("Shared pixels require a cross-origin isolated page. Open the workshop on localhost or HTTPS.")
  }

  const { height, width } = canvas
  const context = canvas.getContext("2d")

  if (!context) throw new Error("The browser could not read the image pixels.")
  const source = context.getImageData(0, 0, width, height).data
  const pixels = new SharedArrayBuffer(source.byteLength)
  new Uint8ClampedArray(pixels).set(source)

  return { height, width, pixels }
}

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
