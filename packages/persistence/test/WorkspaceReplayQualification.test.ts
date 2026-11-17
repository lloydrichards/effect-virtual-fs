import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem"
import * as NodePath from "@effect/platform-node-shared/NodePath"
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient"
import { assert, it } from "@effect/vitest"
import { ByteSize, Effect, FileSystem, Path } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { CheckpointStore } from "../src/index.js"

const limits = {
  maxEncodedBytes: ByteSize.kilobytes(32),
  maxDecodedBytes: ByteSize.kilobytes(8),
  maxEntries: 8,
  maxRecords: 8
}

const workspace = "tenant-a/workspace-1"

const image = (value: number) =>
  Vfs.fromFixture({ entries: [{ kind: "file", path: "/note", bytes: Uint8Array.of(value) }] }).pipe(
    Effect.flatMap((volume) => volume.snapshot)
  )

it.effect("publishes a workspace image and its replay result in one SQLite transaction", () =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "vfs-workspace-replay-" })
    const database = path.join(directory, "workspace.sqlite")

    // Each phase acquires and closes a separate connection to the same file.
    const connection = () => Effect.provide(SqliteClient.layer({ filename: database }))

    yield* Effect.gen(function*() {
      const sql = yield* SqlClient
      yield* CheckpointStore.migrate
      const store = yield* CheckpointStore.make(limits)
      yield* sql`CREATE TABLE workspace_head (workspace TEXT PRIMARY KEY, generation INTEGER NOT NULL)`
      yield* sql`CREATE TABLE operation_result (
        workspace TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        principal TEXT NOT NULL,
        expected INTEGER NOT NULL,
        value INTEGER NOT NULL,
        generation INTEGER NOT NULL,
        PRIMARY KEY (workspace, operation_id)
      )`
      yield* sql.withTransaction(Effect.gen(function*() {
        yield* store.save(workspace + "/0", yield* image(0))
        yield* sql`INSERT INTO workspace_head VALUES (${workspace}, 0)`
      }))
    }).pipe(connection())

    const exercise = Effect.fnUntraced(function*(phase: "publish" | "reopen" | "verify") {
      const sql = yield* SqlClient
      const store = yield* CheckpointStore.make(limits)

      const replace = Effect.fnUntraced(function*(
        id: string,
        principal: string,
        expected: number,
        value: number,
        rejectPublication = false
      ) {
        return yield* sql.withTransaction(Effect.gen(function*() {
          const [recorded] = yield* sql<{ principal: string; expected: number; value: number; generation: number }>`
            SELECT principal, expected, value, generation FROM operation_result WHERE workspace = ${workspace} AND operation_id = ${id}
          `

          if (recorded) {
            return recorded.principal === principal && recorded.expected === expected && recorded.value === value
              ? { status: "replayed", generation: recorded.generation }
              : { status: "conflicting-operation" }
          }

          const generation = expected + 1

          const updated = yield* sql<{ generation: number }>`
            UPDATE workspace_head SET generation = ${generation}
            WHERE workspace = ${workspace} AND generation = ${expected}
            RETURNING generation
          `

          if (updated.length === 0) return { status: "stale-generation" }

          yield* store.save(workspace + "/" + generation, yield* image(value))
          yield* sql`INSERT INTO operation_result VALUES (${workspace}, ${id}, ${principal}, ${expected}, ${value}, ${generation})`

          if (rejectPublication) return yield* Effect.fail("abort before commit")

          return { status: "committed", generation }
        }))
      })

      const seeHead = Effect.fnUntraced(function*() {
        const [head] = yield* sql<{ generation: number }>`
          SELECT generation FROM workspace_head WHERE workspace = ${workspace}
        `

        assert.isDefined(head)
        const snapshot = yield* store.load(workspace + "/" + head.generation)
        const restored = yield* Vfs.fromSnapshot(snapshot)
        const caller = yield* restored.caller()

        return [head.generation, yield* caller.readFile("/note")] as const
      })

      if (phase === "publish") {
        assert.deepStrictEqual(yield* replace("one", "writer", 0, 1), { status: "committed", generation: 1 })
        assert.strictEqual(yield* Effect.flip(replace("two", "writer", 1, 2, true)), "abort before commit")
      } else if (phase === "reopen") {
        assert.deepStrictEqual(yield* seeHead(), [1, Uint8Array.of(1)])
        assert.strictEqual((yield* Effect.flip(store.load(workspace + "/2"))).code, "NotFound")
        assert.deepStrictEqual(yield* replace("one", "writer", 0, 1), { status: "replayed", generation: 1 })
        assert.deepStrictEqual(yield* replace("one", "writer", 0, 9), { status: "conflicting-operation" })
        assert.deepStrictEqual(yield* replace("one", "other", 0, 1), { status: "conflicting-operation" })
        assert.deepStrictEqual(yield* replace("stale", "writer", 0, 9), { status: "stale-generation" })
        assert.deepStrictEqual(yield* seeHead(), [1, Uint8Array.of(1)])
        assert.deepStrictEqual(yield* replace("two", "writer", 1, 2), { status: "committed", generation: 2 })
      } else {
        assert.deepStrictEqual(yield* replace("one", "writer", 0, 1), { status: "replayed", generation: 1 })
        assert.deepStrictEqual(yield* seeHead(), [2, Uint8Array.of(2)])
      }
    })

    yield* exercise("publish").pipe(connection())
    yield* exercise("reopen").pipe(connection())
    yield* exercise("verify").pipe(connection())
  }).pipe(Effect.provide([NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer])))
