import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Cause, Crypto, Deferred, Effect, Exit, Fiber, HashMap, Option, Scope } from "effect"
import type { Identity } from "../src/Caller.js"
import { DirectoryHandleId, FileHandleId } from "../src/FileHandle.js"
import {
  Errors,
  type Installation,
  makeEngine,
  Resolution,
  State,
  TokenRegistry as Tokens,
  withVolumeTestSeams
} from "../src/internal/engine.js"
import { Target } from "../src/Target.js"
import type { DirectoryHandle, EntryInput, FileHandle } from "../src/VirtualFileSystem.js"
import { pathText } from "./support/text.js"
import { directory, file, name, symlink, volumeState } from "./support/volumeState.js"

const text = new TextEncoder()

it.effect("should retain unlinked bytes and capacity when an open handle outlives every name", () =>
  Effect.gen(function*() {
    assert.isTrue(Option.isNone(yield* Effect.serviceOption(Crypto.Crypto)))
    const engine = yield* makeEngine({ limits: { maxBytes: ByteSize.bytes(4) } })
    const ops = (yield* engine.context({ umask: 0 })).operations
    const bytes = text.encode("data")
    yield* ops.writeFile("/file", bytes, { access: "write", create: "exclusive" })
    bytes.fill(0)
    yield* ops.link("/file", "/alias")
    const handle = yield* ops.open("/file", { access: "readWrite" })
    yield* handle.pwrite(text.encode("D"), 0n)
    assert.deepStrictEqual(yield* ops.readFile("/alias"), text.encode("Data"))
    yield* ops.unlink("/file")
    yield* ops.unlink("/alias")
    assert.deepStrictEqual((yield* handle.pread(4, 0n)).bytes, text.encode("Data"))
    assert.strictEqual((yield* engine.usage).usedBytes, 4n)

    const denied = yield* Effect.flip(
      ops.writeFile("/next", text.encode("x"), { access: "write", create: "exclusive" })
    )

    assert.strictEqual(denied.code, "NoSpace")
    yield* handle.close
    assert.strictEqual((yield* engine.usage).usedBytes, 0n)
    yield* ops.writeFile("/next", text.encode("x"), { access: "write", create: "exclusive" })
    assert.strictEqual((yield* Effect.flip(handle.stat)).code, "InvalidHandle")
  }))

it.effect("should enforce independent permissions and lookup rules when private contexts derive roots", () =>
  Effect.gen(function*() {
    const engine = yield* makeEngine()
    const owner = (yield* engine.context({ umask: 0 })).operations
    yield* owner.mkdir("/work", { mode: 0o777 })

    const user = yield* engine.context({
      identity: { uid: 1000, gid: 1000, groups: [], privileged: false },
      umask: 0o027
    })

    const rooted = yield* user.withRoot("/work")
    yield* rooted.operations.writeFile("/data", text.encode("private"), {
      access: "write",
      create: "exclusive",
      mode: 0o666
    })
    assert.strictEqual((yield* owner.stat("/work/data")).mode, 0o640)
    yield* owner.symlink("data", "/work/link")
    assert.strictEqual(
      (yield* rooted.operations.stat({ _tag: "Path", path: "/link", followFinalSymlink: false })).kind,
      "symlink"
    )
    yield* owner.chmod("/work/data", 0o000)
    assert.strictEqual((yield* Effect.flip(rooted.operations.readFile("/data"))).code, "AccessDenied")
    assert.strictEqual((yield* Effect.flip(rooted.operations.stat("/../outside"))).code, "NotFound")
  }))

it.effect("should preserve a replacement when private cleanup observes a changed entry", () =>
  Effect.gen(function*() {
    const ops = (yield* (yield* makeEngine()).context({ umask: 0 })).operations
    yield* ops.mkdir("/owned")
    yield* ops.writeFile("/owned/file", text.encode("old"), { access: "write", create: "exclusive" })
    const expected = yield* ops.lookup("/owned")
    let reached = false

    const beforeTreeRemoval = Effect.gen(function*() {
      if (reached) return
      reached = true
      yield* ops.rename("/owned/file", "/moved")
      yield* ops.writeFile("/owned/file", text.encode("replacement"), { access: "write", create: "exclusive" })
    }).pipe(Effect.orDie)

    assert.strictEqual(
      (yield* Effect.flip(
        ops.remove("/owned", { recursive: true, expected }).pipe(withVolumeTestSeams({ beforeTreeRemoval }))
      )).code,
      "NotFound"
    )
    assert.isTrue(reached)
    assert.deepStrictEqual(yield* ops.readFile("/owned/file"), text.encode("replacement"))
    assert.deepStrictEqual(yield* ops.readFile("/moved"), text.encode("old"))
  }))

