import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react"
import { lazy, Suspense, useEffect, useState } from "react"
import {
  busyAtom,
  commandAtom,
  draftsAtom,
  errorAtom,
  roleAtom,
  selectedAtom,
  stopAtom,
  workspaceAtom
} from "./atoms.ts"

const Editor = lazy(() => import("./Editor.tsx").then((module) => ({ default: module.Editor })))

import type { SourcePath } from "../workbench/domain.ts"

const sourcePaths = ["/src/index.ts", "/src/format.ts"] as const

export function App() {
  const state = useAtomValue(workspaceAtom)
  const busy = useAtomValue(busyAtom)
  const error = useAtomValue(errorAtom)
  const [drafts, setDrafts] = useAtom(draftsAtom)
  const [selected, select] = useAtom(selectedAtom)
  const [role, setRole] = useAtom(roleAtom)
  const command = useAtomSet(commandAtom)
  const stop = useAtomSet(stopAtom)
  const [panel, setPanel] = useState("Node output")
  useEffect(() => {
    command("view")
  }, [command])
  const dirty = sourcePaths.some((path) => drafts[path] !== undefined)
  const current = !dirty && state?.build?.status === "success" && state.build.revision === state.revision
  const file = state?.files.find((item) => item.path === selected)
  const isSource = sourcePaths.some((path) => path === selected)
  const draft = isSource ? drafts[sourcePaths.find((path) => path === selected)!] : undefined
  const content = draft ?? file?.text ?? "// Compile the project to generate this file.\n"
  const diagnostics = state?.build?.diagnostics ?? []
  const stale = dirty || (state?.build && state.build.revision !== state.revision)

  useEffect(() => {
    if (state?.build?.status === "failed") setPanel("Problems")
  }, [state?.build])

  const editing = (text: string) => {
    const source = sourcePaths.find((path) => path === selected)

    if (!source || busy) return
    const next: Partial<Record<typeof SourcePath.Type, string>> = { ...drafts }

    if (text === file?.text) delete next[source]
    else next[source] = text
    setDrafts(next)
  }

  return (
    <div className="workbench">
      <header className="toolbar">
        <a className="brand" href="/">
          <svg width="25" height="25" viewBox="0 0 26 26" fill="none" aria-hidden="true">
            <path d="M5 22V12c0-4 5-4 8-7V2m0 3c3 3 8 3 8 7v10" stroke="currentColor" strokeWidth="1.7" />
          </svg>
          <span>
            Effect VFS <span className="slash">/</span> <strong>TypeScript workbench</strong>
          </span>
        </a>
        <span className="local">Local · Node 26</span>
      </header>
      <main className="workspace-shell">
        <div className="workspace-heading">
          <div>
            <h1>Your code. A real Node runtime.</h1>
            <p>Edit TypeScript, compile into the virtual filesystem, then run the JavaScript.</p>
          </div>
          <div className="actions">
            <button disabled={!!busy || !state} onClick={() => command("save")}>Save point</button>
            <button disabled={!!busy || !state} onClick={() => command("restore")}>Restore</button>
            <span className="action-divider" />
            <button disabled={!!busy || !state} onClick={() => command("compile")}>Compile</button>
            <button disabled={!!busy || !current} onClick={() => command("run")}>Run</button>
            <button
              className="primary"
              disabled={!!busy || !state}
              onClick={() => {
                setPanel("Node output")
                command("compileRun")
              }}
            >
              {busy === "compileRun" ? "Compiling & running…" : "Compile & Run"}
              <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
                <path d="m3 1 8 5-8 5z" />
              </svg>
            </button>
            {busy && busy !== "view" && (
              <button className="stop" onClick={() => stop(undefined)}>
                Stop & restore
              </button>
            )}
          </div>
        </div>
        <div className="savepoint-strip">
          <span className="snapshot-icon" aria-hidden="true" />
          <strong>{state?.checkpoint ? `Save point ${state.checkpoint}` : "Starting save point"}</strong>
          <span>
            {state ? `Generation ${state.generation} · revision ${state.revision}` : "Starting the Node worker…"}
          </span>
          <span className="savepoint-status">
            {dirty
              ? "Unsaved editor changes"
              : state?.changes.length
              ? `${state.changes.length} filesystem changes`
              : "At save point"}
          </span>
          <button disabled={!!busy || !state} onClick={() => command("reset")}>Reset example</button>
        </div>
        {error && (
          <div className="error-banner" role="alert">
            <strong>The action failed.</strong>
            <pre>{error}</pre>
            <button disabled={!!busy} onClick={() => command("view")}>Refresh state</button>
          </div>
        )}
        <div className="editor-layout">
          <aside className="explorer">
            <div className="explorer-title">
              EXPLORER<span>In memory</span>
            </div>
            <div className="project-name">workspace</div>
            <div className="folder">src</div>
            {sourcePaths.map((path) => (
              <button
                className={selected === path ? "file active" : "file"}
                onClick={() => select(path)}
                key={path}
              >
                <span className="extension ts">TS</span>
                {path.split("/").at(-1)}
                {drafts[path] !== undefined && <span className="dirty-dot" aria-label="Unsaved changes" />}
              </button>
            ))}
            <div className="folder dist">
              dist <span>Node writes here</span>
            </div>
            {["/dist/index.js", "/dist/format.js"].map((path) => (
              <button
                className={selected === path ? "file active" : "file"}
                onClick={() => select(path)}
                key={path}
              >
                <span className="extension js">JS</span>
                {path.split("/").at(-1)}
                {!state?.files.some((file) => file.path === path) && <span className="not-built">—</span>}
              </button>
            ))}
            <div className="explorer-note">
              <strong>One working overlay</strong>
              <p>The starting files stay unchanged. Save a point and return to it whenever you need.</p>
              <details>
                <summary>Caller permissions</summary>
                <p>
                  Editor: writes src<br />Compiler: writes dist<br />Viewer: reads both
                </p>
                <label>
                  Compile as<select
                    value={role}
                    disabled={!!busy}
                    onChange={(event) => setRole(event.target.value === "viewer" ? "viewer" : "compiler")}
                  >
                    <option value="compiler">Compiler</option>
                    <option value="viewer">Viewer</option>
                  </select>
                </label>
              </details>
            </div>
          </aside>
          <section className="editor-column" aria-label="Editor workspace">
            <div className="file-tabs">
              {sourcePaths.map((path) => (
                <button
                  className={selected === path ? "selected" : ""}
                  key={path}
                  onClick={() => select(path)}
                >
                  <span className="extension ts">TS</span>
                  {path.split("/").at(-1)}
                  {drafts[path] !== undefined && <span className="dirty-dot" />}
                </button>
              ))}
              {!isSource && (
                <button className="selected">
                  <span className="extension js">JS</span>
                  {selected.split("/").at(-1)}
                  <span className="readonly">Read only</span>
                </button>
              )}
            </div>
            <div className="breadcrumbs">
              workspace <span>/</span> {selected.slice(1)}
              <span className="file-state">
                {isSource
                  ? "Effect editor caller"
                  : current
                  ? "Current compiled output"
                  : "Saved or prior output · compile to verify"}
              </span>
            </div>
            <Suspense fallback={<div className="editor-surface editor-loading">Loading the code editor…</div>}>
              <Editor file={selected} text={content} readonly={!!busy || !isSource || !state} onChange={editing} />
            </Suspense>
            <section className="bottom-panel" aria-label="Build output">
              <div className="panel-tabs">
                {["Node output", "Problems", "Changes"].map((name) => (
                  <button
                    className={panel === name ? "selected" : ""}
                    aria-pressed={panel === name}
                    key={name}
                    onClick={() => setPanel(name)}
                  >
                    {name}
                    {name === "Problems" && diagnostics.length > 0 && (
                      <span className="badge">{diagnostics.length}</span>
                    )}
                  </button>
                ))}
                <span className="panel-state" role="status">
                  {busy
                    ? busy === "view" ? "Connecting…" : `${busy} in progress…`
                    : current
                    ? `${state?.build?.inputs} mounted inputs verified`
                    : dirty
                    ? "Source changed · compile to verify"
                    : "Ready"}
                </span>
              </div>
              <div className="panel-content">
                {panel === "Node output"
                  ? (
                    <>
                      <div className="output-caption">
                        {state?.runRevision === null || state?.runRevision === undefined
                          ? "No current run"
                          : `Node · generation ${state.generation} · revision ${state.runRevision}`}
                        {dirty || (!!state?.output.length && (!current || state.runRevision !== state.revision))
                          ? " · output is from a prior revision"
                          : ""}
                      </div>
                      {state?.output.length
                        ? state.output.map((item, index) => (
                          <pre className={item.channel === "stderr" ? "stderr" : "stdout"} key={index}>{item.text}</pre>
                        ))
                        : (
                          <p className="panel-empty">
                            Your program’s console output appears here. Compile & Run to begin.
                          </p>
                        )}
                      {state?.truncated && <p className="output-warning">Output stopped at 32,000 characters.</p>}
                    </>
                  )
                  : panel === "Problems"
                  ? (
                    <>
                      <div className="output-caption">
                        {state?.build
                          ? stale
                            ? `Last checked revision ${state.build.revision}. Current editor content has not been checked.`
                            : `Compiler diagnostics · revision ${state.build.revision}`
                          : "Compile to check the project."}
                      </div>
                      {diagnostics.map((item, index) => (
                        <button
                          className="diagnostic"
                          key={index}
                          onClick={() => {
                            if (sourcePaths.some((path) => path === item.file)) select(item.file)
                          }}
                        >
                          <strong>
                            {item.file}
                            {item.line ? `:${item.line}` : ""} · {item.code ? `TS${item.code}` : "Runtime"}
                          </strong>
                          <pre>{item.message}</pre>
                        </button>
                      ))}
                      {!diagnostics.length && (
                        <p className="panel-empty">
                          {state?.build && !stale
                            ? "No compiler errors."
                            : "No diagnostics for the current editor content yet."}
                        </p>
                      )}
                    </>
                  )
                  : (
                    <>
                      {state?.changes.map((change) => (
                        <button
                          className="change-row"
                          key={change.path}
                          onClick={() => select(change.path)}
                        >
                          <span>{change.kind}</span>
                          <code>{change.path}</code>
                        </button>
                      ))}
                      {!state?.changes.length && (
                        <p className="panel-empty">
                          No filesystem changes since the save point. Unsaved buffers appear after Compile or Save
                          point.
                        </p>
                      )}
                    </>
                  )}
              </div>
            </section>
          </section>
        </div>
        <footer>
          <span>
            Effect-owned files <span className="flow-arrow">→</span> TypeScript default host{" "}
            <span className="flow-arrow">→</span> Native Node execution
          </span>
          <span role="status" aria-live="polite">{state?.notice ?? "Preparing the workspace…"}</span>
        </footer>
        <details className="runtime-note">
          <summary>About this runtime</summary>
          <p>
            This is a trusted local code editor, not a security sandbox. Compile & Run executes the synchronous CommonJS
            entrypoint in a Node worker. Console output is captured; direct process writes and asynchronous background
            tasks are outside this first version. Runs have a three-second limit. Stop restores the last save point. All
            tabs share this local workspace.
          </p>
          <p>
            The compiler, standard libraries and Node declarations live in the mounted VFS. The browser editor supplies
            syntax highlighting; the actual Node compiler supplies Problems. No project files are staged on disk.
          </p>
        </details>
      </main>
    </div>
  )
}
