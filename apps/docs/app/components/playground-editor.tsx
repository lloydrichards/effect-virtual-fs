import { defaultKeymap, history, historyKeymap } from "@codemirror/commands"
import { javascript } from "@codemirror/lang-javascript"
import { syntaxHighlighting } from "@codemirror/language"
import { Annotation, Compartment, EditorState, Transaction } from "@codemirror/state"
import { EditorView, keymap, lineNumbers } from "@codemirror/view"
import { classHighlighter } from "@lezer/highlight"
import { useLayoutEffect, useRef } from "react"
import "~/styles/playground-editor.css"

const externalChange = Annotation.define<boolean>()

interface Props {
  path: string
  label: string
  value: string
  readOnly: boolean
  onEdit?: (text: string) => void
}

export function PlaygroundEditor({ path, label, value, readOnly, onEdit }: Props) {
  const container = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const access = useRef(new Compartment())

  useLayoutEffect(() => {
    if (!container.current) return

    const editor = new EditorView({
      parent: container.current,
      extensions: [
        access.current.of([]),
        EditorView.contentAttributes.of({ "aria-label": label, spellcheck: "false" }),
        /\.[cm]?jsx?$/i.test(path)
          ? [javascript({ jsx: path.endsWith(".jsx") }), syntaxHighlighting(classHighlighter)]
          : [],
        onEdit ? [lineNumbers(), history(), keymap.of([...defaultKeymap, ...historyKeymap])] : []
      ]
    })

    view.current = editor

    return () => {
      view.current = null
      editor.destroy()
    }
  }, [path, label, onEdit])

  useLayoutEffect(() => {
    const editor = view.current

    if (editor && editor.state.doc.toString() !== value) {
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: value },
        filter: false,
        annotations: [Transaction.addToHistory.of(false), externalChange.of(true)]
      })
    }
  }, [value, path, label, onEdit])

  useLayoutEffect(() => {
    view.current?.dispatch({
      effects: access.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
        EditorView.contentAttributes.of({ "aria-readonly": String(readOnly), tabindex: "0" }),
        EditorView.updateListener.of((update) => {
          if (onEdit && update.docChanged && !update.transactions.some((tr) => tr.annotation(externalChange))) {
            onEdit(update.state.doc.toString())
          }
        })
      ])
    })
  }, [readOnly, path, label, onEdit])

  return <div ref={container} className={onEdit ? "playground-editor" : "playground-editor playground-bundle"} />
}
