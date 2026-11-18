import type { Filter, Source, TileBounds } from "./domain.ts"

const radius = 6

// The horizontal pass includes rows outside the tile for the vertical pass.
function blurTile({ height, pixels: input, width }: Source, bounds: TileBounds) {
  const stride = bounds.width * 4
  const horizontal = new Float32Array(stride * (bounds.height + radius * 2))
  const output = new Uint8ClampedArray(stride * bounds.height)
  const windowSize = radius * 2 + 1

  for (let row = -radius; row < bounds.height + radius; row++) {
    const y = Math.min(height - 1, Math.max(0, bounds.y + row))

    for (let x = 0; x < bounds.width; x++) {
      const target = (row + radius) * stride + x * 4

      for (let channel = 0; channel < 4; channel++) {
        let sum = 0

        for (let dx = -radius; dx <= radius; dx++) {
          const column = Math.min(width - 1, Math.max(0, bounds.x + x + dx))
          sum += input[(y * width + column) * 4 + channel]!
        }

        horizontal[target + channel] = sum / windowSize
      }
    }
  }

  for (let row = 0; row < bounds.height; row++) {
    for (let offset = 0; offset < stride; offset++) {
      let sum = 0

      for (let dy = 0; dy < windowSize; dy++) {
        sum += horizontal[(row + dy) * stride + offset]!
      }

      output[row * stride + offset] = sum / windowSize
    }
  }

  return output
}

export function filterTile(source: Source, bounds: TileBounds, filter: Filter) {
  if (filter === "blur") return blurTile(source, bounds)

  const input = source.pixels
  const output = new Uint8ClampedArray(bounds.width * bounds.height * 4)

  for (let row = 0; row < bounds.height; row++) {
    if (filter === "normal") {
      const from = ((bounds.y + row) * source.width + bounds.x) * 4
      const stride = bounds.width * 4
      output.set(input.subarray(from, from + stride), row * stride)
      continue
    }

    for (let column = 0; column < bounds.width; column++) {
      const from = ((bounds.y + row) * source.width + bounds.x + column) * 4
      const to = (row * bounds.width + column) * 4
      const red = input[from]!
      const green = input[from + 1]!
      const blue = input[from + 2]!

      if (filter === "sepia") {
        output[to] = 0.393 * red + 0.769 * green + 0.189 * blue
        output[to + 1] = 0.349 * red + 0.686 * green + 0.168 * blue
        output[to + 2] = 0.272 * red + 0.534 * green + 0.131 * blue
      } else {
        const gray = 0.2126 * red + 0.7152 * green + 0.0722 * blue
        output[to] = filter === "invert" ? 255 - red : gray
        output[to + 1] = filter === "invert" ? 255 - green : gray
        output[to + 2] = filter === "invert" ? 255 - blue : gray
      }

      output[to + 3] = input[from + 3]!
    }
  }

  return output
}
