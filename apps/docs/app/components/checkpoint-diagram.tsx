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

const accessStyles = {
  write: { label: "Read + write", color: "text-primary", dash: undefined },
  read: { label: "Read only", color: "text-foreground", dash: "7 4" },
  denied: { label: "No access", color: "text-muted-foreground", dash: "1 5" }
} as const

const callers = [
  { name: "Reader", uid: 2000, access: ["read", "denied"] },
  { name: "Editor", uid: 1000, access: ["write", "denied"] },
  { name: "Admin", uid: 0, access: ["write", "write"] }
] as const

const files = [
  { path: "/src/value.js", mode: "0644", owner: "Editor" },
  { path: "/secret.js", mode: "0600", owner: "Admin" }
] as const

export function CallerDiagram() {
  return (
    <figure className="my-5 rounded-xl border bg-muted/30 p-3 sm:p-4">
      <figcaption className="mb-3 text-sm font-semibold">Who can read and write the starter files?</figcaption>
      <ul aria-label="Access levels" className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-xs">
        {Object.entries(accessStyles).map(([key, { label, color, dash }]) => (
          <li key={key} className="flex items-center gap-1.5">
            <svg aria-hidden="true" width="24" height="8" className={color}>
              <path d="M1 4 H23" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray={dash} />
            </svg>
            {label}
          </li>
        ))}
      </ul>
      <div className="mt-4 grid grid-cols-[auto_minmax(2rem,1fr)_auto] items-center text-xs">
        <div className="grid h-60 grid-rows-3 items-center">
          {callers.map(({ name, uid, access }) => (
            <div key={name} className="rounded-lg border bg-card px-2 py-1.5 sm:px-3">
              <strong className="block text-sm">{name}</strong>
              <span className="font-mono text-muted-foreground">UID {uid}</span>
              <span className="sr-only">
                {access.map((level, i) => files[i]!.path + ": " + accessStyles[level].label).join(". ")}
              </span>
            </div>
          ))}
        </div>
        <svg aria-hidden="true" viewBox="0 0 100 240" preserveAspectRatio="none" className="h-60 w-full">
          {callers.flatMap(({ name, access }, row) =>
            access.map((level, file) => {
              const start = 40 + row * 80 + (file === 0 ? -7 : 7)
              const end = 60 + file * 120 + (row - 1) * 12
              const { color, dash } = accessStyles[level]

              return (
                <path
                  key={name + file}
                  d={`M0 ${start} C32 ${start} 68 ${end} 100 ${end}`}
                  className={color}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeDasharray={dash}
                  vectorEffect="non-scaling-stroke"
                />
              )
            })
          )}
        </svg>
        <div className="grid h-60 grid-rows-2 items-center">
          {files.map(({ path, mode, owner }) => (
            <div key={path} className="rounded-lg border bg-card px-2 py-2 sm:px-3">
              <strong className="block font-mono">{path}</strong>
              <span className="font-mono text-muted-foreground">{mode}</span>
              <span className="block text-muted-foreground">Owner · {owner}</span>
            </div>
          ))}
        </div>
      </div>
      <p className="mt-3 border-t pt-2 text-xs text-muted-foreground">
        Admin is privileged. For other callers, the file mode sets access for the owner, group, and everyone else.
        The build reads each import as the selected caller.
      </p>
    </figure>
  )
}
