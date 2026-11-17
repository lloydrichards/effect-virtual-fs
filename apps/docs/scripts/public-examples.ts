import { Project, SyntaxKind } from "ts-morph"

export interface PublicExample {
  readonly body: string
  readonly line: number
}

/** Reads whole JSDoc comments so package names inside fences cannot become JSDoc tags. */
export const collectPublicExamples = (text: string, filename: string): Array<PublicExample> => {
  const project = new Project({ useInMemoryFileSystem: true })
  const source = project.createSourceFile(filename, text)
  const examples: Array<PublicExample> = []

  for (const doc of source.getDescendantsOfKind(SyntaxKind.JSDoc)) {
    const lines = doc.getText().replace(/^\/\*\*/, "").replace(/\*\/$/, "")
      .split(/\r?\n/).map((line) => line.replace(/^\s*\* ?/, ""))

    let example: { readonly line: number; readonly lines: Array<string> } | undefined
    let inFence = false

    const finish = (): void => {
      if (example === undefined) return
      const blocks = [...example.lines.join("\n").matchAll(/```(?:ts|typescript)[ \t]*\n([\s\S]*?)\n[ \t]*```/g)]

      if (blocks.length === 0) {
        throw new Error(`${filename}:${example.line}: @example needs a fenced TypeScript block`)
      }

      for (const block of blocks) examples.push({ body: block[1]!, line: example.line })
      example = undefined
    }

    for (const [index, line] of lines.entries()) {
      if (!inFence && /^\s*@\w+/.test(line)) {
        finish()

        if (/^\s*@example\b/.test(line)) example = { line: doc.getStartLineNumber() + index, lines: [] }
      } else if (example !== undefined) {
        example.lines.push(line)

        if (/^\s*```/.test(line)) inFence = !inFence
      }
    }

    finish()
  }

  return examples
}

/** Returns the expected stdout for the supported output-producing example convention. */
export const expectedExampleOutput = (body: string, location: string): string | undefined => {
  if (!body.includes(".then(console.log)")) return undefined
  const expected = /\n\/\/ ([^\n]*)$/.exec(body.trimEnd())?.[1]

  if (expected === undefined) {
    throw new Error(`${location}: output-producing example needs a trailing // expected output comment`)
  }

  return expected
}
