import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Effect } from "effect"
import type { Identity } from "../../src/Caller.js"
import { DirectoryHandleId } from "../../src/FileHandle.js"
import { OpContext } from "../../src/internal/errors.js"
import * as Resolution from "../../src/internal/resolution.js"
import * as Tokens from "../../src/internal/tokenRegistry.js"
import { getNode, ROOT_INO } from "../../src/internal/volumeState.js"
import { Target } from "../../src/Target.js"
import type { DirectoryHandle, EntryInput } from "../../src/VirtualFileSystem.js"
import { pathText } from "../support/text.js"
import { directory, file, name, symlink, volumeState } from "../support/volumeState.js"

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
  it.effect("should distinguish a root node from a named node and preserve the caller's error path", () =>
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

  it.effect("should resolve references and handles without adding a path to failures", () =>
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

  it.effect("should ignore a foreign base for absolute paths and validate it for relative paths", () =>
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

  it.effect("should allow observing a detached directory handle but refuse traversal from it", () =>
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

  it.effect("should check search permission before revealing whether a child exists", () =>
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

  it.effect("should prepare malformed paths before checking a closed caller", () =>
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

  it.effect("should let a target override the final symlink default unless the verb fixes it", () =>
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

  it.effect("should follow a final link for a trailing slash and reject a slashed regular file", () =>
    Effect.gen(function*() {
      const { resolver, state, root, folder } = setup()
      state.attach(root, "link", symlink(4, "/folder"))
      assert.strictEqual(
        (yield* resolver.resolve(Target.Path({ path: "/link/", followFinalSymlink: false }), { kind: "Node" }, op)).node
          .ino,
        folder.ino
      )
      assert.strictEqual(
        (yield* Effect.flip(resolver.resolve(Target.Path({ path: "/folder/file/" }), { kind: "Node" }, op))).code,
        "NotDirectory"
      )
    }))

  it.effect("should bound symlink traversal and report expansion limits at the original path", () =>
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
  it.effect("should resolve the parent without following or requiring the final child", () =>
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

  it.effect("should tag an existing entry and a missing entry with their mutation directory", () =>
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

  it.effect("should preserve root and trailing-slash information for creation policy", () =>
    Effect.gen(function*() {
      const { resolver, prepare } = setup()
      const mode: Resolution.OrCreateMode = { kind: "OrCreate", create: "ifMissing", finalSymlink: "follow" }
      assert.strictEqual((yield* Effect.flip(resolver.resolve(yield* prepare("/"), mode, op))).code, "IsDirectory")
      const missing = yield* resolver.resolve(yield* prepare("/new/"), mode, op)
      assert.strictEqual(missing.kind, "missing")
      assert.isTrue(missing.trailingSlash)
    }))

  it.effect("should refuse an exclusive path before following its dangling symlink", () =>
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

  it.effect("should retain the direct entry separately when a symlink resolves to an existing file", () =>
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

  it.effect("should run a conditional entry guard before exclusivity and symlink traversal", () =>
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

  it.effect("should preserve the different exclusive-entry ordering used by open and writeFile", () =>
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

  it.effect("should report a followed directory link before writeFile's exclusive-entry refusal", () =>
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

  it.effect("should preserve a final symlink for replacement and reject reserved entry names", () =>
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

  it.effect("should see directories created during traversal through the current node getter", () =>
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
