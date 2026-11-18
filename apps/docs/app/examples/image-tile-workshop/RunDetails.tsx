import * as Predicate from "effect/Predicate"
import { FileImage, Folder } from "lucide-react"
import { Button } from "~/components/ui/button"
import type { WorkshopView } from "./atoms.ts"
import { grids, outputPath, tilePath } from "./domain.ts"

export function WorkerProgress({ sharedBytes, tasks, setup }: WorkshopView) {
  const applied = tasks.filter((task) => task.status?._tag === "applied").length
  const failed = tasks.filter((task) => task.status?._tag === "failed").length

  return (
    <section className="run-details" aria-label="Render details">
      <div className="run-summary">
        <strong>Worker progress</strong>
        <span>
          {sharedBytes
            ? `${(sharedBytes / 1024 / 1024).toFixed(2)} MiB · SharedArrayBuffer`
            : "Shared source allocated on render"}
        </span>
      </div>
      <div className="worker-lanes">
        {Array.from({ length: setup.workers }, (_, index) => {
          const worker = index + 1
          const jobs = tasks.filter((task) => task.worker === worker)

          const published = jobs.filter((task) =>
            task.status && !Predicate.isTagged(task.status, "assigned") &&
            (!Predicate.isTagged(task.status, "failed") || task.status.stage === "compose")
          ).length

          const failed = jobs.filter((task) => task.status?._tag === "failed" && task.status.stage !== "compose").length

          return (
            <div className="worker-lane" key={worker}>
              <strong>Worker {worker}</strong>
              <progress
                aria-label={`Worker ${worker} tiles published`}
                max={Math.max(1, jobs.length)}
                value={published}
              />
              <span>{jobs.length ? `${published}/${jobs.length} published` : "No tiles assigned"}</span>
              {failed > 0 && <span>{failed} failed</span>}
            </div>
          )
        })}
        <div className="worker-lane">
          <strong>Compositor</strong>
          <progress aria-label="Compositor tiles applied" max={Math.max(1, tasks.length)} value={applied} />
          <span>{tasks.length ? `${applied}/${tasks.length} applied` : "Waiting for tiles"}</span>
          {failed > 0 && <span>{failed} unavailable</span>}
        </div>
      </div>
    </section>
  )
}

export function FilesystemTree({ view, inspect }: {
  readonly view: WorkshopView
  readonly inspect: (tile: number) => void
}) {
  const files = Object.values(view.tiles).flatMap((tile) => tile?.committed ? [tile.committed] : [])

  return (
    <details className="files">
      <summary>Inspect virtual filesystem</summary>
      {view.sharedBytes === 0 ?
        <p className="muted">Render an image to create the volume.</p> :
        (
          <ul className="file-tree" aria-label="Virtual filesystem">
            <li>
              <span>
                <Folder aria-hidden="true" /> <code>/</code>
              </span>
              <ul>
                <li>
                  <details open>
                    <summary>
                      <Folder aria-hidden="true" /> <code>tiles/</code>
                    </summary>
                    <ul>
                      {files.length === 0 && <li className="muted">No tile files yet</li>}
                      {files.map(({ tile, version }) => (
                        <li key={tile}>
                          <Button type="button" variant="ghost" size="sm" onClick={() => inspect(tile)}>
                            <FileImage aria-hidden="true" />
                            <code>{tilePath(tile, grids[view.setup.grid].columns).split("/").at(-1)}</code>
                            <span className="muted">v{version}</span>
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </details>
                </li>
                <li>
                  <details open>
                    <summary>
                      <Folder aria-hidden="true" /> <code>output/</code>
                    </summary>
                    <ul>
                      {view.exported
                        ? (
                          <li>
                            <span>
                              <FileImage aria-hidden="true" /> <code>{outputPath.split("/").at(-1)}</code>
                            </span>
                          </li>
                        )
                        : <li className="muted">Created on download</li>}
                    </ul>
                  </details>
                </li>
                <li>
                  <span>
                    <Folder aria-hidden="true" /> <code>staging/</code>
                  </span>
                </li>
              </ul>
            </li>
          </ul>
        )}
    </details>
  )
}