it.effect("should reclaim local ownership when storage rejects private durable cleanup", () =>
  Effect.gen(function*() {
    let reject = false
    let installed: Installation | undefined

    const engine = yield* makeEngine({
      commitProvider: {
        mode: "durable",
        commit: () => Effect.succeed(reject ? "rejected" : "committed"),
        shutdown: Effect.void
      },
      installed: (_events, value) => {
        installed = value
      }
    })

    const ops = (yield* engine.context()).operations
    yield* ops.writeFile("/file", text.encode("retained"), { access: "write", create: "exclusive" })
    const scope = yield* Scope.make()
    const file = yield* Scope.provide(ops.open("/file", { access: "read" }), scope)
    yield* ops.unlink("/file")
    reject = true
    yield* Scope.close(scope, Exit.void)
    assert.isDefined(installed)
    assert.strictEqual(installed?.after.usedBytes, 0n)
    assert.strictEqual(installed?.after.open.size, 0)
    assert.strictEqual((yield* Effect.flip(engine.usage)).code, "VolumeUnavailable")
    assert.isTrue(["InvalidHandle", "VolumeUnavailable"].includes((yield* Effect.flip(file.stat)).code))
  }))

describe("path and entry resolution", () => {
  const OpContext = Errors.OpContext

  const { getNode, ROOT_INO } = State

  const op = OpContext.make("open")

  const rootIdentity: Identity = { uid: 0, gid: 0, groups: [], privileged: true }

  const setup = (identity = rootIdentity, maxPathBytes?: ByteSize.ByteSize) => {
    const state = volumeState()
    const registry = Tokens.make(Symbol(), state.get)
    const caller = registry.directory(ROOT_INO)
    const root = directory(1)
    const folder = directory(2, ROOT_INO, "folder")
    const content = file(3)
    state.put(root)
    state.attach(root, "folder", folder)
    state.attach(folder, "file", content)

    const resolver = Resolution.make({
      caller,
      get: state.get,
      authorityView: Effect.succeed((ino) => getNode(state.state, ino)),
      registry,
      identity,
      maxPathBytes
    })

    const prepare = (input: EntryInput) => Effect.fromResult(resolver.prepareEntry(input, op))

    return { state, registry, caller, root, folder, content, resolver, prepare }
  }

  const directoryHandle = (ref: Tokens.DirectoryReference, registry: Tokens.TokenRegistry): DirectoryHandle => {
    const handle: DirectoryHandle = {
      [DirectoryHandleId]: true,
      stat: Effect.succeed({ ...directory(1).metadata, revision: 0n }),
      close: Effect.void
    }

    registry.registerDirectory(handle, ref)

    return handle
  }

  describe("target resolution", () => {
    it.effect("should preserve root identity and error paths when resolving path targets", () =>
      Effect.gen(function*() {
        const { resolver, content } = setup()
        const root = yield* resolver.resolve(Target.Path({ path: "/" }), { kind: "Node" }, op)
        assert.strictEqual(root.kind, "node")
        const found = yield* resolver.resolve(Target.Path({ path: "/folder/file" }), { kind: "Node" }, op)
        assert.strictEqual(found.kind, "entry")
        assert.strictEqual(found.node.ino, content.ino)
        assert.strictEqual(yield* pathText(found.op.fail("AccessDenied").path), "/folder/file")

        const failed = yield* Effect.flip(
          resolver.resolve(Target.Path({ path: "/folder/missing" }), { kind: "Node" }, op)
        )

        assert.strictEqual(failed.code, "NotFound")
        assert.strictEqual(yield* pathText(failed.path), "/folder/missing")
      }))

    it.effect("should omit path diagnostics when resolving reference and handle targets", () =>
      Effect.gen(function*() {
        const { resolver, registry, folder } = setup()
        const token = registry.referenceFor(folder.ino)
        const found = yield* resolver.resolve(Target.Reference({ reference: token }), { kind: "Node" }, op)
        assert.strictEqual(found.node.ino, folder.ino)

        const foreign = yield* Effect.flip(
          setup().resolver.resolve(Target.Reference({ reference: token }), { kind: "Node" }, op)
        )

        assert.strictEqual(foreign.code, "ForeignReference")
        assert.isUndefined(foreign.path)
        const ref = registry.directory(folder.ino)
        const handle = directoryHandle(ref, registry)
        assert.strictEqual(
          (yield* resolver.resolve(Target.Handle({ handle }), { kind: "Node" }, op)).node.ino,
          folder.ino
        )
        Tokens.released(ref)
        assert.strictEqual(
          (yield* Effect.flip(resolver.resolve(Target.Handle({ handle }), { kind: "Node" }, op))).code,
          "InvalidHandle"
        )
      }))

    it.effect("should validate a foreign base only when the path is relative", () =>
      Effect.gen(function*() {
        const { resolver, registry, folder, content } = setup()
        const foreign = setup().registry
        const foreignHandle = directoryHandle(foreign.directory(ROOT_INO), foreign)
        const base = directoryHandle(registry.directory(folder.ino), registry)
        assert.strictEqual(
          (yield* resolver.resolve(Target.Path({ path: "file", relativeTo: base }), { kind: "Node" }, op)).node.ino,
          content.ino
        )
        assert.strictEqual(
          (yield* resolver.resolve(
            Target.Path({ path: "/folder/file", relativeTo: foreignHandle }),
            { kind: "Node" },
            op
          )).node.ino,
          content.ino
        )
        assert.strictEqual(
          (yield* Effect.flip(
            resolver.resolve(Target.Path({ path: "file", relativeTo: foreignHandle }), { kind: "Node" }, op)
          )).code,
          "ForeignHandle"
        )
      }))

    it.effect("should allow observation and refuse traversal when a directory handle is detached", () =>
      Effect.gen(function*() {
        const { resolver, registry, state, folder, prepare } = setup()
        const handle = directoryHandle(registry.directory(folder.ino), registry)
        state.put({ ...folder, metadata: { ...folder.metadata, nlink: 0 } })
        assert.strictEqual(
          (yield* resolver.resolve(Target.Handle({ handle }), { kind: "Node" }, op)).node.ino,
          folder.ino
        )

        const path = yield* Effect.flip(
          resolver.resolve(Target.Path({ path: ".", relativeTo: handle }), { kind: "Node" }, op)
        )

        const entry = yield* Effect.flip(
          resolver.resolve(
            yield* prepare({ directory: Target.Handle({ handle }), name: "child" }),
            { kind: "Parent" },
            op
          )
        )

        assert.strictEqual(path.code, "NotFound")
        assert.strictEqual(entry.code, "NotFound")
      }))

    it.effect("should conceal child existence when ancestor search permission is denied", () =>
      Effect.gen(function*() {
        const { resolver, state, folder } = setup({ uid: 1, gid: 1, groups: [], privileged: false })
        state.put({
          ...folder,
          entries: new Map(folder.entries).set(name("file"), file(3).ino),
          metadata: { ...folder.metadata, mode: 0o700 }
        })

        for (const path of ["/folder/file", "/folder/missing"]) {
          const failure = yield* Effect.flip(resolver.resolve(Target.Path({ path }), { kind: "Node" }, op))
          assert.strictEqual(failure.code, "AccessDenied")
          assert.strictEqual(yield* pathText(failure.path), path)
        }
      }))

    it.effect("should reject malformed paths first when the caller is also closed", () =>
      Effect.gen(function*() {
        const { resolver, caller } = setup()
        Tokens.released(caller)
        assert.strictEqual(
          (yield* Effect.flip(resolver.resolve(Target.Path({ path: "/\uD800" }), { kind: "Node" }, op))).code,
          "InvalidPathEncoding"
        )
        assert.strictEqual(
          (yield* Effect.flip(resolver.resolve(Target.Path({ path: "/folder" }), { kind: "Node" }, op))).code,
          "ClosedCaller"
        )
      }))

    it.effect("should honor target symlink policy when the operation permits an override", () =>
      Effect.gen(function*() {
        const { resolver, state, root, content } = setup()
        const link = symlink(4, "/folder/file")
        state.attach(root, "link", link)
        const target = Target.Path({ path: "/link", followFinalSymlink: false })
        assert.strictEqual((yield* resolver.resolve(target, { kind: "Node" }, op)).node.ino, link.ino)
        assert.strictEqual((yield* resolver.resolve(target, { kind: "Node", final: true }, op)).node.ino, content.ino)
        assert.strictEqual(
          (yield* resolver.resolve(Target.Path({ path: "/link" }), {
            kind: "Node",
            final: true,
            followFinalSymlink: false
          }, op)).node.ino,
          link.ino
        )
      }))

    it.effect("should require a directory when the path has a trailing slash", () =>
      Effect.gen(function*() {
        const { resolver, state, root, folder } = setup()
        state.attach(root, "link", symlink(4, "/folder"))
        assert.strictEqual(
          (yield* resolver.resolve(Target.Path({ path: "/link/", followFinalSymlink: false }), { kind: "Node" }, op))
            .node
            .ino,
          folder.ino
        )
        assert.strictEqual(
          (yield* Effect.flip(resolver.resolve(Target.Path({ path: "/folder/file/" }), { kind: "Node" }, op))).code,
          "NotDirectory"
        )
      }))

    it.effect("should report limits at the original path when symlink expansion exceeds a bound", () =>
      Effect.gen(function*() {
        const { resolver, state, root } = setup()
        state.attach(root, "loop", symlink(4, "/loop"))
        assert.strictEqual(
          (yield* Effect.flip(resolver.resolve(Target.Path({ path: "/loop" }), { kind: "Node" }, op))).code,
          "SymlinkLoop"
        )
        const bounded = setup(rootIdentity, ByteSize.bytes(8))
        bounded.state.attach(bounded.root, "l", symlink(4, "/long-target"))
        const failure = yield* Effect.flip(bounded.resolver.resolve(Target.Path({ path: "/l" }), { kind: "Node" }, op))
        assert.strictEqual(failure.code, "PathTooLong")
        assert.strictEqual(yield* pathText(failure.path), "/l")
      }))
  })

  describe("entry resolution", () => {
    it.effect("should resolve the parent when the final entry is missing or a symlink", () =>
      Effect.gen(function*() {
        const { resolver, prepare, folder } = setup()
        const missing = yield* resolver.resolve(yield* prepare("/folder/missing/"), { kind: "Parent" }, op)
        assert.strictEqual(missing.parent, folder.ino)
        assert.strictEqual(missing.name, name("missing"))
        assert.isTrue(missing.trailingSlash)
        const existing = yield* resolver.resolve(yield* prepare("/folder/file"), { kind: "Parent" }, op)
        assert.strictEqual(existing.parent, missing.parent)
        assert.strictEqual(existing.name, name("file"))
      }))

    it.effect("should retain the mutation directory when an entry exists or is missing", () =>
      Effect.gen(function*() {
        const { resolver, prepare, folder, content } = setup()
        const mode: Resolution.OrCreateMode = { kind: "OrCreate", create: "ifMissing", finalSymlink: "follow" }
        const existing = yield* resolver.resolve(yield* prepare("/folder/file"), mode, op)
        const missing = yield* resolver.resolve(yield* prepare("/folder/new"), mode, op)
        assert.strictEqual(existing.kind, "existing")
        assert.strictEqual(existing.kind === "existing" ? existing.node.ino : undefined, content.ino)
        assert.strictEqual(missing.kind, "missing")
        assert.strictEqual(missing.parent.ino, folder.ino)
        assert.strictEqual(missing.name, name("new"))
        assert.strictEqual(
          (yield* Effect.flip(resolver.resolve(yield* prepare("/folder/new"), { ...mode, create: "never" }, op))).code,
          "NotFound"
        )
      }))

    it.effect("should preserve creation constraints when paths name roots or have trailing slashes", () =>
      Effect.gen(function*() {
        const { resolver, prepare } = setup()
        const mode: Resolution.OrCreateMode = { kind: "OrCreate", create: "ifMissing", finalSymlink: "follow" }
        assert.strictEqual((yield* Effect.flip(resolver.resolve(yield* prepare("/"), mode, op))).code, "IsDirectory")
        const missing = yield* resolver.resolve(yield* prepare("/new/"), mode, op)
        assert.strictEqual(missing.kind, "missing")
        assert.isTrue(missing.trailingSlash)
      }))

    it.effect("should refuse exclusive creation when the path names a dangling symlink", () =>
      Effect.gen(function*() {
        const { resolver, prepare, state, root, folder } = setup()
        state.attach(root, "link", symlink(4, "/folder/new"))
        const prepared = yield* prepare("/link")
        const mode: Resolution.OrCreateMode = { kind: "OrCreate", create: "ifMissing", finalSymlink: "follow" }
        const missing = yield* resolver.resolve(prepared, mode, op)
        assert.strictEqual(missing.kind, "missing")
        assert.strictEqual(missing.parent.ino, folder.ino)
        assert.strictEqual(missing.name, name("new"))
        assert.strictEqual(
          (yield* Effect.flip(resolver.resolve(prepared, { ...mode, create: "exclusive" }, op))).code,
          "AlreadyExists"
        )
      }))

    it.effect("should retain the direct entry when a symlink resolves to an existing file", () =>
      Effect.gen(function*() {
        const { resolver, prepare, state, root, folder, registry, content } = setup()
        state.attach(root, "link", symlink(4, "/folder/file"))

        const prepared = yield* prepare({
          directory: Target.Reference({ reference: registry.referenceFor(ROOT_INO) }),
          name: "link"
        })

        const result = yield* resolver.resolve(
          prepared,
          { kind: "OrCreate", create: "never", finalSymlink: "follow" },
          op
        )

        assert.strictEqual(result.kind, "existing")
        assert.strictEqual(result.kind === "existing" ? result.node.ino : undefined, content.ino)
        assert.strictEqual(result.parent.ino, folder.ino)
        assert.strictEqual(result.origin.parent.ino, ROOT_INO)
        assert.strictEqual(result.origin.name, name("link"))
        assert.isUndefined(result.op.fail("AccessDenied").path)
      }))

    it.effect("should run the entry guard first when creation is exclusive or follows a symlink", () =>
      Effect.gen(function*() {
        const { resolver, prepare, state, root, registry } = setup()
        const link = symlink(4, "/loop")
        state.attach(root, "loop", link)

        const prepared = yield* prepare({
          directory: Target.Reference({ reference: registry.referenceFor(ROOT_INO) }),
          name: "loop"
        })

        const failure = yield* Effect.flip(resolver.resolve(prepared, {
          kind: "OrCreate",
          create: "exclusive",
          finalSymlink: "follow",
          beforeFollow: (_, child) => {
            assert.strictEqual(child?.ino, link.ino)

            return Effect.fail(op.fail("StaleReference"))
          }
        }, op))

        assert.strictEqual(failure.code, "StaleReference")
      }))

    it.effect("should preserve operation-specific refusal ordering when creation is exclusive", () =>
      Effect.gen(function*() {
        const { resolver, prepare, state, root, registry } = setup()
        state.attach(root, "link", symlink(4, "/folder/new"))

        const prepared = yield* prepare({
          directory: Target.Reference({ reference: registry.referenceFor(ROOT_INO) }),
          name: "link"
        })

        const mode: Resolution.OrCreateMode = { kind: "OrCreate", create: "exclusive", finalSymlink: "follow" }
        assert.strictEqual((yield* Effect.flip(resolver.resolve(prepared, mode, op))).code, "AlreadyExists")
        assert.strictEqual(
          (yield* resolver.resolve(prepared, { ...mode, entryExclusive: "afterSymlink" }, op)).kind,
          "missing"
        )
      }))

    it.effect("should report the directory target first when exclusive writeFile follows a directory link", () =>
      Effect.gen(function*() {
        const { resolver, prepare, state, root, registry } = setup()
        state.attach(root, "link", symlink(4, "/folder"))

        const prepared = yield* prepare({
          directory: Target.Reference({ reference: registry.referenceFor(ROOT_INO) }),
          name: "link"
        })

        const mode: Resolution.OrCreateMode = { kind: "OrCreate", create: "exclusive", finalSymlink: "follow" }
        assert.strictEqual((yield* Effect.flip(resolver.resolve(prepared, mode, op))).code, "AlreadyExists")
        assert.strictEqual(
          (yield* Effect.flip(resolver.resolve(prepared, { ...mode, entryExclusive: "afterSymlink" }, op))).code,
          "IsDirectory"
        )
      }))

    it.effect("should preserve entry mutation rules when replacing symlinks or naming reserved entries", () =>
      Effect.gen(function*() {
        const { resolver, prepare, state, root, registry } = setup()
        const link = symlink(4, "/folder/file")
        state.attach(root, "link", link)
        const mode: Resolution.OrCreateMode = { kind: "OrCreate", create: "ifMissing", finalSymlink: "preserve" }
        const result = yield* resolver.resolve(yield* prepare("/link"), mode, op)
        assert.strictEqual(result.kind === "existing" ? result.node.ino : undefined, link.ino)

        const reserved = yield* prepare({
          directory: Target.Reference({ reference: registry.referenceFor(ROOT_INO) }),
          name: "."
        })

        assert.strictEqual((yield* Effect.flip(resolver.resolve(reserved, mode, op))).code, "InvalidArgument")
      }))

    it.effect("should observe newly created directories when traversal reads the current draft", () =>
      Effect.gen(function*() {
        const { resolver, state } = setup()
        let next = 4
        const created: Array<string> = []

        const result = yield* resolver.resolve(Target.Path({ path: "/first/second" }), {
          kind: "Node",
          createMissing: (parent, key, final) =>
            Effect.sync(() => {
              const node = { ...directory(next++, parent.ino), name: key }
              state.put({ ...parent, entries: new Map(parent.entries).set(key, node.ino) })
              state.put(node)
              created.push(`${key}:${final}`)

              return node
            })
        }, op)

        assert.deepEqual(created, [`${name("first")}:false`, `${name("second")}:true`])
        assert.strictEqual(result.node.ino, 5)
        assert.strictEqual(
          (yield* resolver.resolve(Target.Path({ path: "/first/second/.." }), { kind: "Node" }, op)).node.ino,
          4
        )
      }))

    it.effect("should create only caller-written components when recursive traversal follows a dangling link", () =>
      Effect.gen(function*() {
        const { resolver, state, root } = setup()
        state.attach(root, "link", symlink(4, "missing"))
        let creations = 0

        const failure = yield* Effect.flip(resolver.resolve(Target.Path({ path: "/link/child" }), {
          kind: "Node",
          createMissing: (parent) =>
            Effect.sync(() => {
              creations++

              return parent
            })
        }, op))

        assert.strictEqual(failure.code, "NotFound")
        assert.strictEqual(creations, 0)
      }))
  })
})

