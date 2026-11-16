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
    <table className="my-5 w-full text-left text-sm">
      <caption className="pb-3 text-left font-semibold">Caller permissions for the starter files</caption>
      <thead>
        <tr className="border-b align-bottom">
          <th scope="col" className="py-2 pr-2">Caller</th>
          <th scope="col" className="px-2 py-2">
            <span className="block font-mono text-xs">/main.js</span>
            <span className="block font-mono text-xs">/src/value.js</span>
            <span className="text-xs font-normal text-muted-foreground">Editor · 0644</span>
          </th>
          <th scope="col" className="py-2 pl-2">
            <span className="block font-mono text-xs">/secret.js</span>
            <span className="text-xs font-normal text-muted-foreground">Admin · 0600</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {[
          ["Reader", "Read only", "No access"],
          ["Editor", "Read and write", "No access"],
          ["Admin", "Read and write", "Read and write"]
        ].map(([caller, publicAccess, privateAccess]) => (
          <tr key={caller} className="border-b last:border-0">
            <th scope="row" className="py-2 pr-2 font-medium">{caller}</th>
            <td className="px-2 py-2">{publicAccess}</td>
            <td className="py-2 pl-2">{privateAccess}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
