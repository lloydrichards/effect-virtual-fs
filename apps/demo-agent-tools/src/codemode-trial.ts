import { BytePath, VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { Context, Effect, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import * as Digest from "effect/crypto/Digest"
import * as SecureRandom from "effect/crypto/SecureRandom"
import { CodeModeTools, makeCodeModeSession } from "./codemode.js"
import { ToolFailure } from "./tools.js"
import { makeBaseSnapshot } from "./workspace.js"

const Conflict = Schema.Struct({
  key: Schema.String,
  kind: Schema.Literals(["path", "rename"]),
  affectedPaths: Schema.Array(Schema.String),
  reasons: Schema.Array(Schema.String),
  ours: Schema.optionalKey(Schema.String),
  theirs: Schema.optionalKey(Schema.String)
})

const CombineRuns = Tool.make("combine_runs", {
  description: "Preview or complete a release handoff from two successful runs. " +
    "Submit all choices so far on each retry. Only a ready result can be used for the handoff.",
  parameters: Schema.Struct({
    ours: Schema.String,
    theirs: Schema.String,
    resolutions: Schema.optionalKey(Schema.Array(Schema.Struct({ key: Schema.String, take: Vfs.MergeTake })))
  }),
  success: Schema.Union([
    Schema.Struct({
      status: Schema.Literal("preview"),
      previewDelta: Schema.String,
      conflicts: Schema.Array(Conflict)
    }),
    Schema.Struct({ status: Schema.Literal("ready"), delta: Schema.String })
  ]),
  failure: ToolFailure,
  failureMode: "return"
}).annotate(Tool.Readonly, true).annotate(Tool.Destructive, false).annotate(Tool.OpenWorld, false)

export const TrialCodeModeTools = Toolkit.make(
  CodeModeTools.tools.execute,
  CodeModeTools.tools.inspect_run,
  CodeModeTools.tools.inspect_base,
  CombineRuns
)

const pathText = (path: BytePath.BytePath) =>
  Effect.map(BytePath.toBytes(path), (bytes) => new TextDecoder().decode(bytes))

const describeConflict = Effect.fnUntraced(function*(conflict: Vfs.OverlayMergeConflict) {
  const shared = { key: conflict.key, affectedPaths: yield* Effect.forEach(conflict.affectedPaths, pathText) }

  if (conflict.kind === "path") {
    return { ...shared, kind: "path" as const, reasons: conflict.details.map((detail) => detail.reason) }
  }

  const { detail } = conflict

  const summary: {
    key: string
    affectedPaths: ReadonlyArray<string>
    kind: "rename"
    reasons: ReadonlyArray<string>
    ours?: string
    theirs?: string
  } = { ...shared, kind: "rename", reasons: [detail.reason] }

  if (detail.ours.destination !== undefined) summary.ours = yield* pathText(detail.ours.destination)

  if (detail.theirs.destination !== undefined) summary.theirs = yield* pathText(detail.theirs.destination)

  return summary
})

export const makeTrialCodeModeHandlers = Effect.fnUntraced(function*(baseOverride?: Vfs.Snapshot) {
  const base = baseOverride ?? (yield* makeBaseSnapshot(true))
  const random = yield* SecureRandom.SecureRandom
  const instance = yield* random.uuidV4()
  const { handlers, mergeCaptureFor } = yield* makeCodeModeSession(base, instance)

  const crypto = Context.make(Digest.Digest, yield* Digest.Digest).pipe(
    Context.add(SecureRandom.SecureRandom, random)
  )

  return TrialCodeModeTools.of({
    execute: handlers.execute,
    inspect_run: handlers.inspect_run,
    inspect_base: handlers.inspect_base,
    combine_runs: Effect.fnUntraced(function*({ ours, theirs, resolutions }) {
      const left = mergeCaptureFor(ours)
      const right = mergeCaptureFor(theirs)

      if (left === undefined || right === undefined || ours === theirs) {
        return yield* Effect.fail({
          code: "RunNotAvailable",
          operation: "combine_runs",
          message:
            "Choose two distinct successful runs retained by this trial process. Use the usual handoff workflow if the runs have expired."
        })
      }

      const result = yield* Vfs.mergeOverlayCaptures(base, left, right, { resolutions: resolutions ?? [] }).pipe(
        Effect.catchTags({
          VfsError: Effect.fnUntraced(function*(error) {
            const failure: {
              code: string
              operation: string
              message: string
              path?: string
              field?: string
            } = { code: error.code, operation: error.operation, message: error.message }

            if (error.path !== undefined) failure.path = yield* Effect.orDie(pathText(error.path))

            if (error.field !== undefined) failure.field = error.field

            return yield* Effect.fail(failure)
          }),
          PlatformError: () =>
            Effect.fail({
              code: "InternalToolError",
              operation: "combine_runs",
              message: "Could not compute the snapshot delta."
            })
        })
      )

      const encoded = yield* Schema.encodeEffect(Vfs.SnapshotDeltaFromBytes())(result.delta).pipe(
        Effect.mapError(() => ({
          code: "InternalToolError",
          operation: "combine_runs",
          message: "Could not encode the snapshot delta."
        }))
      )

      const delta = new TextDecoder().decode(encoded)

      if (result.conflicts.length === 0) return { status: "ready" as const, delta }

      return {
        status: "preview" as const,
        previewDelta: delta,
        conflicts: yield* Effect.forEach(result.conflicts, (conflict) => Effect.orDie(describeConflict(conflict)))
      }
    }, Effect.provideContext(crypto))
  })
})
