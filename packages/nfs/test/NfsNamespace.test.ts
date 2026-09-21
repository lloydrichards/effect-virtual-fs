import { LiveVolume, VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { assert, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import * as ByteSize from "effect/ByteSize"
import { makeExport } from "../src/internal/export.js"
import { makeNfs4Handler, Operation, Status } from "../src/internal/nfs4.js"
import { type EncoderSession, make, XdrCodec } from "../src/internal/xdr.js"
import { call, generation, limits, sequence, startSession } from "./support/harness.js"

const root = (writer: EncoderSession) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH)

const save = (writer: EncoderSession) => writer.write(XdrCodec.uint32, Operation.SAVEFH)

const lookup = (name: string) => (writer: EncoderSession) =>
  Effect.gen(function*() {
    yield* writer.write(XdrCodec.uint32, Operation.LOOKUP)
    yield* writer.write(XdrCodec.string(), name)
  })

const createDirectory = (name: string) => (writer: EncoderSession) =>
  Effect.gen(function*() {
    yield* writer.write(XdrCodec.uint32, Operation.CREATE)
    yield* writer.write(XdrCodec.uint32, 2)
    yield* writer.write(XdrCodec.string(), name)
    yield* writer.write(XdrCodec.uint32, 0)
    yield* writer.write(XdrCodec.opaque(), new Uint8Array())
  })

const createSymlink = (name: string, target: string) => (writer: EncoderSession) =>
  Effect.gen(function*() {
    yield* writer.write(XdrCodec.uint32, Operation.CREATE)
    yield* writer.write(XdrCodec.uint32, 5)
    yield* writer.write(XdrCodec.string(), target)
    yield* writer.write(XdrCodec.string(), name)
    yield* writer.write(XdrCodec.uint32, 0)
    yield* writer.write(XdrCodec.opaque(), new Uint8Array())
  })

const link = (name: string) => (writer: EncoderSession) =>
  Effect.gen(function*() {
    yield* writer.write(XdrCodec.uint32, Operation.LINK)
    yield* writer.write(XdrCodec.string(), name)
  })

const remove = (name: string) => (writer: EncoderSession) =>
  Effect.gen(function*() {
    yield* writer.write(XdrCodec.uint32, Operation.REMOVE)
    yield* writer.write(XdrCodec.string(), name)
  })

const rename = (from: string, to: string) => (writer: EncoderSession) =>
  Effect.gen(function*() {
    yield* writer.write(XdrCodec.uint32, Operation.RENAME)
    yield* writer.write(XdrCodec.string(), from)
    yield* writer.write(XdrCodec.string(), to)
  })

const status = (bytes: Uint8Array) =>
  Effect.gen(function*() {
    return yield* (yield* make.openReader(bytes, limits)).read(XdrCodec.uint32)
  })

const namespaceChange = (bytes: Uint8Array, operation: number, prefix: ReadonlyArray<number>) =>
  Effect.gen(function*() {
    const reader = yield* make.openReader(bytes, limits)
    assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)
    yield* reader.read(XdrCodec.string())
    assert.strictEqual(yield* reader.read(XdrCodec.uint32), prefix.length + 2)
    assert.strictEqual(yield* reader.read(XdrCodec.uint32), Operation.SEQUENCE)
    assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)
    yield* reader.read(XdrCodec.fixedOpaque(16))

    for (let field = 0; field < 5; field++) yield* reader.read(XdrCodec.uint32)

    for (const code of prefix) {
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), code)
      assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)
    }

    assert.strictEqual(yield* reader.read(XdrCodec.uint32), operation)
    assert.strictEqual(yield* reader.read(XdrCodec.uint32), Status.OK)

    const readChange = () =>
      Effect.gen(function*() {
        assert.isTrue(yield* reader.read(XdrCodec.boolean))
        const before = yield* reader.read(XdrCodec.uint64)
        const after = yield* reader.read(XdrCodec.uint64)
        assert.notStrictEqual(before, after)

        return {
          before,
          after
        }
      })

    const first = yield* readChange()
    const second = operation === Operation.RENAME ? yield* readChange() : undefined

    if (operation === Operation.CREATE) assert.deepStrictEqual(yield* reader.read(XdrCodec.array(XdrCodec.uint32)), [])
    yield* reader.finish

    return {
      first,
      second
    }
  })

const makeHandler = (
  caller: Parameters<typeof makeExport>[0],
  writable = true,
  mapped?: Parameters<typeof makeExport>[0]
) => {
  const options = {
    leaseDurationSeconds: 30,
    callbackTimeout: "1 second",
    generation,
    now: () => 0,
    limits,
    writable
  } as const

  return makeNfs4Handler(
    makeExport(caller, generation, {
      maxFilehandles: 32,
      maxNameBytes: ByteSize.bytes(255)
    }),
    mapped === undefined ? options : {
      ...options,
      callerFor: () => Effect.succeed(mapped)
    }
  )
}

