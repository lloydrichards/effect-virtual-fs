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
    <figure className="my-4 rounded-xl border bg-card p-3 text-xs">
      <figcaption className="mb-3 font-semibold">Starter volume · imports read by /main.js</figcaption>
      <table className="w-full text-start">
        <thead>
          <tr className="border-b text-muted-foreground">
            <th scope="col" className="p-1 text-start">Caller</th>
            <th scope="col" className="p-1 text-start font-mono">/src/value.js</th>
            <th scope="col" className="p-1 text-start font-mono">/secret.js</th>
            <th scope="col" className="p-1 text-start">Build</th>
          </tr>
        </thead>
        <tbody>
          {[
            ["Admin", "Read + write", "Read + write", "Succeeds"],
            ["Editor", "Read + write", "Denied", "Fails"],
            ["Reader", "Read", "Denied", "Fails"]
          ].map(([caller, value, secret, build]) => (
            <tr key={caller} className="border-b last:border-0">
              <th scope="row" className="p-1 text-start">{caller}</th>
              <td className="p-1">{value}</td>
              <td className="p-1">{secret}</td>
              <td className="p-1">{build}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  )
}
