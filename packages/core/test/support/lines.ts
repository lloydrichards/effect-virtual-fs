const encoder = new TextEncoder()

const decoder = new TextDecoder()

/** A snapshot as one object: the header's fields, and the nodes that follow it. */
export interface Document {
  readonly format: string
  readonly version: number
  readonly nodes: ReadonlyArray<object>
}

/** The lines of a document: its header's fields, then each node, every line ending in a newline. */
export const toLines = ({ nodes, ...header }: Document): Uint8Array =>
  encoder.encode([header, ...nodes].map((line) => `${JSON.stringify(line)}\n`).join(""))

/** The values of each line of an encoding, the header first. */
export const readLines = (bytes: Uint8Array): Array<unknown> =>
  decoder.decode(bytes).split("\n").slice(0, -1).map((line) => JSON.parse(line))

/** An encoding as one document, as JSON text: the header's fields and a `nodes` array. */
export const documentText = (bytes: Uint8Array): string => {
  const [header, ...nodes] = readLines(bytes)

  return JSON.stringify(Object.assign({}, header, { nodes }))
}
