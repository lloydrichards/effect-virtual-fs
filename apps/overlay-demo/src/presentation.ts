import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { Console, Effect } from "effect"
import * as Ansi from "effect-boxes/Ansi"
import * as Box from "effect-boxes/Box"

export type AgentRole = "planner" | "author" | "reviewer"

export interface ToolAction {
  readonly actor: AgentRole
  readonly tool: "list" | "read" | "write"
  readonly path: string
  readonly detail?: string
}

export interface RestoredFile {
  readonly path: string
  readonly content: string
}

const actorColors: Record<AgentRole, Ansi.AnsiAnnotation> = {
  planner: Ansi.magenta,
  author: Ansi.brightYellow,
  reviewer: Ansi.green
}

const decode = (value: Uint8Array) => new TextDecoder().decode(value)

const visibleControl = (character: string) => `\\u{${character.codePointAt(0)?.toString(16).padStart(2, "0") ?? "00"}}`

const escapeText = (value: string, allowNewlines: boolean) =>
  Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0
    const isControl = codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
    return !isControl || (allowNewlines && character === "\n") ? character : visibleControl(character)
  }).join("")

export const escapeInline = (value: string) => escapeText(value, false)

export const escapeBlock = (value: string) => escapeText(value, true)

const render = (box: Box.Box<Ansi.AnsiStyle>) => Console.log(`\n${Box.renderPrettySync(box)}`)

const row = (label: string, value: string, color: Ansi.AnsiAnnotation = Ansi.white) =>
  Box.hsep(
    [
      Box.text(escapeInline(label)).pipe(Box.alignHoriz(Box.right, 13), Box.annotate(Ansi.dim)),
      Box.text(escapeInline(value)).pipe(Box.annotate(color))
    ],
    2,
    Box.top
  )

const blockRow = (label: string, value: string, color: Ansi.AnsiAnnotation = Ansi.white) =>
  Box.hsep(
    [
      Box.text(escapeInline(label)).pipe(Box.alignHoriz(Box.right, 13), Box.annotate(Ansi.dim)),
      Box.text(escapeBlock(value)).pipe(Box.annotate(color))
    ],
    2,
    Box.top
  )

const pathText = (path: Vfs.BytePath) => Vfs.pathToBytes(path).pipe(Effect.map(decode))

const changeText = Effect.fnUntraced(function*(change: Vfs.OverlayChange) {
  switch (change._tag) {
    case "Added":
    case "Removed":
      return `${change._tag} ${yield* pathText(change.path)}`
    case "Replaced":
      return `Replaced ${yield* pathText(change.path)} (${change.beforeKind} → ${change.afterKind})`
    case "Renamed":
      return `Renamed ${yield* pathText(change.from)} → ${yield* pathText(change.to)}`
    case "Updated":
      return `Updated ${yield* pathText(change.path)} (${change.differences.join(", ")})`
  }
})

export const pacing = Effect.sleep("350 millis")

export const showTitle = render(
  Box.vcat(
    [
      Box.text("EFFECT VFS · GIVE AGENTS A PROJECT, NOT YOUR DISK").pipe(
        Box.annotate(Ansi.combine(Ansi.bold, Ansi.brightWhite))
      ),
      Box.text("Real model tools, disposable overlays, and a captured handoff.").pipe(
        Box.annotate(Ansi.dim)
      )
    ],
    Box.left
  ).pipe(Box.pad(1, 2), Box.border("rounded", { annotation: Ansi.cyan }))
)

export const showStage = (step: number, label: string, explanation: string) =>
  render(
    Box.vcat(
      [
        Box.hsep(
          [
            Box.text(` ${step} `).pipe(
              Box.annotate(Ansi.combine(Ansi.bold, Ansi.bgCyan, Ansi.black))
            ),
            Box.text(label).pipe(Box.annotate(Ansi.combine(Ansi.bold, Ansi.brightCyan)))
          ],
          1,
          Box.top
        ),
        Box.text(explanation).pipe(Box.annotate(Ansi.dim), Box.moveRight(4))
      ],
      Box.left
    )
  )

export const showMessage = (label: string, message: string) => render(row(label, message, Ansi.brightWhite))

export const showFile = (label: string, path: string, content: string) =>
  render(blockRow(label, `${escapeInline(path)} · ${content}`, Ansi.brightWhite))

export const showToolAction = (action: ToolAction) => {
  const detail = action.detail === undefined ? "" : ` · ${action.detail}`
  return render(
    row(
      action.actor.toUpperCase(),
      `${action.tool.padEnd(5)} ${action.path}${detail}`,
      actorColors[action.actor]
    )
  )
}

export const showWatchEvent = (event: Vfs.Change) =>
  pathText(event.path).pipe(
    Effect.flatMap((path) => render(row("VFS", `${event._tag.padEnd(6)} ${path}`, Ansi.brightCyan)))
  )

export const showChanges = (changes: ReadonlyArray<Vfs.OverlayChange>) =>
  Effect.forEach(changes, (change) => changeText(change).pipe(Effect.flatMap((text) => render(row("CHANGE", text)))))
    .pipe(Effect.asVoid)

export const showRestoredFiles = (files: ReadonlyArray<RestoredFile>) =>
  Effect.forEach(
    files,
    (file) => render(blockRow("RESTORED", `${escapeInline(file.path)} · ${file.content}`, Ansi.green))
  ).pipe(
    Effect.asVoid
  )

export const showTakeaway = render(
  Box.para(
    "The model only received project tools. Private overlays are disposable; callers on one overlay collaborate; capture freezes their finished workspace.",
    Box.left,
    72
  ).pipe(
    Box.annotate(Ansi.combine(Ansi.bold, Ansi.brightWhite)),
    Box.pad(1, 2),
    Box.border("rounded", { annotation: Ansi.green })
  )
)