describe("capability identity and lifetime", () => {
  const OpContext = Errors.OpContext

  const ROOT_INO = State.ROOT_INO

  const op = OpContext.make("stat")

  // SAFETY: registry tests use opaque identities only and never invoke handle operations.
  const fileToken = (): FileHandle => Object.freeze({ [FileHandleId]: true }) as FileHandle

  // SAFETY: registry tests use opaque identities only and never invoke handle operations.
  const directoryToken = (): DirectoryHandle => Object.freeze({ [DirectoryHandleId]: true }) as DirectoryHandle

  const immediate = (action: () => void) => Effect.sync(action)

  const setup = () => {
    const state = volumeState()
    const registry = Tokens.make(Symbol(), state.get)

    return { state, registry }
  }

  describe("token resolution", () => {
    it.effect("should preserve reference identity and origin checks when tokens are reused or forged", () =>
      Effect.gen(function*() {
        const { registry } = setup()
        const foreign = setup().registry
        const root = registry.referenceFor(ROOT_INO)
        assert.strictEqual(registry.referenceFor(ROOT_INO), root)
        assert.strictEqual((yield* registry.resolve(root, "reference")).kind, "live")
        assert.strictEqual((yield* foreign.resolve(root, "reference")).kind, "foreign")

        for (const forged of [undefined, null, 1, "token", {}, { ...root }]) {
          assert.strictEqual(
            (yield* registry.resolve(
              // SAFETY: malformed values exercise calls from outside TypeScript at the token boundary.
              forged as Tokens.Token,
              "reference"
            )).kind,
            "unknown"
          )
        }
      }))

    it.effect("should stale the reference and retain the handle when a directory is unlinked", () =>
      Effect.gen(function*() {
        const { state, registry } = setup()
        const node = directory(2)
        state.put(node)
        const token = registry.referenceFor(node.ino)
        const handle = directoryToken()
        registry.registerDirectory(handle, registry.directory(node.ino))
        state.put({ ...node, metadata: { ...node.metadata, nlink: 0 } })
        assert.strictEqual((yield* registry.resolve(token, "reference")).kind, "stale")
        assert.strictEqual((yield* registry.resolve(handle, "handle")).kind, "live")
        state.remove(node.ino)
        assert.strictEqual((yield* registry.resolve(handle, "handle")).kind, "stale")
      }))

    it.effect("should retain an unlinked file reference when a handle still owns its inode", () =>
      Effect.gen(function*() {
        const { state, registry } = setup()
        const node = file(2, 0)
        state.put(node)
        yield* state.retain(node.ino)
        const token = registry.referenceFor(node.ino)
        assert.strictEqual((yield* registry.resolve(token, "reference")).kind, "live")
        yield* state.release(node.ino)
        assert.strictEqual((yield* registry.resolve(token, "reference")).kind, "stale")
        assert.strictEqual((yield* registry.resolveInode(node.ino)).kind, "stale")
        assert.strictEqual((yield* setup().registry.resolve(token, "reference")).kind, "foreign")
      }))

    it.effect("should keep a reclaimed inode stale when its reference identity is forgotten", () =>
      Effect.gen(function*() {
        const { state, registry } = setup()
        const node = file(2)
        state.put(node)
        const token = registry.referenceFor(node.ino)
        state.remove(node.ino)
        registry.forget(node.ino)
        assert.strictEqual((yield* registry.resolve(token, "reference")).kind, "stale")
        assert.notStrictEqual(registry.referenceFor(node.ino), token)
      }))

    it.effect("should enforce handle kind and origin when resolving an open capability", () =>
      Effect.gen(function*() {
        const { state, registry } = setup()
        const node = file(2)
        state.put(node)
        const ref = registry.file("read", false)
        const handle = fileToken()
        registry.registerFile(handle, ref)
        assert.strictEqual((yield* registry.resolve(handle, "handle")).kind, "stale")
        Tokens.publish(ref, node.ino)
        assert.strictEqual((yield* registry.resolve(handle, "handle")).kind, "live")
        assert.strictEqual((yield* registry.resolve(handle, "directory")).kind, "unknown")
        assert.strictEqual((yield* setup().registry.resolve(handle, "handle")).kind, "foreign")
        Tokens.released(ref)
        assert.strictEqual((yield* registry.resolve(handle, "handle")).kind, "stale")
        assert.strictEqual((yield* setup().registry.resolve(handle, "handle")).kind, "foreign")
      }))

    it.effect("should return addressing-specific failures when tokens are unknown, foreign or stale", () =>
      Effect.gen(function*() {
        for (const kind of ["unknown", "foreign", "stale"] as const) {
          const reference = yield* Effect.flip(Tokens.nodeOrFail({ kind }, "reference", op))
          const handle = yield* Effect.flip(Tokens.nodeOrFail({ kind }, "handle", op))
          assert.strictEqual(
            reference.code,
            kind === "unknown" ? "InvalidReference" : kind === "foreign" ? "ForeignReference" : "StaleReference"
          )
          assert.strictEqual(handle.code, kind === "foreign" ? "ForeignHandle" : "InvalidHandle")
          assert.strictEqual(reference.operation, "stat")
          assert.isUndefined(reference.path)
        }
      }))
  })

  describe("handle lifecycle", () => {
    it.effect("should keep a handle usable when release is staged but not installed", () =>
      Effect.gen(function*() {
        const { state, registry } = setup()
        const node = file(2)
        state.put(node)
        yield* state.retain(node.ino)
        const ref = registry.file("read", false)
        Tokens.publish(ref, node.ino)
        const handle = fileToken()
        registry.registerFile(handle, ref)
        const actions: Array<() => void> = []
        yield* Tokens.release(ref, state.release, (action) =>
          Effect.sync(() => {
            actions.push(action)
          }))
        assert.strictEqual((yield* registry.resolve(handle, "handle")).kind, "live")
        actions.forEach((action) => action())
        assert.strictEqual((yield* registry.resolve(handle, "handle")).kind, "stale")
        assert.isFalse(state.state.open.has(node.ino))
      }))

    it.effect("should release an unlinked inode once when explicit close precedes repeated finalization", () =>
      Effect.gen(function*() {
        const { state, registry } = setup()
        const node = file(2, 0)
        state.put(node)
        yield* state.retain(node.ino)
        const ref = registry.file("write", false)
        Tokens.publish(ref, node.ino)
        let releases = 0

        const release = Tokens.release(ref, (ino) =>
          Effect.andThen(
            Effect.sync(() => {
              releases++
            }),
            state.release(ino)
          ), immediate)

        yield* release
        const finalize = Tokens.finalize(ref, release, release)
        yield* finalize
        yield* finalize
        assert.strictEqual(releases, 1)
        assert.strictEqual(ref.lifecycle.kind, "closed")
        assert.strictEqual((yield* registry.resolveInode(node.ino)).kind, "stale")
      }))

    it.effect("should release late publication when acquisition cleanup has already run", () =>
      Effect.gen(function*() {
        const { state, registry } = setup()
        const node = file(2, 0)
        state.put(node)
        const ref = registry.file("read", false)
        const release = Tokens.release(ref, state.release, immediate)
        const finalize = Tokens.finalize(ref, release, release)
        yield* finalize
        yield* finalize
        assert.strictEqual(ref.lifecycle.kind, "releasedPendingCommit")
        yield* state.retain(node.ino)
        Tokens.publish(ref, node.ino)
        assert.isFalse(Tokens.isOpen(ref))
        yield* finalize
        assert.strictEqual(ref.lifecycle.kind, "closed")
        assert.strictEqual((yield* registry.resolveInode(node.ino)).kind, "stale")
      }))

    it.effect("should fall back to local release when close is refused", () =>
      Effect.gen(function*() {
        const { state, registry } = setup()
        const node = file(2, 0)
        state.put(node)
        yield* state.retain(node.ino)
        const ref = registry.file("read", false)
        Tokens.publish(ref, node.ino)
        yield* Tokens.finalize(ref, Effect.fail(op.fail("VolumeBusy")), Tokens.release(ref, state.release, immediate))
        assert.strictEqual(ref.lifecycle.kind, "closed")
        assert.strictEqual((yield* registry.resolveInode(node.ino)).kind, "stale")
      }))

    it.effect("should close a released directory when its reclamation callback fails", () =>
      Effect.gen(function*() {
        const { registry } = setup()
        const ref = registry.directory(ROOT_INO)

        const failure = yield* Effect.flip(
          Tokens.release(ref, () => Effect.fail(op.fail("StorageRejected")), immediate)
        )

        assert.strictEqual(failure.code, "StorageRejected")
        assert.isFalse(Tokens.isOpen(ref))
        assert.isUndefined(Tokens.inode(ref))
      }))

    it.effect("should release a successful acquisition when its owning scope closes", () =>
      Effect.gen(function*() {
        const { state, registry } = setup()
        const node = file(2, 0)
        state.put(node)
        const ref = registry.file("read", false)
        const scope = yield* Scope.make()
        const release = Tokens.release(ref, state.release, immediate)

        const acquisition = Effect.gen(function*() {
          yield* state.retain(node.ino)
          Tokens.publish(ref, node.ino)

          return ref
        })

        yield* Tokens.acquire(
          ref,
          (effect) => effect,
          acquisition,
          () => Effect.void,
          Tokens.finalize(ref, release, release)
        ).pipe(Scope.provide(scope))
        assert.isTrue(Tokens.isOpen(ref))
        yield* Scope.close(scope, Exit.void)
        assert.strictEqual(ref.lifecycle.kind, "closed")
        assert.strictEqual((yield* registry.resolveInode(node.ino)).kind, "stale")
      }))

    it.effect("should interrupt acquisition when its scope closes while coordination waits", () =>
      Effect.gen(function*() {
        const { registry } = setup()
        const ref = registry.file("read", false)
        const scope = yield* Scope.make()
        const waiting = yield* Deferred.make<void>()
        const blocked = yield* Deferred.make<void>()
        const release = Tokens.release(ref, () => Effect.void, immediate)

        const acquisition = Tokens.acquire(
          ref,
          (effect) =>
            Effect.andThen(Deferred.succeed(waiting, undefined), Effect.andThen(Deferred.await(blocked), effect)),
          Effect.sync(() => Tokens.publish(ref, ROOT_INO)),
          () => Effect.void,
          Tokens.finalize(ref, release, release)
        )

        const fiber = yield* acquisition.pipe(Scope.provide(scope), Effect.forkChild)
        yield* Deferred.await(waiting)
        yield* Scope.close(scope, Exit.void)
        yield* Deferred.succeed(blocked, undefined)
        const exit = yield* Fiber.await(fiber)
        assert.isTrue(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause))
        assert.strictEqual(ref.lifecycle.kind, "closed")
      }))
  })
})

