import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { assert, it } from "@effect/vitest"
import { Effect, Encoding, Predicate, Schema } from "effect"
import * as ByteSize from "effect/ByteSize"
import { Testing, VirtualFileSystem as Vfs } from "../src/index.js"

const encoder = new TextEncoder()

const decoder = new TextDecoder()

interface StoredNode {
  _tag: string
  metadata?: object
  content?: { _tag: string; bytes: string }
  target?: string
  to?: string
}

interface StoredChange {
  _tag: string
  path: string
  kind?: string
  beforeKind?: string
  afterKind?: string
  differences?: Array<string>
  node?: StoredNode
}

interface StoredDocument {
  readonly base: string
  readonly target: string
  readonly version: number
  readonly changes: ReadonlyArray<StoredChange>
}

const snapshots = Effect.gen(function*() {
  const volume = yield* Vfs.Volume
  const caller = yield* Vfs.Caller
  const base = yield* volume.snapshot
  yield* caller.writeFile("/f", new Uint8Array([1, 2, 3]), { access: "write", create: "ifMissing" })
  const target = yield* volume.snapshot

  return { base, target }
}).pipe(Effect.provide(Testing.layer()))

const encodedDelta = Effect.gen(function*() {
  const pair = yield* snapshots
  const delta = yield* Vfs.diffSnapshots(pair.base, pair.target)
  const encoded = yield* Schema.encodeEffect(Vfs.SnapshotDeltaFromBytes())(delta)

  return { ...pair, encoded }
})

const document = (input: Uint8Array): StoredDocument => {
  // SAFETY: The helper only reads snapshots encoded by this package in the test setup.
  return JSON.parse(decoder.decode(input)) as StoredDocument
}

const encodeDocument = (value: typeof Schema.Unknown.Type): Uint8Array => encoder.encode(JSON.stringify(value))

const customLimits = (overrides: Partial<Vfs.SnapshotDeltaLimits>): Vfs.SnapshotDeltaLimits => ({
  ...Vfs.SnapshotDeltaLimits.default,
  ...overrides
})

const reject = (input: Uint8Array, limits = Vfs.SnapshotDeltaLimits.default) =>
  Effect.flip(Schema.decodeEffect(Vfs.SnapshotDeltaFromBytes(limits))(input))

