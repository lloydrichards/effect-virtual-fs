import { useAtomValue } from "@effect/atom-react"
import { ArrowRight, Database, FolderTree, HardDrive } from "lucide-react"

import { playgroundAtom } from "~/lib/playground/atoms"

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

function accessLabel(mask: number) {
  switch (mask & 6) {
    case 6:
      return "Read and write"
    case 4:
      return "Read only"
    case 2:
      return "Write only"
    default:
      return "No access"
  }
}

export function FilePermissions() {
  const { entries, volume } = useAtomValue(playgroundAtom)

  const groups = new Map<
    string,
    { paths: Array<string>; owner: string; mode: string; reader: string; editor: string }
  >()

  for (const { path, policy } of entries) {
    if (!policy) continue
    const { uid, mode } = policy.metadata
    const key = [uid, mode, policy.reader, policy.editor].join("/")
    const group = groups.get(key)

    if (group) group.paths.push(path)
    else {
      groups.set(key, {
        paths: [path],
        owner: uid === 0 ? "Admin" : uid === 1000 ? "Editor" : uid === 2000 ? "Reader" : String(uid),
        mode: mode.toString(8).padStart(4, "0"),
        reader: accessLabel(policy.reader),
        editor: accessLabel(policy.editor)
      })
    }
  }

  return (
    <figure className="my-5 rounded-xl border bg-card p-4">
      <figcaption className="mb-4 text-sm font-semibold">File permissions for this workspace</figcaption>
      <div className="grid gap-5 sm:grid-cols-2">
        {groups.size === 0 && (
          <span className="text-sm text-muted-foreground">
            {volume ? "No files in this workspace." : "Loading permissions…"}
          </span>
        )}
        {Array.from(groups.values()).map(({ paths, owner, mode, reader, editor }) => (
          <div key={paths[0]} className="border-s-2 ps-3 last:border-primary">
            <div className="break-all font-mono text-sm font-semibold sm:min-h-10">
              {paths.map((path) => <div key={path}>{path}</div>)}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">{mode} · owned by {owner}</div>
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt>Reader</dt>
              <dd>{reader}</dd>
              <dt>Editor</dt>
              <dd>{editor}</dd>
              <dt>Admin</dt>
              <dd>Read and write</dd>
            </dl>
          </div>
        ))}
      </div>
    </figure>
  )
}
