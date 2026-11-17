import { Client, layer, type R2Client } from "@effect-vfs/persistence/R2Store"
import { ByteSize, Effect, Layer } from "effect"

const client: R2Client = {
  read: () => Effect.succeed(null),
  write: () => Effect.succeed(null)
}

export const store = layer({ key: "workspace-1", maxImageBytes: ByteSize.kibibytes(4) }).pipe(
  Layer.provide(Layer.succeed(Client, client))
)