it.layer(BunCrypto.layer)("snapshot delta Schema codec", (it) => {
  it.effect("round trips through the public Schema and owns decoded input and encoded output", () =>
    Effect.gen(function*() {
      const { base, encoded } = yield* encodedDelta
      const input = new Uint8Array(encoded)
      const delta = yield* Schema.decodeEffect(Vfs.SnapshotDeltaFromBytes())(input)
      input.fill(0)

      const first = yield* Schema.encodeEffect(Vfs.SnapshotDeltaFromBytes())(delta)
      const expected = new Uint8Array(first)
      first.fill(0)
      const second = yield* Schema.encodeEffect(Vfs.SnapshotDeltaFromBytes())(delta)

      assert.deepStrictEqual(second, expected)
      const restored = yield* Vfs.applySnapshotDelta(base, delta)
      const caller = yield* (yield* Vfs.fromSnapshot(restored)).caller()
      assert.deepStrictEqual(yield* caller.readFile("/f"), new Uint8Array([1, 2, 3]))
    }))

  it.effect("rejects malformed UTF-8, JSON, unknown fields, and unsupported versions", () =>
    Effect.gen(function*() {
      const { encoded } = yield* encodedDelta
      const source = document(encoded)

      const cases = [
        new Uint8Array([0xc3, 0x28]),
        encoder.encode("{"),
        encodeDocument({ ...source, unexpected: true }),
        encodeDocument({ ...source, changes: [{ ...source.changes[0], unexpected: true }] }),
        encodeDocument({ ...source, version: 2 })
      ]

      for (const input of cases) assert.isDefined(yield* reject(input))
    }))

  it.effect("rejects noncanonical base64, invalid digests, paths, and payloads", () =>
    Effect.gen(function*() {
      const { encoded } = yield* encodedDelta
      const source = document(encoded)
      const added = source.changes[0]!
      const node = added.node!

      const encodingCases = [
        [{ ...source, base: "A" }, "digest"],
        [{ ...source, target: "A" }, "digest"],
        [{ ...source, base: source.base.slice(4) }, "digest"],
        [{ ...source, changes: [{ ...added, path: "A" }] }, "changePath"],
        [{ ...source, changes: [{ ...added, node: { ...node, content: { _tag: "Inline", bytes: "A" } } }] }, "payload"],
        [{ ...source, changes: [{ ...added, node: { _tag: "link", to: "A" } }] }, "changes.0.node.to"]
      ] as const

      for (const [value, field] of encodingCases) {
        const error = yield* reject(encodeDocument(value))
        assert.instanceOf(error, Schema.SchemaError)
        assert.include(String(error), `Snapshot delta InvalidEncoding at ${field}`)
      }

      const structuralCases = [
        [{ ...source, target: `${source.target.slice(0, -2)}h==` }, "InvalidEncoding at digest"],
        [{ ...source, changes: [{ ...added, path: "Lg==" }] }, "InvalidStructure at changes"],
        // One byte past NAME_MAX, which the snapshot tree and fixtures refuse as well.
        [
          { ...source, changes: [{ ...added, path: Encoding.encodeBase64(`/${"a".repeat(256)}`) }] },
          "InvalidStructure at changes"
        ],
        [{ ...source, changes: [{ ...added, node: { ...node, _tag: "directory" } }] }, "changes.0.node"],
        [{ ...source, changes: [{ ...added, node: { ...node, content: undefined } }] }, "changes.0.node"],
        [
          {
            ...source,
            changes: [{
              ...added,
              kind: "symlink",
              node: { ...node, _tag: "symlink", content: undefined, target: "AA==" }
            }]
          },
          "changes.0.node.target"
        ],
        [
          { ...source, changes: [{ ...added, node: { ...node, content: { _tag: "Inline", bytes: "AQI" } } }] },
          "payload"
        ],
        [{ ...source, changes: [{ _tag: "Removed", path: "Lw==", kind: "directory" }] }, "changes.0"],
        [{ ...source, changes: [{ ...added, node: { _tag: "link", to: added.path } }] }, "changes.0.node.to"]
      ] as const

      for (const [value, site] of structuralCases) {
        assert.include(String(yield* reject(encodeDocument(value))), site)
      }
    }))

  it.effect("rejects updates whose differences are out of order, repeated, or misstate a kind change", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.Volume
      const caller = yield* Vfs.Caller
      yield* caller.writeFile("/f", new Uint8Array([1]), { access: "write", create: "ifMissing" })
      const base = yield* volume.snapshot
      yield* caller.writeFile("/f", new Uint8Array([2]), { access: "write", truncate: true })
      yield* caller.chmod("/f", 0o600)
      const target = yield* volume.snapshot
      const encoded = yield* Schema.encodeEffect(Vfs.SnapshotDeltaFromBytes())(yield* Vfs.diffSnapshots(base, target))
      const source = document(encoded)
      const updated = source.changes.find(Predicate.isTagged("Updated"))!
      assert.deepStrictEqual(updated.differences?.slice(0, 2), ["content", "mode"])
      const differences = updated.differences!

      for (
        const forged of [
          [...differences].reverse(),
          [differences[0]!, ...differences],
          ["kind", ...differences]
        ]
      ) {
        const changes = source.changes.map((change) => change === updated ? { ...change, differences: forged } : change)
        assert.include(String(yield* reject(encodeDocument({ ...source, changes }))), "differences")
      }
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("rejects unordered, duplicate, and semantically inconsistent summaries", () =>
    Effect.gen(function*() {
      const { base, encoded } = yield* encodedDelta
      const source = document(encoded)
      const added = source.changes[0]
      assert.isDefined(yield* reject(encodeDocument({ ...source, changes: [added, added] })))
      assert.isDefined(
        yield* reject(encodeDocument({
          ...source,
          changes: [
            { _tag: "Added", path: "L3o=", kind: "file" },
            { _tag: "Added", path: "L2E=", kind: "file" }
          ]
        }))
      )

      const inconsistent = yield* Schema.decodeEffect(Vfs.SnapshotDeltaFromBytes())(
        encodeDocument({ ...source, changes: [] })
      )

      const inspectionError = yield* Effect.flip(Vfs.inspectSnapshotDelta(base, inconsistent))
      assert.instanceOf(inspectionError, Vfs.VfsError)
      assert.strictEqual(inspectionError.code, "InvalidStructure")
      assert.strictEqual(inspectionError.field, "changes")
      const error = yield* Effect.flip(Vfs.applySnapshotDelta(base, inconsistent))
      assert.instanceOf(error, Vfs.VfsError)
      assert.strictEqual(error.code, "InvalidStructure")
      assert.strictEqual(error.field, "changes")
    }))

  it.effect("accepts a semantically identical summary with reordered object keys", () =>
    Effect.gen(function*() {
      const { base, encoded } = yield* encodedDelta
      const source = document(encoded)
      const change = source.changes[0]!
      const reordered = Object.fromEntries(Object.entries(change).reverse())

      const delta = yield* Schema.decodeEffect(Vfs.SnapshotDeltaFromBytes())(
        encodeDocument({ ...source, changes: [reordered] })
      )

      yield* Vfs.applySnapshotDelta(base, delta)
    }))

  it.effect("accepts exact codec boundaries and rejects the next smaller budget", () =>
    Effect.gen(function*() {
      const { encoded } = yield* encodedDelta
      const source = document(encoded)
      // Both digests, the path `/f` and its three payload bytes.
      const decodedBytes = 32 + 32 + 2 + 3

      const boundaries: ReadonlyArray<readonly [Vfs.SnapshotDeltaLimits, Vfs.SnapshotDeltaLimits]> = [
        [
          customLimits({ maxEncodedBytes: ByteSize.bytes(encoded.length) }),
          customLimits({ maxEncodedBytes: ByteSize.bytes(encoded.length - 1) })
        ],
        [
          customLimits({ maxDeltaRecords: source.changes.length }),
          customLimits({ maxDeltaRecords: source.changes.length - 1 })
        ],
        [
          customLimits({ maxDecodedDeltaBytes: ByteSize.bytes(decodedBytes) }),
          customLimits({ maxDecodedDeltaBytes: ByteSize.bytes(decodedBytes - 1) })
        ],
        [customLimits({ maxEntries: 1 }), customLimits({ maxEntries: 0 })],
        [customLimits({ maxOutputBytes: ByteSize.bytes(3) }), customLimits({ maxOutputBytes: ByteSize.bytes(2) })]
      ]

      for (const [accepted, rejected] of boundaries) {
        assert.isDefined(
          yield* Schema.decodeEffect(Vfs.SnapshotDeltaFromBytes(accepted))(encoded)
        )
        assert.isDefined(yield* reject(encoded, rejected))
      }
    }))

  it.effect("bounds the applied target's nodes at exactly the configured output records", () =>
    Effect.gen(function*() {
      const { base, encoded } = yield* encodedDelta
      const delta = yield* Schema.decodeEffect(Vfs.SnapshotDeltaFromBytes())(encoded)

      // The target holds the root and `/f`.
      yield* Vfs.applySnapshotDelta(base, delta, customLimits({ maxOutputRecords: 2 }))
      const error = yield* Effect.flip(Vfs.applySnapshotDelta(base, delta, customLimits({ maxOutputRecords: 1 })))
      assert.instanceOf(error, Vfs.VfsError)
      assert.deepStrictEqual([error.code, error.field], ["LimitExceeded", "outputRecords"])
    }))

  it.effect("preserves byte limits above Number.MAX_SAFE_INTEGER without narrowing", () =>
    Effect.gen(function*() {
      const { base, target } = yield* snapshots
      const exactLimit = ByteSize.bytes(BigInt(Number.MAX_SAFE_INTEGER) + 1n)

      const limits = customLimits({
        maxEncodedBytes: exactLimit,
        maxIdentityBytes: exactLimit,
        maxDecodedDeltaBytes: exactLimit,
        maxOutputBytes: exactLimit
      })

      const delta = yield* Vfs.diffSnapshots(base, target, limits)
      const codec = Vfs.SnapshotDeltaFromBytes(limits)
      const encoded = yield* Schema.encodeEffect(codec)(delta)
      const decoded = yield* Schema.decodeEffect(codec)(encoded)
      const restored = yield* Vfs.applySnapshotDelta(base, decoded, limits)
      const caller = yield* (yield* Vfs.fromSnapshot(restored)).caller()
      assert.deepStrictEqual(yield* caller.readFile("/f"), new Uint8Array([1, 2, 3]))
    }))

  it.effect("enforces inherited-record, delta-record, identity and target limits on inspection and apply", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.Volume
      const caller = yield* Vfs.Caller
      yield* caller.writeFile("/f", new Uint8Array([1]), { access: "write", create: "ifMissing" })
      const base = yield* volume.snapshot
      const unchanged = yield* Vfs.diffSnapshots(base, base)

      // An unchanged delta carries no node, so the target inherits the root and `/f` from the base.
      yield* Vfs.applySnapshotDelta(base, unchanged, customLimits({ maxInheritedRecords: 2 }))
      yield* caller.writeFile("/g", new Uint8Array([2]), { access: "write", create: "exclusive" })
      const grown = yield* Vfs.diffSnapshots(base, yield* volume.snapshot)

      for (
        const [delta, limits, field] of [
          [unchanged, customLimits({ maxInheritedRecords: 1 }), "inheritedRecords"],
          [grown, customLimits({ maxDeltaRecords: 0 }), "deltaRecords"],
          [unchanged, customLimits({ maxIdentityBytes: ByteSize.zero }), "identityBytes"],
          // The target holds the root, `/f` and `/g`: three records and two names, as a diff under these limits
          // would also refuse.
          [grown, customLimits({ maxTargetRecords: 2 }), "targetRecords"],
          [grown, customLimits({ maxEntries: 1 }), "entries"]
        ] as const
      ) {
        const errors = [
          yield* Effect.flip(Vfs.applySnapshotDelta(base, delta, limits)),
          yield* Effect.flip(Vfs.inspectSnapshotDelta(base, delta, undefined, limits))
        ]

        for (const error of errors) {
          assert.instanceOf(error, Vfs.VfsError)
          assert.deepStrictEqual([error.code, error.field], ["LimitExceeded", field])
        }
      }
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("rejects a hard link redirected to a path that carries no node", () =>
    Effect.gen(function*() {
      const empty = yield* (yield* Vfs.fromFixture({ entries: [] })).snapshot

      const linked = yield* Vfs.fromFixture({
        entries: [
          { kind: "file", path: "/a", bytes: new Uint8Array([1]) },
          { kind: "hardLink", path: "/b", target: "/a" },
          { kind: "file", path: "/c", bytes: new Uint8Array([1]) }
        ]
      })

      const delta = yield* Vfs.diffSnapshots(empty, yield* linked.snapshot)
      const source = document(yield* Schema.encodeEffect(Vfs.SnapshotDeltaFromBytes())(delta))
      const link = source.changes.find((change) => change.node?._tag === "link")
      assert.deepStrictEqual(link?.node, { _tag: "link", to: "L2E=" })

      // `/c` comes after `/b`, and `/b` is itself a link: neither is an earlier change's node.
      for (const to of ["L2M=", "L2I=", "L3o="]) {
        const changes = source.changes.map((change) =>
          change === link ? { ...change, node: { _tag: "link", to } } : change
        )

        const error = yield* reject(encodeDocument({ ...source, changes }))
        assert.instanceOf(error, Schema.SchemaError)
        assert.include(String(error), "InvalidStructure at changes.1.node.to")
      }
    }))

  it.effect("rejects on apply a change the base or the target does not bear out", () =>
    Effect.gen(function*() {
      const base = yield* (yield* Vfs.fromFixture({
        entries: [
          { kind: "directory", path: "/d" },
          { kind: "file", path: "/d/a", bytes: new Uint8Array([1]) },
          { kind: "hardLink", path: "/b", target: "/d/a" },
          { kind: "file", path: "/f", bytes: new Uint8Array([2]) }
        ]
      })).snapshot

      const target = yield* (yield* Vfs.fromFixture({
        entries: [
          { kind: "directory", path: "/d" },
          { kind: "file", path: "/d/a", bytes: new Uint8Array([1]) },
          { kind: "hardLink", path: "/b", target: "/d/a" },
          { kind: "file", path: "/f", bytes: new Uint8Array([3]), metadata: { mode: 0o600 } },
          { kind: "file", path: "/g", bytes: new Uint8Array([4]) }
        ]
      })).snapshot

      const encoded = yield* Schema.encodeEffect(Vfs.SnapshotDeltaFromBytes())(yield* Vfs.diffSnapshots(base, target))
      const source = document(encoded)
      const [updated, added] = source.changes
      assert.deepStrictEqual([updated?.path, updated?.differences, added?.path], ["L2Y=", ["content", "mode"], "L2c="])
      const file = { _tag: "file", metadata: added!.node!.metadata!, content: { _tag: "Inline", bytes: "BA==" } }

      // A change the base does not bear out names itself; only a target identity the changes miss names `changes`.
      const cases: ReadonlyArray<readonly [string, ReadonlyArray<StoredChange>, string]> = [
        ["forged differences", [{ ...updated!, differences: ["content"] }, added!], "changes.0.differences"],
        [
          "addition at an existing path",
          [{ _tag: "Added", path: "L2Y=", kind: "file", node: updated!.node! }],
          "changes.0"
        ],
        ["removal of a missing path", [updated!, added!, { _tag: "Removed", path: "L3o=", kind: "file" }], "changes.2"],
        ["removal of the wrong kind", [{ _tag: "Removed", path: "L2Q=", kind: "file" }], "changes.0"],
        ["one name of a hard-linked node removed", [{ _tag: "Removed", path: "L2I=", kind: "file" }], "changes.0"],
        [
          "a directory removed without its entries",
          [{ _tag: "Removed", path: "L2Q=", kind: "directory" }],
          "changes.0"
        ],
        [
          "an addition under a missing directory",
          [{ _tag: "Added", path: "L3gvZw==", kind: "file", node: file }],
          "parent"
        ],
        ["a change missing from the summary", [updated!], "changes"]
      ]

      for (const [label, changes, field] of cases) {
        const delta = yield* Schema.decodeEffect(Vfs.SnapshotDeltaFromBytes())(encodeDocument({ ...source, changes }))
        const error = yield* Effect.flip(Vfs.applySnapshotDelta(base, delta))
        assert.instanceOf(error, Vfs.VfsError, label)
        assert.deepStrictEqual([error.code, error.field], ["InvalidStructure", field], label)
      }

      const forged = yield* Schema.decodeEffect(Vfs.SnapshotDeltaFromBytes())(
        encodeDocument({ ...source, target: source.base })
      )

      const error = yield* Effect.flip(Vfs.inspectSnapshotDelta(base, forged))
      assert.instanceOf(error, Vfs.VfsError)
      assert.deepStrictEqual([error.code, error.field], ["InvalidStructure", "changes"])
    }))

  it.effect("rejects a change the base does not bear out even when the target identity matches its intended result", () =>
    Effect.gen(function*() {
      const snapshotOf = (entries: Vfs.Fixture["entries"]) =>
        Effect.flatMap(Vfs.fromFixture({ entries }), (volume) => volume.snapshot)

      const cases = [
        [
          // Without the check, `/d/a` would stay behind unreachable and the applied snapshot would still diff equal.
          "a directory removed without its entries",
          [{ kind: "directory", path: "/d" }, { kind: "file", path: "/d/a", bytes: new Uint8Array([1]) }],
          [],
          { _tag: "Removed", path: "L2Q=", kind: "directory" }
        ],
        [
          "one name of a hard-linked node removed",
          [{ kind: "file", path: "/a", bytes: new Uint8Array([1]) }, { kind: "hardLink", path: "/b", target: "/a" }],
          [{ kind: "file", path: "/a", bytes: new Uint8Array([1]) }],
          { _tag: "Removed", path: "L2I=", kind: "file" }
        ]
      ] as const

      for (const [label, baseEntries, targetEntries, change] of cases) {
        const base = yield* snapshotOf(baseEntries)

        const source = document(
          yield* Schema.encodeEffect(Vfs.SnapshotDeltaFromBytes())(
            yield* Vfs.diffSnapshots(base, yield* snapshotOf(targetEntries))
          )
        )

        const delta = yield* Schema.decodeEffect(Vfs.SnapshotDeltaFromBytes())(
          encodeDocument({ ...source, changes: [change] })
        )

        const error = yield* Effect.flip(Vfs.applySnapshotDelta(base, delta))
        assert.instanceOf(error, Vfs.VfsError, label)
        assert.deepStrictEqual([error.code, error.field], ["InvalidStructure", "changes.0"], label)
      }
    }))
})
