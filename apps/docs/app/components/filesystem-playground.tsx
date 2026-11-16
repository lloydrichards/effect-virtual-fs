import { useEffect, useRef, useState } from "react"
import type { Workspace } from "~/lib/playground/volume"
import { Button } from "./ui/button"

export function FilesystemPlayground() {
  const [workspace, setWorkspace] = useState<Workspace>()
  const [files, setFiles] = useState<Array<string>>([])
  const [path, setPath] = useState("/value.js")
  const [source, setSource] = useState("")
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState("Opening the starter files…")
  const [output, setOutput] = useState("")
  const [error, setError] = useState("")
  const locked = useRef(false)

  useEffect(() => {
    let active = true

    async function start() {
      const { openVolume } = await import("~/lib/playground/volume")
      const volume = await openVolume()
      const paths = await volume.files()
      const text = await volume.read("/value.js")

      if (active) {
        setWorkspace(volume)
        setFiles(paths)
        setSource(text)
        setStatus("Starter files open in memory.")
      }
    }

    void start().catch((cause) => {
      if (active) {
        setError(String(cause))
        setStatus("Could not open the workspace.")
      }
    })

    return () => {
      active = false
    }
  }, [])

  async function act(task: (volume: Workspace) => Promise<void>) {
    if (!workspace || locked.current) return
    locked.current = true
    setBusy(true)
    setError("")

    try {
      await task(workspace)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setStatus("Action failed.")
    } finally {
      locked.current = false
      setBusy(false)
    }
  }

  async function select(volume: Workspace, next: string) {
    const text = await volume.read(next)
    setPath(next)
    setSource(text)
  }

  return (
    <fieldset
      disabled={!workspace || busy}
      className="my-6 min-w-0 space-y-4 rounded-xl border bg-card p-4 text-card-foreground"
    >
      <legend className="px-2 font-semibold">Your filesystem</legend>
      <div className="flex flex-wrap gap-2" aria-label="Virtual files">
        {files.map((file) => (
          <Button
            key={file}
            variant={file === path ? "secondary" : "outline"}
            aria-pressed={file === path}
            onClick={() =>
              act(async (volume) => {
                await volume.write(path, source)
                await select(volume, file)
              })}
          >
            {file}
          </Button>
        ))}
      </div>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void act(async (volume) => {
            if (!/^[\w-][\w.-]*$/.test(name)) throw new Error("Enter a filename such as message.js.")

            if (files.includes("/" + name)) throw new Error("A file with that name already exists.")
            await volume.write(path, source)
            await volume.create("/" + name)
            setFiles(await volume.files())
            await select(volume, "/" + name)
            setName("")
            setStatus("Added a file to the working copy.")
            setOutput("")
          })
        }}
      >
        <input
          aria-label="New filename"
          placeholder="message.js"
          value={name}
          maxLength={100}
          onChange={(event) => setName(event.target.value)}
          className="rounded border bg-background px-2 text-sm"
        />
        <Button type="submit" variant="outline" disabled={!name}>Add file</Button>
      </form>
      <label className="block font-mono text-sm">
        {path}
        <textarea
          spellCheck={false}
          rows={6}
          value={source}
          onChange={(event) => {
            setSource(event.target.value)
            setOutput("")
            setError("")
            setStatus("Working copy edited.")
          }}
          className="mt-2 block w-full rounded-lg border bg-background p-3 font-mono text-sm"
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() =>
            act(async (volume) => {
              setStatus("Building /main.js…")
              setOutput("")
              await volume.write(path, source)
              const { buildWorkspace } = await import("~/lib/playground/build")
              const result = await buildWorkspace(volume)
              setOutput(result.code)
              setStatus("Built from " + result.reads.join(", "))
            })}
        >
          Run build
        </Button>
        <Button
          variant="outline"
          onClick={() =>
            act(async (volume) => {
              setStatus("Saving checkpoint…")
              await volume.write(path, source)
              const { saveCheckpoint } = await import("~/lib/playground/storage")
              await saveCheckpoint(await volume.snapshot())
              setStatus("Saved workspace.sqlite in this browser.")
            })}
        >
          Save checkpoint
        </Button>
        <Button
          variant="outline"
          onClick={() =>
            act(async () => {
              const { readCheckpoint } = await import("~/lib/playground/storage")
              const checkpoint = await readCheckpoint()
              setStatus(`SQLite row: saved_at = ${checkpoint.savedAt}, length(image) = ${checkpoint.size} bytes.`)
            })}
        >
          Inspect saved row
        </Button>
        <Button
          variant="outline"
          onClick={() =>
            act(async () => {
              const { readCheckpoint } = await import("~/lib/playground/storage")
              const { openVolume } = await import("~/lib/playground/volume")
              const { image } = await readCheckpoint()
              const saved = await openVolume(image)
              const paths = await saved.files()
              await select(saved, paths.includes(path) ? path : "/value.js")
              setWorkspace(saved)
              setFiles(paths)
              setOutput("")
              setStatus("Reopened the saved checkpoint.")
            })}
        >
          Reopen saved
        </Button>
      </div>
      <p role="status" className="text-sm text-muted-foreground">{status}</p>
      {error && <pre role="alert" className="whitespace-pre-wrap break-words text-sm text-destructive">{error}</pre>}
      {output && (
        <section aria-label="Generated bundle">
          <h3 className="mb-2 text-sm font-semibold">Generated bundle</h3>
          <pre className="overflow-auto rounded-lg bg-muted p-3 text-sm"><code>{output}</code></pre>
        </section>
      )}
    </fieldset>
  )
}
