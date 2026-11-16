import { ArrowRight, Database, FolderTree, HardDrive } from "lucide-react"

export function CheckpointDiagram() {
  return (
    <figure className="my-5 rounded-xl border bg-muted/30 p-4">
      <figcaption className="mb-3 text-sm font-semibold">Save a checkpoint · inside your browser</figcaption>
      <ol className="grid gap-2 sm:grid-cols-[1fr_auto_1fr_auto_1fr] sm:items-stretch">
        {[
          { title: "Memory", detail: "Working files", icon: FolderTree },
          { title: "SQLite", detail: "Snapshot bytes in checkpoint.image", icon: Database },
          { title: "IndexedDB", detail: "workspace.sqlite for this site", icon: HardDrive }
        ].map(({ title, detail, icon: Icon }, index) => (
          <li key={title} className="contents">
            {index > 0 && (
              <ArrowRight
                aria-hidden="true"
                className="size-4 rotate-90 self-center text-muted-foreground sm:rotate-0"
              />
            )}
            <div className="min-w-0 rounded-lg border bg-card p-3">
              <Icon aria-hidden="true" className="mb-2 size-4 text-primary" />
              <strong className="block text-sm">{title}</strong>
              <span className="mt-1 block break-words text-xs text-muted-foreground">{detail}</span>
            </div>
          </li>
        ))}
      </ol>
      <div className="mt-3 flex items-center gap-2 border-t pt-2 text-xs text-muted-foreground">
        <ArrowRight aria-hidden="true" className="size-4 shrink-0 rotate-180" />
        <span>
          <strong>Reopen saved</strong> reads the database and restores its snapshot into memory.
        </span>
      </div>
    </figure>
  )
}

export function CallerDiagram() {
  return (
    <figure
      aria-label="Editor and Reader share one virtual file"
      className="my-4 grid grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 rounded-xl border bg-card p-3 text-xs"
    >
      <strong>Editor</strong>
      <span className="flex items-center gap-2 text-muted-foreground">
        Read + write <ArrowRight aria-hidden="true" className="size-3" />
      </span>
      <code className="row-span-2 break-all rounded-md border border-code-border bg-code p-2 text-center font-mono text-code-foreground">
        /src/value.js
      </code>
      <strong>Reader</strong>
      <span className="flex items-center justify-between text-muted-foreground">
        Read <ArrowRight aria-hidden="true" className="size-3" />
      </span>
    </figure>
  )
}
