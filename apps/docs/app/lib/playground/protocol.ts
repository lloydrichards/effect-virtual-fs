import * as Rpc from "effect/rpc/Rpc"
import * as RpcGroup from "effect/rpc/RpcGroup"
import * as Schema from "effect/Schema"

export const Role = Schema.Literals(["admin", "editor", "reader"])

export type Role = typeof Role.Type

const Address = { role: Role, path: Schema.String }

export const Entry = Schema.Struct({
  path: Schema.String,
  directory: Schema.Boolean,
  readable: Schema.Boolean,
  policy: Schema.optional(Schema.Struct({
    metadata: Schema.Struct({ uid: Schema.Int, mode: Schema.Int }),
    reader: Schema.Int,
    editor: Schema.Int
  }))
})

const Mutation = Schema.TaggedUnion({
  mode: { ...Address, mode: Schema.Literals([0o600, 0o644]) },
  write: { ...Address, text: Schema.String },
  mkdir: Address,
  rename: { ...Address, to: Schema.String },
  removeFolder: Address,
  unlink: Address,
  create: Address
})

export { Mutation }

export class WorkspaceError extends Schema.TaggedError<WorkspaceError>()("WorkspaceError", {
  message: Schema.String
}) {}

export class WorkspaceRpc extends RpcGroup.make(
  Rpc.make("open", { payload: { restore: Schema.Boolean }, error: WorkspaceError }),
  Rpc.make("files", { payload: { role: Role }, success: Schema.Array(Entry), error: WorkspaceError }),
  Rpc.make("read", { payload: Address, success: Schema.String, error: WorkspaceError }),
  Rpc.make("permissions", { payload: Address, success: Schema.Int, error: WorkspaceError }),
  Rpc.make("mutate", { payload: Mutation, error: WorkspaceError }),
  Rpc.make("build", {
    payload: { role: Role },
    success: Schema.Struct({ code: Schema.String, reads: Schema.Array(Schema.String) }),
    error: WorkspaceError
  }),
  Rpc.make("saveCheckpoint", { error: WorkspaceError }),
  Rpc.make("hasCheckpoint", { success: Schema.Boolean, error: WorkspaceError }),
  Rpc.make("inspectCheckpoint", {
    success: Schema.Struct({ savedAt: Schema.String, size: Schema.Int }),
    error: WorkspaceError
  }),
  Rpc.make("deleteCheckpoint", { error: WorkspaceError })
) {}
