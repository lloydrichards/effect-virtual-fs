/* oxlint-disable effecttsgo/process-env -- Integration suite and TLS case registration happen before Effect tests run. */
import { LiveVolume, type VfsError } from "@effect-vfs/core"
import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem"
import * as NodePath from "@effect/platform-node-shared/NodePath"
import * as PgClient from "@effect/sql-pg/PgClient"
import { assert, it } from "@effect/vitest"
import {
  ByteSize,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate,
  Redacted,
  Schedule,
  Schema,
  Scope,
  Stream
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import * as Reactivity from "effect/reactivity/Reactivity"
import * as SqlClient from "effect/sql/SqlClient"
import * as TestClock from "effect/testing/TestClock"
import { fileURLToPath } from "node:url"
import { describe } from "vitest"
import * as Pg from "../src/PgLiveImageStore.js"
import { type Fixture, liveImageStoreContract, type Phase } from "./helpers/liveImageStoreContract.js"

import { pgProxy } from "./helpers/pgProxy.js"

const url = process.env["VFS_PG_TEST_URL"]

const connection = { ssl: false, url: Redacted.make(url ?? "postgresql://postgres@127.0.0.1:55438/postgres") }

const makeClient = PgClient.makeClient

const configured = (options: Pg.Options, config: PgClient.PgClientConfig = connection) =>
  Pg.layer(options).pipe(Layer.provide(PgClient.layerFrom(makeClient({
    ...config,
    multiplex: false,
    maxMessageSize: Math.max(16 * 1024 * 1024, Number(ByteSize.toBigInt(options.maxImageBytes)) + 90)
  }))))

let key = 0

const fixture = Effect.gen(function*() {
  const admin = yield* makeClient(connection).pipe(Effect.provide(Reactivity.layer))
  const volumeKey = `contract-${++key}`
  yield* admin.unsafe("DELETE FROM public.effect_vfs_live_images WHERE volume_key = $1", [volumeKey]).pipe(Effect.orDie)
  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      volumeKeys,
      (key) => admin.unsafe("DELETE FROM public.effect_vfs_live_images WHERE volume_key = $1", [key]).pipe(Effect.orDie)
    )
  )
  const volumeKeys = new Set([volumeKey])
  const hooks = new Map<Phase, Effect.Effect<void, VfsError.StoreFailure>>()
  let writes = 0
  let reads = 0

  const phase = (name: Phase) =>
    Effect.suspend(() => {
      if (name === "write") writes++

      if (name === "read") reads++
      const hook = hooks.get(name)
      hooks.delete(name)

      return hook ?? Effect.void
    })

  let corruptReceipt: "mismatch" | "decode" | undefined

  const proxy = yield* pgProxy(url!, phase, (packet) => {
    if (corruptReceipt === undefined) return packet
    const decoding = corruptReceipt === "decode"
    corruptReceipt = undefined
    const corrupted = Buffer.from(decoding ? packet.subarray(0, packet.length - 1) : packet)

    if (decoding) {
      corrupted.writeInt32BE(corrupted.length - 1, 1)
      corrupted.writeInt32BE(7, 7)
    } else corrupted.writeBigInt64BE(42n, 11)

    return corrupted
  })

  const open = Effect.fnUntraced(function*(maxImageBytes = ByteSize.bytes(16), requestedKey = volumeKey) {
    volumeKeys.add(requestedKey)
    const scope = yield* Scope.make()
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))

    const context = yield* Layer.buildWithScope(
      configured({ key: requestedKey, maxImageBytes }, { url: Redacted.make(proxy.url), ssl: false }),
      scope
    )

    return { store: Context.get(context, LiveVolume.LiveImageStore), close: Scope.close(scope, Exit.void) }
  })

  const result = {
    hooks,
    open,
    operation: "PgLiveImageStore.loadOrCreate",
    writeCount: () => writes,
    readCount: () => reads,
    persisted: admin.unsafe("SELECT generation, image FROM public.effect_vfs_live_images WHERE volume_key = $1", [
      volumeKey
    ]).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ generation: Schema.BigInt, image: Schema.Uint8Array })))
      ),
      Effect.map((rows) =>
        rows[0] === undefined ? undefined : { generation: Number(rows[0].generation), image: rows[0].image }
      ),
      Effect.orDie
    ),
    damage: (field, value) =>
      admin.unsafe(`UPDATE public.effect_vfs_live_images SET ${field} = $1 WHERE volume_key = $2`, [
        field === "generation" ? BigInt(String(value)) : value,
        volumeKey
      ]).pipe(Effect.asVoid, Effect.orDie)
  } satisfies Fixture

  return {
    ...result,
    corruptReceipt: (mode: "mismatch" | "decode") => {
      corruptReceipt = mode
    }
  }
})

