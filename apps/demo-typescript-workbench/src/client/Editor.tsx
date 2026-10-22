// Vite transforms the worker constructor import; the language contribution registers its tokenizer.
/* eslint-disable import/default, import/no-unassigned-import */
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js"
import { useEffect, useRef } from "react"
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js"
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker"

declare global {
  var MonacoEnvironment: monaco.Environment | undefined
}

self.MonacoEnvironment = { getWorker: () => new EditorWorker() }

monaco.editor.defineTheme("vfs-workbench", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#18221f",
    "editorLineNumber.foreground": "#788e80",
    "editor.selectionBackground": "#345c48",
    "editor.lineHighlightBackground": "#202e27",
    "editorCursor.foreground": "#c1dcc3"
  }
})

export function Editor(
  { file, text, readonly, onChange }: {
    file: string
    text: string
    readonly: boolean
    onChange: (text: string) => void
  }
) {
  const container = useRef<HTMLDivElement>(null)
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const listener = useRef(onChange)
  const updating = useRef(false)
  listener.current = onChange
  useEffect(() => {
    if (!container.current) return

    const instance = monaco.editor.create(container.current, {
      value: "",
      language: "typescript",
      theme: "vfs-workbench",
      automaticLayout: true,
      minimap: { enabled: false },
      fontFamily: "JetBrains Mono Variable, monospace",
      fontSize: 12,
      lineHeight: 23,
      padding: { top: 20 },
      scrollBeyondLastLine: false,
      wordWrap: "on",
      tabSize: 2,
      ariaLabel: "Project code editor",
      renderLineHighlight: "line",
      overviewRulerLanes: 0,
      folding: true
    })

    editor.current = instance

    const subscription = instance.onDidChangeModelContent(() => {
      if (!updating.current) listener.current(instance.getValue())
    })

    return () => {
      subscription.dispose()
      instance.getModel()?.dispose()
      instance.dispose()
      editor.current = null
    }
  }, [])
  useEffect(() => {
    const instance = editor.current

    if (!instance) return
    const uri = monaco.Uri.parse(`file:///project${file}`)
    updating.current = true

    if (instance.getModel()?.uri.toString() !== uri.toString()) {
      const previous = instance.getModel()
      instance.setModel(monaco.editor.createModel(text, file.endsWith(".ts") ? "typescript" : "javascript", uri))
      previous?.dispose()
    } else if (instance.getValue() !== text) instance.setValue(text)
    instance.updateOptions({ readOnly: readonly })
    updating.current = false
  }, [file, text, readonly])

  return <div className="editor-surface" ref={container} />
}
