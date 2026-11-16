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

export function FilePermissions() {
  return (
    <figure className="my-5 rounded-xl border bg-card p-4">
      <figcaption className="mb-4 text-sm font-semibold">File permissions for the starter workspace</figcaption>
      <div className="grid gap-5 sm:grid-cols-2">
        {[
          { paths: ["/main.js", "/src/value.js"], owner: "Editor", mode: "0644", reader: "Read only", editor: "Read and write" },
          { paths: ["/secret.js"], owner: "Admin", mode: "0600", reader: "No access", editor: "No access" }
        ].map(({ paths, owner, mode, reader, editor }) => (
          <div key={mode} className="border-s-2 ps-3 last:border-primary">
            <div className="font-mono text-sm font-semibold sm:min-h-10">
              {paths.map((path) => <div key={path}>{path}</div>)}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">{mode} · owned by {owner}</div>
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt>Reader</dt><dd>{reader}</dd>
              <dt>Editor</dt><dd>{editor}</dd>
              <dt>Admin</dt><dd>Read and write</dd>
            </dl>
          </div>
        ))}
      </div>
    </figure>
  )
}
