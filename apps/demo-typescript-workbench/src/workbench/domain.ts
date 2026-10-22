import * as Rpc from "effect/rpc/Rpc"
import * as RpcGroup from "effect/rpc/RpcGroup"
import * as Schema from "effect/Schema"

export const SourcePath = Schema.Literals(["/src/index.ts", "/src/format.ts"])

export const Edit = Schema.Struct({ path: SourcePath, text: Schema.String.check(Schema.isMaxLength(32000)) })

export const Command = Schema.Struct({
  action: Schema.Literals(["view", "compile", "run", "compileRun", "save", "restore", "stop", "reset"]),
  generation: Schema.Int,
  revision: Schema.Int,
  edits: Schema.Array(Edit).check(Schema.isMaxLength(2)),
  role: Schema.Literals(["compiler", "viewer"])
})

export type Command = typeof Command.Type

export class WorkbenchError
  extends Schema.TaggedError<WorkbenchError>()("WorkbenchError", { message: Schema.String })
{}

export const Diagnostic = Schema.Struct({
  code: Schema.Int,
  message: Schema.String,
  file: Schema.String,
  line: Schema.Int
})

export const File = Schema.Struct({ path: Schema.String, text: Schema.String })

export const Output = Schema.Struct({ channel: Schema.Literals(["stdout", "stderr"]), text: Schema.String })

export const View = Schema.Struct({
  generation: Schema.Int,
  revision: Schema.Int,
  files: Schema.Array(File),
  changes: Schema.Array(Schema.Struct({ kind: Schema.String, path: Schema.String })),
  build: Schema.NullOr(
    Schema.Struct({
      revision: Schema.Int,
      status: Schema.Literals(["success", "failed"]),
      diagnostics: Schema.Array(Diagnostic),
      inputs: Schema.Int
    })
  ),
  output: Schema.Array(Output),
  runRevision: Schema.NullOr(Schema.Int),
  truncated: Schema.Boolean,
  notice: Schema.String,
  checkpoint: Schema.Int
})

export type View = typeof View.Type

export class WorkbenchRpc
  extends RpcGroup.make(Rpc.make("command", { payload: Command, success: View, error: WorkbenchError }))
{}

export const InternalCommand = Schema.Struct({
  action: Schema.Literals(["boot", "view", "compile", "run", "save"]),
  generation: Schema.Int,
  revision: Schema.Int,
  edits: Schema.Array(Edit),
  role: Schema.Literals(["compiler", "viewer"]),
  snapshot: Schema.optionalKey(Schema.Uint8Array)
})

export type InternalCommand = typeof InternalCommand.Type

export const Reply = Schema.Struct({ view: View, snapshot: Schema.optionalKey(Schema.Uint8Array) })

export type Reply = typeof Reply.Type

export class WorkerRpc
  extends RpcGroup.make(Rpc.make("execute", { payload: InternalCommand, success: Reply, error: WorkbenchError }))
{}
