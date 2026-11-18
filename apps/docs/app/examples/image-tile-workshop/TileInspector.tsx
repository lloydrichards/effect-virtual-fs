import * as Match from "effect/Match"
import { Button } from "~/components/ui/button"
import { NativeSelect } from "~/components/ui/native-select"
import type { TileStatus, TileView } from "./atoms.ts"
import { filterLabels, tilePath } from "./domain.ts"

function describe(event: TileStatus) {
  return Match.value(event).pipe(Match.tagsExhaustive({
    assigned: ({ previousWorker, worker }) =>
      previousWorker === null
        ? `Worker ${worker} assigned to read the shared source pixels.`
        : `Worker ${previousWorker} → Worker ${worker}. Rebuild assigned from shared source pixels.`,
    committed: ({ version, worker }) => `Worker ${worker} published version ${version} to VFS.`,
    applied: ({ version }) => `Compositor opened version ${version} from VFS and updated the preview.`,
    failed: ({ message, stage, worker }) => {
      const step = stage === "compose" ? "Compositor" : stage === "publish" ? "VFS publish" : `Worker ${worker}`

      return `${step} failed. ${message}`
    }
  }))
}

export function tileState(tile?: TileView) {
  switch (tile?.latest._tag) {
    case "assigned":
      return `Worker ${tile.latest.worker} processing`
    case "committed":
      return "Committed · awaiting compositor"
    case "applied":
      return "Visible"
    case "failed":
      return "Failed"
    default:
      return "Queued"
  }
}

export function TileInspector({ busy, rebuild, selected, tile, count, columns, positions, swap }: {
  readonly count: number
  readonly columns: number
  readonly busy: boolean
  readonly rebuild: () => void
  readonly positions: ReadonlyArray<{ readonly position: number; readonly tile: number }>
  readonly swap: (position: number) => void
  readonly selected: number | undefined
  readonly tile: TileView | undefined
}) {
  return (
    <aside className="inspector" aria-labelledby="inspector-title">
      <div className="inspector-heading">
        <h2 id="inspector-title">Tile inspector</h2>
      </div>
      <div className="tile-file">
        <h3>{selected === undefined ? "Select tiles" : `Tile ${selected + 1}`}</h3>
        <span className="muted">{count} selected</span>
      </div>
      <p className="tile-path">
        {selected === undefined ? "Click tiles to select them." : <code>{tilePath(selected, columns)}</code>}
      </p>
      <div className="tile-summary" aria-live="polite">
        <p>
          {tile?.visible ? `Version ${tile.visible.version} · Worker ${tile.visible.worker}` : "No tile in preview"}
        </p>
        <p className="muted">{tile?.visible ? filterLabels[tile.visible.filter] : "—"}</p>
        <p>{tile ? tileState(tile) : "—"}</p>
      </div>
      <Button type="button" variant="outline" className="rebuild" onClick={rebuild} disabled={busy || !tile}>
        {count > 1 ? `Rebuild ${count} tiles` : tile?.latest._tag === "failed" ? "Retry rebuild" : "Rebuild tile"}
      </Button>
      <div className="tile-swap">
        <NativeSelect
          aria-label="Swap with position"
          value=""
          disabled={busy || count !== 1 || !tile?.visible || positions.length === 0}
          onChange={(event) => swap(Number(event.currentTarget.value))}
        >
          <option value="" disabled>Swap with position…</option>
          {positions.map(({ position, tile }) => (
            <option key={position} value={position}>{`Position ${position + 1} · Tile ${tile + 1}`}</option>
          ))}
        </NativeSelect>
      </div>
      <details className="history">
        <summary>Tile history</summary>
        <ol aria-live="polite">
          {tile ?
            Array.from(tile.history).reverse().map((event, index) => (
              <li key={tile.history.length - index} data-event={event._tag}>
                <small>Version {event.version} · {filterLabels[event.filter]}</small>
                <div>{describe(event)}</div>
              </li>
            )) :
            <li className="muted">Select a tile to see its events.</li>}
        </ol>
      </details>
    </aside>
  )
}