describe.skipIf(url === undefined)("PostgreSQL integration", () => {
  it.layer(NodeChildProcessSpawner.layer.pipe(Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))))(
    "PostgreSQL process recovery",
    (it) => {
      it.effect(
        "recovers an acknowledged filesystem mutation after the writer is killed",
        () =>
          Effect.gen(function*() {
            const admin = yield* makeClient(connection).pipe(Effect.provide(Reactivity.layer))
            const volumeKey = `restart-${++key}`

            const clean = admin.unsafe("DELETE FROM public.effect_vfs_live_images WHERE volume_key = $1", [volumeKey])
              .pipe(Effect.orDie)

            yield* clean
            yield* Effect.addFinalizer(() => clean)
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
            const worker = fileURLToPath(new URL("./fixtures/pg-restart.ts", import.meta.url))

            const command = (mode: string) =>
              ChildProcess.make("bun", [worker], {
                env: { VFS_PG_RESTART_KEY: volumeKey, VFS_PG_RESTART_MODE: mode },
                extendEnv: true
              })

            const writer = yield* spawner.spawn(command("write"))
            const acknowledged = yield* Stream.runHead(Stream.decodeText(writer.stdout))
            assert.deepStrictEqual(acknowledged, Option.some("acknowledged\n"))
            yield* writer.kill({ killSignal: "SIGKILL" })
            assert.isTrue(Exit.isFailure(yield* Effect.exit(writer.exitCode)))
            const reader = yield* spawner.spawn(command("read"))
            const restored = yield* Stream.mkString(Stream.decodeText(reader.stdout))
            assert.strictEqual(yield* reader.exitCode, 0)
            assert.strictEqual(restored.trim(), "restored:42")
          }),
        15_000
      )
    }
  )

  liveImageStoreContract({
    name: "PostgreSQL",
    fixture: fixture.pipe(Effect.orDie),
    // bigint columns cannot contain fractional values. A single wire session
    // also cannot receive a second result while ReadyForQuery is withheld.
    fractionalGeneration: false,
    concurrentAcknowledgements: false
  })
  it.layer(NodeCrypto.layer)("private commit boundary", (it) => {
    const ca = process.env["VFS_PG_TEST_CA"]

    if (ca !== undefined) {
      it.effect("opens a private session with verified TLS", () =>
        Effect.gen(function*() {
          const scope = yield* Scope.make()
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
          yield* Layer.buildWithScope(
            configured({ key: "tls", maxImageBytes: ByteSize.bytes(16) }, {
              url: connection.url,
              ssl: { ca },
              connectTimeout: "5 seconds"
            }),
            scope
          )
        }))
      it.effect("refuses an untrusted TLS certificate", () =>
        Effect.gen(function*() {
          const scope = yield* Scope.make()
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))

          const error = yield* Effect.flip(
            Layer.buildWithScope(
              configured({ key: "tls", maxImageBytes: ByteSize.bytes(16) }, { url: connection.url, ssl: true }),
              scope
            )
          )

          assert.strictEqual(error._tag, "SqlError")
        }))
    }

    it.effect("releases its reservation without closing the supplied client", () =>
      Effect.gen(function*() {
        const client = yield* makeClient(connection).pipe(Effect.provide(Reactivity.layer))
        const scope = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))

        const store = yield* Layer.buildWithScope(
          Pg.layer({ key: "borrowed-client", maxImageBytes: ByteSize.bytes(16) }),
          scope
        ).pipe(
          Effect.provideService(PgClient.PgClient, client)
        )

        assert.isDefined(Context.get(store, LiveVolume.LiveImageStore))
        yield* Scope.close(scope, Exit.void)
        const rows = yield* client.unsafe("SELECT 42::int AS answer")
        assert.deepStrictEqual(rows, [{ answer: 42 }])
      }))

    it.effect("releases a failed store's reservation while its supplied client remains open", () =>
      Effect.gen(function*() {
        const admin = yield* makeClient(connection).pipe(Effect.provide(Reactivity.layer))
        const client = yield* makeClient(connection).pipe(Effect.provide(Reactivity.layer))

        const restore = admin.unsafe("COMMENT ON TABLE public.effect_vfs_live_images IS 'effect-vfs-live-images:1'")
          .pipe(Effect.orDie)

        yield* admin.unsafe("COMMENT ON TABLE public.effect_vfs_live_images IS 'effect-vfs-live-images:unknown'")
        yield* Effect.gen(function*() {
          const scope = yield* Scope.make()
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))

          const error = yield* Effect.flip(Layer.buildWithScope(
            Pg.layer({ key: "failed-borrowed-client", maxImageBytes: ByteSize.bytes(16) }).pipe(
              Layer.provide(Layer.succeed(PgClient.PgClient, client))
            ),
            scope
          ))

          assert.strictEqual(error.code, "IncompatibleStore")
          yield* Scope.close(scope, Exit.void)
          assert.deepStrictEqual(
            yield* client.unsafe("SELECT 42::int AS answer").pipe(Effect.timeout("2 seconds"), TestClock.withLive),
            [{
              answer: 42
            }]
          )
        }).pipe(Effect.ensuring(restore))
      }))

    it.effect("cancels a second owner waiting for one shared single-connection client", () =>
      Effect.gen(function*() {
        const client = yield* makeClient(connection).pipe(Effect.provide(Reactivity.layer))
        const firstScope = yield* Scope.make()
        const secondScope = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(firstScope, Exit.void))
        yield* Effect.addFinalizer(() => Scope.close(secondScope, Exit.void))
        yield* Layer.buildWithScope(Pg.layer({ key: "shared-a", maxImageBytes: ByteSize.bytes(16) }), firstScope).pipe(
          Effect.provideService(PgClient.PgClient, client)
        )
        const entered = yield* Deferred.make<void>()
        const reserve = client.reserve

        const observed = Object.assign(client, {
          reserve: Deferred.succeed(entered, undefined).pipe(Effect.andThen(reserve))
        })

        const waiting = yield* Effect.forkChild(
          Layer.buildWithScope(Pg.layer({ key: "shared-b", maxImageBytes: ByteSize.bytes(16) }), secondScope).pipe(
            Effect.provideService(PgClient.PgClient, observed)
          )
        )

        yield* Deferred.await(entered)
        assert.isUndefined(waiting.pollUnsafe())
        yield* Fiber.interrupt(waiting)
        yield* Scope.close(firstScope, Exit.void)
        assert.deepStrictEqual(yield* client.unsafe("SELECT 42::int AS answer"), [{ answer: 42 }])
      }))

    it.effect("persists independently of an ambient application transaction", () =>
      Effect.gen(function*() {
        const app = yield* makeClient(connection).pipe(Effect.provide(Reactivity.layer))
        const f = yield* fixture
        const { store } = yield* f.open()
        yield* store.loadOrCreate(new Uint8Array([1]))
        yield* app.withTransaction(store.commit(new Uint8Array([2])).pipe(Effect.andThen(Effect.fail("rollback"))))
          .pipe(Effect.ignore)
        assert.deepStrictEqual((yield* f.persisted)?.image, new Uint8Array([2]))
      }))

    it.effect("honors the configured connection timeout during a stalled handshake", () =>
      Effect.gen(function*() {
        const entered = yield* Deferred.make<void>()

        const proxy = yield* pgProxy(
          url!,
          () => Effect.void,
          undefined,
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
        )

        const opening = yield* Effect.forkChild(
          Effect.flip(
            Layer.build(
              configured({ key: "timeout", maxImageBytes: ByteSize.bytes(16) }, {
                url: Redacted.make(proxy.url),
                ssl: false,
                connectTimeout: "1 second"
              })
            )
          )
        )

        yield* Deferred.await(entered)
        yield* TestClock.adjust("1 second")
        assert.strictEqual((yield* Fiber.join(opening))._tag, "SqlError")
      }))

    it.effect("waits for ReadyForQuery after PostgreSQL has committed", () =>
      Effect.gen(function*() {
        const f = yield* fixture
        const { store } = yield* f.open()
        yield* store.loadOrCreate(new Uint8Array([1]))
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        f.hooks.set("ack", Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))))
        const committing = yield* Effect.forkChild(store.commit(new Uint8Array([2])))
        yield* Deferred.await(entered)
        yield* Effect.gen(function*() {
          assert.deepStrictEqual(yield* f.persisted, { generation: 1, image: new Uint8Array([2]) })
          assert.isUndefined(committing.pollUnsafe())
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
        assert.strictEqual(yield* Fiber.join(committing), "committed")
      }))

    it.effect("reopens an image at its admitted bound above the default receive limit", () =>
      Effect.gen(function*() {
        const f = yield* fixture
        const bound = ByteSize.mebibytes(17)
        const owner = yield* f.open(bound)
        yield* owner.store.loadOrCreate(new Uint8Array([1]))
        const image = new Uint8Array(Number(ByteSize.toBigInt(bound)))
        image[0] = 42
        image[image.length - 1] = 255
        assert.strictEqual(yield* owner.store.commit(image), "committed")
        yield* owner.close
        assert.deepStrictEqual(yield* (yield* f.open(bound)).store.loadOrCreate(new Uint8Array()), image)
      }), 15_000)

    it.effect("keeps valid supplementary Unicode and replacement-character keys distinct", () =>
      Effect.gen(function*() {
        const f = yield* fixture
        const keys = ["\u{1f600}", "\u{1f601}", "\ufffd", "é", "e\u0301"]

        for (const [index, key] of keys.entries()) {
          const owner = yield* f.open(ByteSize.bytes(16), `unicode-${key}`)
          assert.deepStrictEqual(yield* owner.store.loadOrCreate(new Uint8Array([index])), new Uint8Array([index]))
          yield* owner.close
        }

        for (const [index, key] of keys.entries()) {
          const owner = yield* f.open(ByteSize.bytes(16), `unicode-${key}`)
          assert.deepStrictEqual(yield* owner.store.loadOrCreate(new Uint8Array([99])), new Uint8Array([index]))
          yield* owner.close
        }
      }))

    it.effect("refuses nondeterministic key collation before admitting an owner", () =>
      Effect.gen(function*() {
        const admin = yield* makeClient(connection).pipe(Effect.provide(Reactivity.layer))
        yield* admin.unsafe(
          "CREATE COLLATION public.vfs_test_case_insensitive (provider = icu, locale = 'und-u-ks-level2', deterministic = false)"
        )
        yield* Effect.addFinalizer(() =>
          admin.unsafe("DROP COLLATION public.vfs_test_case_insensitive").pipe(Effect.orDie)
        )
        yield* admin.unsafe(
          "ALTER TABLE public.effect_vfs_live_images ALTER COLUMN volume_key TYPE text COLLATE public.vfs_test_case_insensitive"
        )
        yield* Effect.gen(function*() {
          const scope = yield* Scope.make()
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))

          const error = yield* Effect.flip(
            Layer.buildWithScope(configured({ key: "collation", maxImageBytes: ByteSize.bytes(16) }), scope)
          )

          if (Predicate.isTagged(error, "SqlError")) return yield* Effect.die(error)
          assert.strictEqual(error.code, "IncompatibleStore")
        }).pipe(
          Effect.ensuring(
            admin.unsafe(
              "ALTER TABLE public.effect_vfs_live_images ALTER COLUMN volume_key TYPE text COLLATE \"default\""
            ).pipe(Effect.orDie)
          )
        )
      }))

    it.effect("round-trips empty images and binary views without adjacent bytes", () =>
      Effect.gen(function*() {
        const f = yield* fixture
        const owner = yield* f.open()
        assert.deepStrictEqual(yield* owner.store.loadOrCreate(new Uint8Array()), new Uint8Array())
        assert.strictEqual(yield* owner.store.commit(new Uint8Array([99, 0, 255, 42]).subarray(1, 3)), "committed")
        yield* owner.close
        assert.deepStrictEqual(yield* (yield* f.open()).store.loadOrCreate(new Uint8Array()), new Uint8Array([0, 255]))
      }))

    it.effect("keeps distinct keys independent", () =>
      Effect.gen(function*() {
        const a = yield* fixture
        const b = yield* fixture
        const ownerA = yield* a.open()
        const ownerB = yield* b.open()
        yield* ownerA.store.loadOrCreate(new Uint8Array([1]))
        yield* ownerB.store.loadOrCreate(new Uint8Array([2]))
        yield* ownerA.store.commit(new Uint8Array([3]))
        assert.deepStrictEqual((yield* a.persisted)?.image, new Uint8Array([3]))
        assert.deepStrictEqual((yield* b.persisted)?.image, new Uint8Array([2]))
      }))

    for (
      const [name, change, restore] of [
        [
          "missing table",
          "ALTER TABLE public.effect_vfs_live_images RENAME TO effect_vfs_live_images_saved",
          "ALTER TABLE public.effect_vfs_live_images_saved RENAME TO effect_vfs_live_images"
        ],
        [
          "unknown version",
          "COMMENT ON TABLE public.effect_vfs_live_images IS 'effect-vfs-live-images:2'",
          "COMMENT ON TABLE public.effect_vfs_live_images IS 'effect-vfs-live-images:1'"
        ],
        [
          "nullable image",
          "ALTER TABLE public.effect_vfs_live_images ALTER COLUMN image DROP NOT NULL",
          "ALTER TABLE public.effect_vfs_live_images ALTER COLUMN image SET NOT NULL"
        ],
        [
          "extra column",
          "ALTER TABLE public.effect_vfs_live_images ADD COLUMN extra text",
          "ALTER TABLE public.effect_vfs_live_images DROP COLUMN extra"
        ]
      ]
    ) {
      it.effect(`refuses ${name} without silently changing the schema`, () =>
        Effect.gen(function*() {
          const admin = yield* makeClient(connection).pipe(Effect.provide(Reactivity.layer))
          yield* admin.unsafe(change!)
          yield* Effect.gen(function*() {
            const scope = yield* Scope.make()
            yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))

            const error = yield* Effect.flip(
              Layer.buildWithScope(
                configured({ key: "schema-test", maxImageBytes: ByteSize.bytes(16) }),
                scope
              )
            )

            if (Predicate.isTagged(error, "SqlError")) return yield* Effect.die(error)
            assert.strictEqual(error.code, "IncompatibleStore")
          }).pipe(Effect.ensuring(admin.unsafe(restore!).pipe(Effect.orDie)))
        }))
    }

    for (const mode of ["mismatch", "decode"] as const) {
      it.effect(`freezes on a ${mode} receipt and recovers the actual committed generation`, () =>
        Effect.gen(function*() {
          const f = yield* fixture
          const owner = yield* f.open()
          yield* owner.store.loadOrCreate(new Uint8Array([1]))
          f.corruptReceipt(mode)
          assert.strictEqual(yield* owner.store.commit(new Uint8Array([2])), "unknown")
          const count = f.writeCount()
          assert.strictEqual(yield* owner.store.commit(new Uint8Array([3])), "unknown")
          assert.strictEqual(f.writeCount(), count)
          yield* owner.close
          assert.deepStrictEqual(yield* (yield* f.open()).store.loadOrCreate(new Uint8Array()), new Uint8Array([2]))
        }))
    }

    it.effect("opens separate sessions for dedicated client layers and closes each complete owner scope", () =>
      Effect.gen(function*() {
        const admin = yield* makeClient(connection).pipe(Effect.provide(Reactivity.layer))
        const named = new URL(Redacted.value(connection.url))
        const name = `vfs-session-${++key}`
        named.searchParams.set("application_name", name)

        const count = admin.unsafe(
          "SELECT count(*)::int AS count FROM pg_catalog.pg_stat_activity WHERE application_name = $1",
          [name]
        ).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ count: Schema.Finite })))),
          Effect.map((rows) => rows[0]?.count)
        )

        const scopes = [yield* Scope.make(), yield* Scope.make()]

        for (const [index, scope] of scopes.entries()) {
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
          yield* Layer.buildWithScope(
            configured({ key: `${name}-${index}`, maxImageBytes: ByteSize.bytes(16) }, {
              url: Redacted.make(named.toString()),
              ssl: false
            }),
            scope
          )
          assert.strictEqual(yield* count, index + 1)
        }

        for (const [index, scope] of scopes.entries()) {
          yield* Scope.close(scope, Exit.void)

          // Client closure sends Terminate; PostgreSQL observes it asynchronously.
          const remaining = yield* count.pipe(
            Effect.repeat({ while: (remaining) => remaining !== 1 - index, schedule: Schedule.spaced("10 millis") }),
            Effect.timeout("2 seconds"),
            TestClock.withLive
          )

          assert.strictEqual(remaining, 1 - index)
        }
      }))

    it.effect("retires callers before replacing the owner and reopens complete filesystem bytes", () =>
      Effect.gen(function*() {
        const f = yield* fixture
        const ownerScope = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(ownerScope, Exit.void))
        const { store, close } = yield* f.open(ByteSize.kibibytes(64))

        const options = {
          maxImageBytes: ByteSize.kibibytes(64),
          volume: {
            maxEntries: 100,
            maxBytes: ByteSize.kibibytes(32),
            maxFileBytes: ByteSize.kibibytes(16),
            maxPathBytes: ByteSize.bytes(1024)
          }
        }

        const volume = yield* Scope.provide(
          LiveVolume.open(options).pipe(Effect.provideService(LiveVolume.LiveImageStore, store)),
          ownerScope
        )

        const caller = yield* volume.caller()
        yield* caller.writeFile("/hello", new Uint8Array([42]), { access: "write", create: "exclusive" })
        assert.strictEqual(volume.durability, "memory-only")
        yield* Scope.close(ownerScope, Exit.void)
        assert.strictEqual((yield* Effect.flip(caller.readFile("/hello"))).code, "VolumeUnavailable")
        yield* close
        const replacement = yield* f.open(ByteSize.kibibytes(64))

        const reopened = yield* LiveVolume.open(options).pipe(
          Effect.provideService(LiveVolume.LiveImageStore, replacement.store)
        )

        assert.deepStrictEqual(yield* (yield* reopened.caller()).readFile("/hello"), new Uint8Array([42]))
      }))
  })
})

