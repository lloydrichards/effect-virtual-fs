import { javascriptLanguage } from "@codemirror/lang-javascript"
import { classHighlighter, highlightCode } from "@lezer/highlight"
import { type ReactNode, useMemo } from "react"
import { CodeBlock } from "./code-block"

export function PlaygroundBundle({ source }: { source: string }) {
  const tokens = useMemo(() => {
    const parts: Array<ReactNode> = []
    highlightCode(
      source,
      javascriptLanguage.parser.parse(source),
      classHighlighter,
      (text, classes) => parts.push(classes ? <span key={parts.length} className={classes}>{text}</span> : text),
      () => parts.push("\n")
    )

    return parts
  }, [source])

  return (
    <CodeBlock
      aria-label="Generated bundle"
      tabIndex={0}
      className="playground-bundle playground-syntax mt-1 max-h-64 pe-14 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
    >
      <code>{tokens}</code>
    </CodeBlock>
  )
}