describe("persistent inode ownership", () => {
  const { emptyState, getNode, setNode } = State

  describe("inode state ownership", () => {
    it("should preserve earlier state when an inode is replaced and removed", () => {
      const first = emptyState(0n)
      const node = file(2)
      const second = { ...first, inodes: setNode(first.inodes, node) }
      const third = { ...second, inodes: HashMap.remove(second.inodes, node.ino) }
      assert.isUndefined(getNode(first, node.ino))
      assert.strictEqual(getNode(second, node.ino), node)
      assert.isUndefined(getNode(third, node.ino))
    })

    it("should replace metadata without inspecting payloads when a private inode is stored", () => {
      const first = emptyState(0n)
      const original = file(2)
      const updated = { ...file(2), metadata: { ...original.metadata, mode: 0o600 } }

      for (const node of [original, updated]) {
        Object.defineProperty(node, "data", {
          get: () => {
            throw new Error("Metadata replacement must not inspect payloads")
          },
          enumerable: true
        })
      }

      const second = { ...first, inodes: setNode(first.inodes, original) }
      const third = { ...second, inodes: setNode(second.inodes, updated) }
      assert.strictEqual(getNode(second, original.ino)?.metadata.mode, 0o644)
      assert.strictEqual(getNode(third, updated.ino)?.metadata.mode, 0o600)
    })
  })
})