const admissionClient = Effect.gen(function*() {
  let acquisitions = 0

  const unexpected = Effect.sync(() => {
    acquisitions++
  }).pipe(Effect.andThen(Effect.die("Unexpected SQL acquisition")))

  const sql = yield* SqlClient.make({
    driver: "pg",
    acquirer: unexpected,
    compiler: PgClient.makeCompiler(),
    spanAttributes: []
  })

  const pg: Omit<PgClient.PgClient, keyof SqlClient.SqlClient> = {
    [PgClient.TypeId]: PgClient.TypeId,
    config: {},
    json: () => {
      throw new Error("Unexpected JSON construction")
    },
    listen: () => unexpected,
    notify: () => unexpected,
    poolStats: unexpected
  }

  return { client: Object.assign(sql, pg), acquisitions: () => acquisitions }
}).pipe(Effect.provide(Reactivity.layer))

it.layer(NodeCrypto.layer)("PostgreSQL option admission", (it) => {
  for (const key of ["", "a".repeat(257), "bad\0key", "\ud800", "\ud801", "\udc00", "prefix\ud800suffix"]) {
    it.effect(`rejects invalid key ${JSON.stringify(key)} without reserving or issuing SQL`, () =>
      Effect.gen(function*() {
        const f = yield* admissionClient

        const error = yield* Effect.flip(
          Layer.build(Pg.layer({ key, maxImageBytes: ByteSize.bytes(16) })).pipe(
            Effect.provideService(PgClient.PgClient, f.client)
          )
        )

        assert.deepStrictEqual([error.code, error.operation, error.field], [
          "InvalidArgument",
          "PgLiveImageStore.layer",
          "key"
        ])
        assert.strictEqual(f.acquisitions(), 0)
      }))
  }

  it.effect("rejects the PostgreSQL value limit without reserving or issuing SQL", () =>
    Effect.gen(function*() {
      const f = yield* admissionClient

      const error = yield* Effect.flip(
        Layer.build(Pg.layer({ key: "limit", maxImageBytes: ByteSize.gibibytes(1) })).pipe(
          Effect.provideService(PgClient.PgClient, f.client)
        )
      )

      assert.deepStrictEqual([error.code, error.field], ["InvalidArgument", "maxImageBytes"])
      assert.strictEqual(f.acquisitions(), 0)
    }))

  it.effect("refuses a client receive budget too small for admitted images before reserving", () =>
    Effect.gen(function*() {
      const f = yield* admissionClient

      const error = yield* Effect.flip(
        Layer.build(Pg.layer({ key: "large", maxImageBytes: ByteSize.mebibytes(17) })).pipe(
          Effect.provideService(PgClient.PgClient, f.client)
        )
      )

      assert.deepStrictEqual([error.code, error.field], ["InvalidArgument", "client.maxMessageSize"])
      assert.strictEqual(f.acquisitions(), 0)
    }))

  it.effect("refuses acquisition hooks before they can open a transaction", () =>
    Effect.gen(function*() {
      const f = yield* admissionClient
      const client = Object.assign(f.client, { config: { onAcquire: Effect.die("Hook must not execute") } })

      const error = yield* Effect.flip(
        Layer.build(Pg.layer({ key: "hook", maxImageBytes: ByteSize.bytes(16) })).pipe(
          Effect.provideService(PgClient.PgClient, client)
        )
      )

      assert.deepStrictEqual([error.code, error.field], ["InvalidArgument", "client.onAcquire"])
      assert.strictEqual(f.acquisitions(), 0)
    }))
})