it.layer(NodeCrypto.layer)("NFS namespace mutations", (it) => {
  it.effect("creates a directory and symlink, reporting the directory change and retaining the created handle", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      const handler = yield* makeHandler(caller)

      const {
        session
      } = yield* startSession(handler, "namespace-create")

      const response = yield* make.openReader(
        yield* handler.compound(
          yield* call([
            sequence(session, 1),
            root,
            createDirectory("docs"),
            (writer) => writer.write(XdrCodec.uint32, Operation.GETFH)
          ])
        ),
        limits
      )

      assert.strictEqual(yield* response.read(XdrCodec.uint32), Status.OK)
      yield* response.read(XdrCodec.string())
      assert.strictEqual(yield* response.read(XdrCodec.uint32), 4)
      assert.strictEqual(yield* response.read(XdrCodec.uint32), Operation.SEQUENCE)
      assert.strictEqual(yield* response.read(XdrCodec.uint32), Status.OK)
      yield* response.read(XdrCodec.fixedOpaque(16))

      for (let field = 0; field < 5; field++) yield* response.read(XdrCodec.uint32)
      assert.strictEqual(yield* response.read(XdrCodec.uint32), Operation.PUTROOTFH)
      assert.strictEqual(yield* response.read(XdrCodec.uint32), Status.OK)
      assert.strictEqual(yield* response.read(XdrCodec.uint32), Operation.CREATE)
      assert.strictEqual(yield* response.read(XdrCodec.uint32), Status.OK)
      assert.strictEqual(yield* response.read(XdrCodec.boolean), true)
      assert.notStrictEqual(yield* response.read(XdrCodec.uint64), yield* response.read(XdrCodec.uint64))
      assert.deepStrictEqual(yield* response.read(XdrCodec.array(XdrCodec.uint32)), [])
      assert.strictEqual(yield* response.read(XdrCodec.uint32), Operation.GETFH)
      assert.strictEqual(yield* response.read(XdrCodec.uint32), Status.OK)
      const directoryHandle = yield* response.read(XdrCodec.opaque())
      assert.ok(directoryHandle.length > 0)
      yield* response.finish
      assert.strictEqual(
        yield* status(
          yield* handler.compound(yield* call([sequence(session, 2), root, createSymlink("shortcut", "docs/guide")]))
        ),
        Status.OK
      )
      assert.strictEqual(yield* caller.readLink("/shortcut"), "docs/guide")
      assert.strictEqual(
        yield* status(
          yield* handler.compound(
            yield* call([sequence(session, 3), (writer) =>
              Effect.gen(function*() {
                yield* writer.write(XdrCodec.uint32, Operation.PUTFH)
                yield* writer.write(XdrCodec.opaque(), directoryHandle)
              }), createDirectory("nested")])
          )
        ),
        Status.OK
      )
      assert.strictEqual((yield* caller.stat("/docs/nested")).kind, "directory")
    }))
  it.effect("links and renames by saved and current handles while preserving inode identity", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.mkdir("/from")
      yield* caller.mkdir("/to")
      yield* caller.writeFile("/from/file", new Uint8Array([1]), {
        access: "write",
        create: "exclusive"
      })
      const original = yield* caller.stat("/from/file")
      const handler = yield* makeHandler(caller)

      const {
        session
      } = yield* startSession(handler, "namespace-move")

      assert.strictEqual(
        yield* status(
          yield* handler.compound(
            yield* call([
              sequence(session, 1),
              root,
              lookup("from"),
              lookup("file"),
              save,
              root,
              lookup("to"),
              link("linked")
            ])
          )
        ),
        Status.OK
      )
      assert.strictEqual((yield* caller.stat("/to/linked")).ino, original.ino)
      assert.strictEqual(
        yield* status(
          yield* handler.compound(
            yield* call([sequence(session, 2), root, lookup("from"), save, root, lookup("to"), rename("file", "moved")])
          )
        ),
        Status.OK
      )
      assert.strictEqual((yield* caller.stat("/to/moved")).ino, original.ino)
      assert.strictEqual(
        yield* status(
          yield* handler.compound(yield* call([sequence(session, 3), root, lookup("to"), remove("linked")]))
        ),
        Status.OK
      )
      assert.deepStrictEqual(yield* caller.readFile("/to/moved"), new Uint8Array([1]))
    }))
  it.effect("keeps earlier compound mutations when a later operation fails", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      const handler = yield* makeHandler(caller)

      const {
        session
      } = yield* startSession(handler, "namespace-partial")

      const reply = yield* handler.compound(
        yield* call([sequence(session, 1), root, createDirectory("kept"), root, remove("missing")])
      )

      assert.strictEqual(yield* status(reply), Status.NOENT)
      assert.strictEqual((yield* caller.stat("/kept")).kind, "directory")
    }))
  it.effect("reports changes for links, directory removal, and replacement rename", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.mkdir("/from")
      yield* caller.mkdir("/to")
      yield* caller.mkdir("/to/empty")
      yield* caller.writeFile("/from/file", new Uint8Array([1]), {
        access: "write",
        create: "exclusive"
      })
      yield* caller.writeFile("/to/replaced", new Uint8Array([2]), {
        access: "write",
        create: "exclusive"
      })
      const original = yield* caller.stat("/from/file")
      const rootReference = yield* caller.rootReference
      const fromReference = yield* caller.lookupReference(rootReference, new TextEncoder().encode("from"))
      const toReference = yield* caller.lookupReference(rootReference, new TextEncoder().encode("to"))
      const handler = yield* makeHandler(caller)

      const {
        session
      } = yield* startSession(handler, "namespace-change")

      const beforeLink = (yield* caller.observeMetadata(toReference)).revision

      const linked = yield* namespaceChange(
        yield* handler.compound(
          yield* call([
            sequence(session, 1),
            root,
            lookup("from"),
            lookup("file"),
            save,
            root,
            lookup("to"),
            link("alias")
          ])
        ),
        Operation.LINK,
        [
          Operation.PUTROOTFH,
          Operation.LOOKUP,
          Operation.LOOKUP,
          Operation.SAVEFH,
          Operation.PUTROOTFH,
          Operation.LOOKUP
        ]
      )

      assert.deepStrictEqual(linked.first, {
        before: beforeLink,
        after: (yield* caller.observeMetadata(toReference)).revision
      })
      assert.strictEqual((yield* caller.stat("/to/alias")).ino, original.ino)
      yield* namespaceChange(
        yield* handler.compound(yield* call([sequence(session, 2), root, lookup("to"), remove("empty")])),
        Operation.REMOVE,
        [Operation.PUTROOTFH, Operation.LOOKUP]
      )
      assert.strictEqual((yield* Effect.flip(caller.stat("/to/empty"))).code, "NotFound")
      const beforeFrom = (yield* caller.observeMetadata(fromReference)).revision
      const beforeTo = (yield* caller.observeMetadata(toReference)).revision

      const renamed = yield* namespaceChange(
        yield* handler.compound(
          yield* call([
            sequence(session, 3),
            root,
            lookup("from"),
            save,
            root,
            lookup("to"),
            rename("file", "replaced")
          ])
        ),
        Operation.RENAME,
        [Operation.PUTROOTFH, Operation.LOOKUP, Operation.SAVEFH, Operation.PUTROOTFH, Operation.LOOKUP]
      )

      assert.deepStrictEqual(renamed.first, {
        before: beforeFrom,
        after: (yield* caller.observeMetadata(fromReference)).revision
      })
      assert.deepStrictEqual(renamed.second, {
        before: beforeTo,
        after: (yield* caller.observeMetadata(toReference)).revision
      })
      assert.strictEqual((yield* caller.stat("/to/replaced")).ino, original.ino)
      assert.deepStrictEqual(yield* caller.readFile("/to/replaced"), new Uint8Array([1]))
    }))
  it.effect("validates namespace operands and keeps read-only exports unchanged", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.writeFile("/file", new Uint8Array([1]), {
        access: "write",
        create: "exclusive"
      })
      const writable = yield* makeHandler(caller)

      const {
        session
      } = yield* startSession(writable, "namespace-errors")

      assert.strictEqual(
        yield* status(yield* writable.compound(yield* call([sequence(session, 1), root, remove("..")]))),
        Status.BADNAME
      )
      assert.strictEqual(
        yield* status(yield* writable.compound(yield* call([sequence(session, 2), root, remove("")]))),
        Status.INVAL
      )
      assert.strictEqual(
        yield* status(yield* writable.compound(yield* call([sequence(session, 3), root, remove("absent")]))),
        Status.NOENT
      )
      assert.strictEqual(
        yield* status(yield* writable.compound(yield* call([sequence(session, 4), root, lookup("file"), remove("x")]))),
        Status.NOTDIR
      )
      assert.strictEqual(
        yield* status(yield* writable.compound(yield* call([sequence(session, 5), root, rename("file", "other")]))),
        Status.NOFILEHANDLE
      )
      const readOnly = yield* makeHandler(caller, false)

      const {
        session: readOnlySession
      } = yield* startSession(readOnly, "namespace-read-only")

      assert.strictEqual(
        yield* status(
          yield* readOnly.compound(yield* call([sequence(readOnlySession, 1), root, createDirectory("denied")]))
        ),
        Status.ROFS
      )
      assert.strictEqual(
        yield* status(yield* readOnly.compound(yield* call([sequence(readOnlySession, 2), root, remove("file")]))),
        Status.ROFS
      )
    }))
  it.effect("enforces the mapped caller's directory permissions for namespace changes", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const admin = yield* volume.caller()
      yield* admin.mkdir("/private", {
        mode: 0o700
      })
      yield* admin.writeFile("/private/file", new Uint8Array([1]), {
        access: "write",
        create: "exclusive"
      })

      const guest = yield* volume.caller({
        identity: {
          uid: 1000,
          gid: 1000,
          groups: [],
          privileged: false
        }
      })

      const handler = yield* makeHandler(admin, true, guest)

      const {
        session
      } = yield* startSession(handler, "namespace-mapped-denial")

      assert.strictEqual(
        yield* status(yield* handler.compound(yield* call([sequence(session, 1), root, createDirectory("blocked")]))),
        Status.ACCESS
      )
      assert.strictEqual(
        yield* status(yield* handler.compound(yield* call([sequence(session, 2), root, remove("private")]))),
        Status.ACCESS
      )
      assert.strictEqual((yield* admin.stat("/private/file")).kind, "file")
      assert.strictEqual((yield* Effect.flip(admin.stat("/blocked"))).code, "NotFound")
    }))
  it.effect("reopens an injected committed image with NFS namespace and metadata changes", () => {
    let image: Uint8Array | undefined

    const store = Layer.succeed(
      LiveVolume.LiveImageStore,
      LiveVolume.LiveImageStore.of({
        loadOrCreate: (initial) => Effect.sync(() => image ??= initial),
        commit: (candidate) =>
          Effect.sync(() => {
            image = candidate.slice()

            return "committed" as const
          })
      })
    )

    const options: LiveVolume.Options = {
      maxImageBytes: ByteSize.kilobytes(64),
      volume: {
        maxEntries: 16,
        maxBytes: ByteSize.bytes(64),
        maxFileBytes: ByteSize.bytes(32),
        maxPathBytes: ByteSize.bytes(255)
      }
    }

    return Effect.gen(function*() {
      yield* Effect.scoped(Effect.gen(function*() {
        const volume = yield* LiveVolume.open(options)
        const caller = yield* volume.caller()

        const handler = yield* makeNfs4Handler(
          makeExport(
            caller,
            generation,
            {
              maxFilehandles: 32,
              maxNameBytes: ByteSize.bytes(255)
            },
            generation,
            volume
          ),
          {
            leaseDurationSeconds: 30,
            callbackTimeout: "1 second",
            generation,
            now: () => 0,
            limits,
            writable: true
          }
        )

        const {
          session
        } = yield* startSession(handler, "namespace-live-before")

        assert.strictEqual(
          yield* status(yield* handler.compound(yield* call([sequence(session, 1), root, createDirectory("docs")]))),
          Status.OK
        )
        assert.strictEqual(
          yield* status(
            yield* handler.compound(
              yield* call([sequence(session, 2), root, lookup("docs"), createSymlink("guide", "../target")])
            )
          ),
          Status.OK
        )
        assert.strictEqual(
          yield* status(
            yield* handler.compound(
              yield* call([sequence(session, 3), root, lookup("docs"), (writer) =>
                Effect.gen(function*() {
                  const values = yield* make.openWriter(limits, 4)
                  yield* values.write(XdrCodec.uint32, 0o750)
                  yield* writer.write(XdrCodec.uint32, Operation.SETATTR)
                  yield* writer.write(XdrCodec.fixedOpaque(16), new Uint8Array(16))
                  yield* writer.write(XdrCodec.array(XdrCodec.uint32), [0, 1 << 1])
                  yield* writer.write(XdrCodec.opaque(), yield* values.finish)
                })])
            )
          ),
          Status.OK
        )
      }))
      yield* Effect.scoped(Effect.gen(function*() {
        const volume = yield* LiveVolume.open(options)
        const caller = yield* volume.caller()
        assert.strictEqual((yield* caller.stat("/docs")).mode, 0o750)
        assert.strictEqual(yield* caller.readLink("/docs/guide"), "../target")
      }))
    }).pipe(Effect.provide(store))
  })
})
