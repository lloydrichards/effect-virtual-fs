import { RegistryProvider, useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import {
  Braces,
  ChevronRight,
  Database,
  FileCode2,
  FilePlus2,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  Play,
  RotateCcw,
  Save,
  Terminal,
  Trash2
} from "lucide-react"
import { useEffect, useState } from "react"
import {
  checkpointAtom,
  commandAtom,
  editAtom,
  type Entry,
  type Operation,
  playgroundAtom
} from "~/lib/playground/atoms"
import { PlaygroundBundle } from "./playground-bundle"
import { PlaygroundEditor } from "./playground-editor"
import { Button } from "./ui/button"
import { Input } from "./ui/input"
import { NativeSelect } from "./ui/native-select"
import { Skeleton } from "./ui/skeleton"

function FileList({ entries, parent, selected, onSelect }: {
  entries: ReadonlyArray<Entry>
  parent: string
  selected: string
  onSelect: (entry: Entry) => void
}) {
  const [collapsed, setCollapsed] = useState<ReadonlyArray<string>>([])

  return (
    <ul className="space-y-0.5">
      {entries.filter(({ path }) => path.slice(0, path.lastIndexOf("/")) === parent).map((entry) => {
        const name = entry.path.slice(parent.length + 1)

        const expanded = !collapsed.includes(entry.path)
        const Icon = entry.directory ? Folder : FileCode2

        return (
          <li key={entry.path}>
            <div className="flex items-center">
              {entry.directory && (
                <button
                  type="button"
                  aria-label={`${expanded ? "Collapse" : "Expand"} ${entry.path}`}
                  aria-expanded={expanded}
                  onClick={() =>
                    setCollapsed(expanded ? [...collapsed, entry.path] : collapsed.filter((p) => p !== entry.path))}
                  className="grid size-6 shrink-0 place-items-center rounded hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring pointer-coarse:size-11"
                >
                  <ChevronRight className={expanded ? "size-3 rotate-90" : "size-3"} />
                </button>
              )}
              <button
                type="button"
                aria-label={entry.path}
                aria-current={entry.path === selected ? "true" : undefined}
                onClick={() => onSelect(entry)}
                className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-2 py-1.5 text-left font-mono text-xs hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring pointer-coarse:min-h-11 aria-current:bg-accent aria-current:font-semibold aria-current:text-primary"
              >
                <Icon className="size-3.5 shrink-0" />
                <span className="break-all">{name}</span>
              </button>
            </div>
            {entry.directory && expanded && (
              <div className="ms-3 border-s ps-1">
                <FileList entries={entries} parent={entry.path} selected={selected} onSelect={onSelect} />
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

export function FilesystemPlayground() {
  return (
    <RegistryProvider>
      <WorkspacePanel />
    </RegistryProvider>
  )
}

function WorkspacePanel() {
  const { volume, role, permissions, entries, path, source, dirty, folder, busy, status, output, error } = useAtomValue(
    playgroundAtom
  )

  const run = useAtomSet(commandAtom, { mode: "promise" })
  const edit = useAtomSet(editAtom)
  const checkpoint = useAtomValue(checkpointAtom)
  const refresh = useAtomRefresh(checkpointAtom)
  const hasCheckpoint = AsyncResult.isSuccess(checkpoint) && checkpoint.value
  const selected = folder || path
  const renameAction = folder ? "Rename folder" : "Rename file"
  const [operation, setOperation] = useState<Operation | null>(null)
  const [name, setName] = useState("")

  useEffect(() => {
    void run("open")
    window.addEventListener("focus", refresh)

    return () => window.removeEventListener("focus", refresh)
  }, [refresh, run])

  const closeOnSuccess = (success: boolean) => {
    if (success) setOperation(null)
  }

  const opening = !volume && !error
  const writable = (permissions & 2) !== 0

  return (
    <fieldset
      disabled={!volume || busy}
      className="my-5 min-w-0 overflow-hidden rounded-xl border border-code-block-border bg-card text-card-foreground shadow-sm"
    >
      <legend className="sr-only">Virtual filesystem editor</legend>
      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2">
        <span className="me-auto inline-flex items-center gap-2 text-sm font-semibold">
          <Terminal className="size-4 text-primary" />Workspace
        </span>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Caller
          <NativeSelect
            value={role}
            onChange={(event) => {
              const next = event.target.value

              if (next === "admin" || next === "editor" || next === "reader") {
                void run({ role: next }).then(
                  closeOnSuccess
                )
              }
            }}
          >
            <option value="admin">Admin</option>
            <option value="editor">Editor</option>
            <option value="reader">Reader</option>
          </NativeSelect>
        </label>
        <Button onClick={() => void run("build")}>
          <Play />Run build
        </Button>
      </div>
      <div aria-busy={opening} className="grid min-w-0 sm:grid-cols-[minmax(8rem,28%)_minmax(0,1fr)]">
        <aside aria-label="Project files" className="min-w-0 border-b bg-sidebar p-2 sm:border-e sm:border-b-0">
          <div className="mb-1 flex items-center gap-1.5 px-1 text-xs font-semibold">
            <FolderOpen className="size-4" />Files
          </div>
          <div className="mb-2 flex flex-wrap gap-1 border-b pb-1">
            {([
              ["New file", FilePlus2],
              ["New folder", FolderPlus],
              [renameAction, Pencil]
            ] as const).map(([action, Icon]) => (
              <Button
                key={action}
                size="icon-xs"
                className="pointer-coarse:size-11"
                variant="ghost"
                aria-label={action}
                title={action}
                disabled={role === "reader" || (action === renameAction && !selected)}
                onClick={() => {
                  setOperation(operation === action ? null : action)
                  setName(
                    action === renameAction
                      ? selected.slice(1)
                      : folder
                      ? folder.slice(1) + "/"
                      : path.slice(1, path.lastIndexOf("/") + 1)
                  )
                }}
              >
                <Icon />
              </Button>
            ))}
            <Button
              size="icon-xs"
              className="pointer-coarse:size-11"
              variant="ghost"
              aria-label={folder ? "Delete folder" : "Delete file"}
              title={folder ? `Delete ${folder} and its contents` : `Delete ${path}`}
              disabled={role === "reader" || !selected}
              onClick={() => void run("deleteEntry").then(closeOnSuccess)}
            >
              <Trash2 />
            </Button>
          </div>
          {operation && (
            <form
              className="mb-2 space-y-1"
              onSubmit={(event) => {
                event.preventDefault()
                void run({ operation, name }).then(closeOnSuccess)
              }}
            >
              <Input
                aria-label={operation + " path"}
                placeholder={operation === "New folder" ? "src/lib" : "src/message.js"}
                value={name}
                maxLength={150}
                onChange={(event) => setName(event.target.value)}
                className="rounded-md font-mono"
              />
              <Button type="submit" size="xs" variant="outline">
                {operation === "New folder" ? "Add folder" : operation === renameAction ? "Rename" : "Add file"}
              </Button>
            </form>
          )}
          {opening ?
            (
              <div aria-hidden="true" className="px-2">
                {["mb-0.5 w-16", "mb-0.5 w-20", "w-12", "ms-3 w-20"].map((row) => (
                  <div key={row} className={`flex h-7 max-w-full items-center pointer-coarse:h-11 ${row}`}>
                    <Skeleton className="h-2 w-full rounded motion-reduce:animate-none" />
                  </div>
                ))}
              </div>
            ) :
            (
              <FileList
                entries={entries}
                parent=""
                selected={selected}
                onSelect={(entry) => void run({ select: entry }).then(closeOnSuccess)}
              />
            )}
        </aside>
        <div className="min-w-0 bg-code-block">
          <div className="flex flex-wrap items-center gap-2 border-b bg-card px-3 py-2 font-mono text-xs">
            <Braces className="size-3.5 text-primary" />
            <span className="break-all">{path || "No file open"}{dirty && <span aria-label="Modified">*</span>}</span>
            <span className="ms-auto text-muted-foreground">{path && (writable ? "Read / write" : "Read only")}</span>
          </div>
          <div className="h-[clamp(18rem,48vh,32rem)]">
            {volume ?
              (
                <PlaygroundEditor
                  path={path}
                  label={`Edit ${path}`}
                  value={source}
                  readOnly={!writable || busy}
                  onEdit={edit}
                />
              ) :
              opening && (
                <div aria-hidden="true" className="space-y-4 p-4">
                  <Skeleton className="h-2.5 w-3/5 rounded motion-reduce:animate-none" />
                  <Skeleton className="h-2.5 w-1/3 rounded motion-reduce:animate-none" />
                </div>
              )}
          </div>
        </div>
      </div>
      <div className="border-t bg-muted/30 px-3 py-2">
        <p role="status" className="break-words font-mono text-xs text-muted-foreground">{status}</p>
        {error && (
          <pre role="alert" className="mt-2 whitespace-pre-wrap break-words text-xs text-destructive">{error}</pre>
        )}
        {output && (
          <div className="mt-2">
            <h3 className="text-xs font-semibold">Generated bundle</h3>
            <PlaygroundBundle source={output} />
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1 border-t p-2">
        <Button
          variant="outline"
          onClick={() => void run("save")}
        >
          <Save />Save checkpoint
        </Button>
        <Button
          variant="ghost"
          disabled={!hasCheckpoint}
          onClick={() => void run("inspect")}
        >
          <Database />Inspect saved row
        </Button>
        <Button
          variant="ghost"
          disabled={!hasCheckpoint}
          onClick={() => void run("reopen").then(closeOnSuccess)}
        >
          <RotateCcw />Reopen saved
        </Button>
        <Button
          variant="ghost"
          disabled={!hasCheckpoint}
          onClick={() => void run("deleteCheckpoint")}
        >
          <Trash2 />Delete checkpoint
        </Button>
      </div>
    </fieldset>
  )
}
