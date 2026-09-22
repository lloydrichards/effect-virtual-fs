import * as ByteSize from "effect/ByteSize"
import * as Chunk from "effect/Chunk"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Match from "effect/Match"
import * as Path from "effect/Path"
import type * as PlatformError from "effect/PlatformError"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"

const root = "/mnt/r2"

const api = HttpApi.make("mounted-vfs").add(
  HttpApiGroup.make("files")
    .add(
      HttpApiEndpoint.get("list", "/", {
        query: { prefix: Schema.optional(Schema.String) },
        success: Schema.Struct({ path: Schema.String, entries: Schema.Array(Schema.String) })
      }),
      HttpApiEndpoint.get("read", "/file", {
        query: { path: Schema.optional(Schema.String) },
        success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array())
      }),
      HttpApiEndpoint.put("write", "/file", {
        query: { path: Schema.optional(Schema.String) },
        success: HttpApiSchema.NoContent
      }),
      HttpApiEndpoint.post("mkdir", "/directory", {
        query: { path: Schema.optional(Schema.String) },
        success: HttpApiSchema.Created
      })
    )
)

const failure = (error: PlatformError.PlatformError): HttpServerResponse.HttpServerResponse => {
  const status = Match.value(error.reason).pipe(
    Match.tag("NotFound", () => 404),
    Match.tag("PermissionDenied", () => 403),
    Match.tag("AlreadyExists", () => 409),
    Match.orElse(() => 500)
  )

  return HttpServerResponse.text(status === 500 ? "Filesystem operation failed" : error.reason._tag, { status })
}

const handlers = (maxFileBytes: ByteSize.ByteSize) =>
  HttpApiBuilder.group(
    api,
    "files",
    (routes) =>
      routes
        .handle(
          "list",
          Effect.fn("R2Demo.list")(function*({ query }) {
            const fs = yield* FileSystem.FileSystem
            const paths = yield* Path.Path
            const prefix = query.prefix === undefined || query.prefix === "." ? root : filePath(paths, query.prefix)

            if (prefix === null) return HttpServerResponse.text("Invalid prefix", { status: 400 })

            const resolved = yield* fs.realPath(prefix).pipe(Effect.result)

            if (Result.isFailure(resolved)) return failure(resolved.failure)

            if (!insideMount(paths, resolved.success)) return HttpServerResponse.text("Invalid prefix", { status: 400 })

            const entries = yield* fs.readDirectory(prefix).pipe(Effect.result)

            return Result.isFailure(entries)
              ? failure(entries.failure)
              : { path: prefix.slice(root.length) || "/", entries: entries.success }
          })
        )
        .handle(
          "read",
          Effect.fn("R2Demo.read")(function*({ query }) {
            const fs = yield* FileSystem.FileSystem
            const paths = yield* Path.Path
            const path = filePath(paths, query.path)

            if (path === null) return HttpServerResponse.text("Invalid path", { status: 400 })

            const resolved = yield* fs.realPath(path).pipe(Effect.result)

            if (Result.isFailure(resolved)) return failure(resolved.failure)

            if (!insideMount(paths, resolved.success)) return HttpServerResponse.text("Invalid path", { status: 400 })

            const content = yield* fs.readFile(path).pipe(Effect.result)

            return Result.isFailure(content) ? failure(content.failure) : content.success
          })
        )
        .handleRaw(
          "write",
          Effect.fn("R2Demo.write")(function*({ query, request }) {
            const fs = yield* FileSystem.FileSystem
            const paths = yield* Path.Path
            const path = filePath(paths, query.path)

            if (path === null) return HttpServerResponse.text("Invalid path", { status: 400 })

            const parent = yield* fs.realPath(paths.dirname(path)).pipe(Effect.result)

            if (Result.isFailure(parent)) return failure(parent.failure)

            if (!insideMount(paths, parent.success)) return HttpServerResponse.text("Invalid path", { status: 400 })

            const existing = yield* fs.realPath(path).pipe(Effect.result)

            if (Result.isSuccess(existing) && existing.success !== path) {
              return HttpServerResponse.text("Invalid path", { status: 400 })
            }

            if (Result.isFailure(existing) && !Predicate.isTagged(existing.failure.reason, "NotFound")) {
              return failure(existing.failure)
            }

            if (Result.isFailure(existing)) {
              const link = yield* fs.readLink(path).pipe(Effect.result)

              if (Result.isSuccess(link)) return HttpServerResponse.text("Invalid path", { status: 400 })
            }

            const body = yield* Stream.runFoldEffect(
              request.stream,
              () => ({ size: 0, chunks: Chunk.empty<Uint8Array>() }),
              (state, chunk) =>
                BigInt(state.size + chunk.length) > ByteSize.toBigInt(maxFileBytes)
                  ? Effect.fail("too-large")
                  : Effect.succeed({ size: state.size + chunk.length, chunks: Chunk.append(state.chunks, chunk) })
            ).pipe(Effect.result)

            if (Result.isFailure(body)) {
              return HttpServerResponse.text(body.failure === "too-large" ? "File too large" : "Invalid request body", {
                status: body.failure === "too-large" ? 413 : 400
              })
            }

            const bytes = new Uint8Array(body.success.size)
            let offset = 0

            for (const chunk of body.success.chunks) {
              bytes.set(chunk, offset)
              offset += chunk.length
            }

            const result = yield* fs.writeFile(path, bytes).pipe(Effect.result)

            return Result.isFailure(result) ? failure(result.failure) : undefined
          })
        )
        .handle(
          "mkdir",
          Effect.fn("R2Demo.mkdir")(function*({ query }) {
            const fs = yield* FileSystem.FileSystem
            const paths = yield* Path.Path
            const path = filePath(paths, query.path)

            if (path === null) return HttpServerResponse.text("Invalid path", { status: 400 })

            const parent = yield* fs.realPath(paths.dirname(path)).pipe(Effect.result)

            if (Result.isFailure(parent)) return failure(parent.failure)

            if (!insideMount(paths, parent.success)) return HttpServerResponse.text("Invalid path", { status: 400 })

            const result = yield* fs.makeDirectory(path).pipe(Effect.result)

            return Result.isFailure(result) ? failure(result.failure) : undefined
          })
        )
  )

const insideMount = (paths: Path.Path, path: string) => path === root || path.startsWith(`${root}${paths.sep}`)

const filePath = (paths: Path.Path, value: string | undefined): string | null => {
  if (value === undefined || paths.isAbsolute(value)) return null
  const path = paths.resolve(root, value)

  return path.startsWith(`${root}${paths.sep}`) ? path : null
}

export const serveHttp = (maxFileBytes: ByteSize.ByteSize) =>
  HttpRouter.serve(
    HttpApiBuilder.layer(api).pipe(Layer.provide(handlers(maxFileBytes)))
  )
