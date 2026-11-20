import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { SharedMemory } from "effect/workers"
import { Check } from "lucide-react"
import { type CSSProperties, useEffect, useRef, useState } from "react"
import { Button } from "~/components/ui/button"
import { NativeSelect } from "~/components/ui/native-select"
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group"
import { actionAtom, busyAtom, errorAtom, initialWorkshop, selectionAtom, workshopAtom } from "./atoms.ts"
import { loadPicture, type Picture, pngUrl, sampleImage, samplePicture } from "./browser-image.ts"
import { boundsOf, defaultSetup, Filter, filterLabels, grids, TileGrid, WorkerCount } from "./domain.ts"
import { FilesystemTree, WorkerProgress } from "./RunDetails.tsx"
import { TileInspector, tileState } from "./TileInspector.tsx"

function TileImage({ bytes }: { readonly bytes: Uint8Array }) {
  const image = useRef<HTMLImageElement>(null)
  useEffect(() => {
    const url = pngUrl(bytes)

    if (image.current) image.current.src = url

    return () => URL.revokeObjectURL(url)
  }, [bytes])

  return <img ref={image} alt="" draggable={false} />
}

export function WorkshopView() {
  const [sample, setSample] = useState<Picture>()
  const [currentPicture, setPicture] = useState<Picture>()
  const picture = currentPicture ?? sample
  const [sourceView, setSourceView] = useState(false)
  const [fileError, setFileError] = useState("")
  const [loading, setLoading] = useState(false)
  const [multiSelect, setMultiSelect] = useState(false)
  const [selection, setSelection] = useAtom(selectionAtom)
  const [filter, setFilter] = useState<Filter>("blur")
  const [setup, setSetup] = useState(defaultSetup)
  const selected = selection.at(-1)
  const [view, setView] = useAtom(workshopAtom)
  const { sharedBytes, tiles } = view
  const busy = useAtomValue(busyAtom)
  const error = useAtomValue(errorAtom)
  const perform = useAtomSet(actionAtom)
  const sourceImage = useRef<HTMLCanvasElement>(null)
  const filePicker = useRef<HTMLInputElement>(null)
  const isolated = sample !== undefined && SharedMemory.isAvailable()
  const { height, width } = picture?.canvas ?? sampleImage
  const name = picture?.name ?? sampleImage.name
  const grid = grids[view.setup.grid]
  const tileCount = grid.columns * grid.rows
  const visibleCount = Object.values(tiles).filter((tile) => tile?.visible).length
  const hasRender = sharedBytes > 0

  useEffect(() => {
    Effect.runSync(samplePicture.pipe(Effect.match({
      onFailure: (error) => setFileError(error.message),
      onSuccess: setSample
    })))
  }, [])

  useEffect(() => {
    const context = sourceImage.current?.getContext("2d")

    if (!picture || !context) return

    context.clearRect(0, 0, picture.canvas.width, picture.canvas.height)
    context.drawImage(picture.canvas, 0, 0)
  }, [picture])

  function render(next: Picture) {
    setPicture(next)
    setSourceView(false)
    setFileError("")
    perform({ kind: "render", picture: next, filter, setup })
  }

  // oxlint-disable-next-line effecttsgo/async-function -- React owns the file input and awaits the browser decoder.
  async function importImage(file: File) {
    if (loading || busy || !isolated) return
    setLoading(true)
    setFileError("")

    try {
      render(await Effect.runPromise(loadPicture(file)))
    } catch (error) {
      setFileError(error instanceof Error ? error.message : "That image could not be opened.")
    } finally {
      setLoading(false)
    }
  }

  const locked = loading || busy !== null

  return (
    <section aria-label="Image tile workshop" className="workshop">
      <div className="intro">
        <div className="effect-control effects">
          <span id="workshop-effect-label">Effect</span>
          <ToggleGroup
            aria-labelledby="workshop-effect-label"
            variant="outline"
            size="sm"
            spacing={0}
            value={[filter]}
            disabled={locked}
            onValueChange={([value]) => {
              if (Schema.is(Filter)(value)) setFilter(value)
            }}
          >
            {Filter.literals.map((value) => (
              <ToggleGroupItem
                key={value}
                value={value}
                className="text-xs aria-pressed:bg-accent aria-pressed:text-accent-foreground"
              >
                {filterLabels[value]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        <div className="actions">
          <Button
            type="button"
            variant="outline"
            onClick={() => filePicker.current?.click()}
            disabled={locked || !isolated}
          >
            Open image
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={locked || !isolated}
            onClick={() => {
              if (!sample) return
              setPicture(sample)
              setSelection([])
              setView(initialWorkshop)
              setFileError("")
              setSourceView(true)
            }}
          >
            Load sample
          </Button>
          <Button
            type="button"
            onClick={() => {
              if (picture) render(picture)
            }}
            disabled={locked || !isolated}
          >
            {busy === "render" ? "Rendering…" : "Render"}
          </Button>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/avif"
            ref={filePicker}
            aria-label="Open image file"
            hidden
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              event.currentTarget.value = ""

              if (file) void importImage(file)
            }}
          />
        </div>
      </div>

      <details className="setup">
        <summary>Render settings</summary>
        <div className="setup-controls">
          <label className="effect-control">
            <span>Workers</span>
            <NativeSelect
              value={setup.workers}
              disabled={locked}
              onChange={(event) => {
                const workers = Number(event.currentTarget.value)

                if (Schema.is(WorkerCount)(workers)) setSetup({ ...setup, workers })
              }}
            >
              {WorkerCount.literals.map((workers) => <option key={workers} value={workers}>{workers}</option>)}
            </NativeSelect>
          </label>
          <label className="effect-control">
            <span>Tile grid</span>
            <NativeSelect
              value={setup.grid}
              disabled={locked}
              onChange={(event) => {
                const grid = event.currentTarget.value

                if (Schema.is(TileGrid)(grid)) setSetup({ ...setup, grid })
              }}
            >
              {TileGrid.literals.map((grid) => <option key={grid} value={grid}>{grid.replace("x", " × ")}</option>)}
            </NativeSelect>
          </label>
        </div>
        <p className="muted">Select Render to apply settings to the current image.</p>
      </details>

      {sample && !isolated && (
        <p role="alert" className="error">
          Sharing pixels requires a secure context and cross-origin isolation. Check the workshop response headers.
        </p>
      )}
      {(fileError || error) && <p role="alert" className="error">{fileError || error}</p>}

      <div className="workspace">
        <section className="canvas-panel" aria-label="Image workspace">
          <div className="canvas-toolbar">
            <div className="picture-name">
              <strong title={name}>{name}</strong>
              <span>{width} × {height} px</span>
            </div>
            <ToggleGroup
              aria-label="Image view"
              variant="outline"
              size="sm"
              spacing={0}
              value={[sourceView || !hasRender ? "source" : "tiles"]}
              onValueChange={([value]) => {
                if (value) setSourceView(value === "source")
              }}
            >
              <ToggleGroupItem value="source">Source</ToggleGroupItem>
              <ToggleGroupItem value="tiles" disabled={!hasRender}>Tiles</ToggleGroupItem>
            </ToggleGroup>
          </div>
          <div
            className="canvas-stage"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault()
              const file = event.dataTransfer.files[0]

              if (file) void importImage(file)
            }}
          >
            <div
              className="picture"
              style={{ aspectRatio: `${width} / ${height}`, maxWidth: `${480 * width / height}px` }}
            >
              <canvas
                width={width}
                height={height}
                ref={sourceImage}
                hidden={hasRender && !sourceView}
                aria-label="Source image"
              />
              {hasRender && !sourceView && view.order.map((id, position) => {
                const bounds = boundsOf({ width, height }, position, grid)
                const tile = tiles[id]
                const stage = tile?.latest._tag ?? "queued"
                const checked = selection.includes(id)

                const style: CSSProperties = {
                  left: `${100 * bounds.x / width}%`,
                  top: `${100 * bounds.y / height}%`,
                  width: `${100 * bounds.width / width}%`,
                  height: `${100 * bounds.height / height}%`
                }

                return (
                  <button
                    key={id}
                    className="tile"
                    type="button"
                    aria-label={`Tile ${id + 1}, ${tileState(tile)}`}
                    aria-pressed={checked}
                    data-stage={stage}
                    style={style}
                    onClick={(event) => {
                      if (multiSelect || event.shiftKey) {
                        setSelection(checked ? selection.filter((tile) => tile !== id) : [...selection, id])
                      } else {
                        setSelection(checked && selection.length === 1 ? [] : [id])
                      }
                    }}
                  >
                    {tile?.visible && <TileImage bytes={tile.visible.png} />}
                    {checked && (
                      <span className="tile-check">
                        <Check size={14} aria-hidden="true" />
                      </span>
                    )}
                    <span className="tile-label">
                      {stage === "assigned" ? `W${tile?.latest.worker}` : stage === "committed" ? "VFS" : id + 1}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
          <div className="canvas-footer">
            <span role="status">
              {loading ? "Opening image…" : hasRender
                ? `${visibleCount} of ${tileCount} tiles visible`
                : "Drop an image here or select Render."}
            </span>
            <Button
              variant={multiSelect ? "secondary" : "ghost"}
              type="button"
              size="sm"
              aria-pressed={multiSelect}
              disabled={!hasRender || sourceView}
              onClick={() => setMultiSelect(!multiSelect)}
            >
              Multi-select
            </Button>
            <Button
              variant="outline"
              type="button"
              disabled={locked || visibleCount !== tileCount}
              onClick={() => perform({ kind: "download" })}
            >
              Download PNG
            </Button>
          </div>
        </section>

        <TileInspector
          count={selection.length}
          columns={grid.columns}
          busy={locked}
          positions={view.order.flatMap((tile, position) =>
            tile !== selected && tiles[tile]?.visible ? [{ tile, position }] : []
          )}
          swap={(position) => {
            if (selected !== undefined) perform({ kind: "swap", tile: selected, position })
          }}
          selected={selected}
          tile={selected === undefined ? undefined : tiles[selected]}
          rebuild={() => {
            if (selection.length) perform({ kind: "rebuild", tiles: selection, filter })
          }}
        />
      </div>

      <WorkerProgress {...view} />
      <FilesystemTree
        view={view}
        inspect={(tile) => {
          setSourceView(false)
          setSelection([tile])
        }}
      />
    </section>
  )
}
