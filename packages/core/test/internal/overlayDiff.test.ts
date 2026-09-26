import { assert, describe, it } from "@effect/vitest"
import { Predicate, Schema } from "effect"
import type { StoredMetadata } from "../../src/internal/metadata.js"
import { compareOverlay, type ObservationEntry, type RawOverlayChange } from "../../src/internal/overlayDiff.js"

const encoder = new TextEncoder()

const path = (value: string): Uint8Array => encoder.encode(value)

const content = (value: string): Uint8Array => encoder.encode(value)

const metadata = (overrides: Partial<StoredMetadata> = {}): StoredMetadata => ({
  uid: 0,
  gid: 0,
  mode: 0o644,
  atimeNs: 1n,
  mtimeNs: 2n,
  ctimeNs: 3n,
  birthtimeNs: 4n,
  ...overrides
})

const entry = (
  name: string | Uint8Array,
  lineage: string | undefined,
  overrides: Partial<Omit<ObservationEntry, "path" | "lineage">> = {}
): ObservationEntry => ({
  path: Schema.is(Schema.String)(name) ? path(name) : name,
  lineage,
  kind: "file",
  content: content("same"),
  metadata: metadata(),
  ...overrides
})

const printable = (changes: ReadonlyArray<RawOverlayChange>) =>
  changes.map((change) => {
    if (Predicate.isTagged("Renamed")(change)) {
      return { ...change, from: [...change.from], to: [...change.to], differences: [...change.differences] }
    }

    if (Predicate.isTagged("Replaced")(change) || Predicate.isTagged("Updated")(change)) {
      return { ...change, path: [...change.path], differences: [...change.differences] }
    }

    return { ...change, path: [...change.path] }
  })

describe("overlay comparison", () => {
  it("should report a content difference when a retained file changes to equal-length bytes", () => {
    assert.deepStrictEqual(
      printable(compareOverlay(
        [entry("/a", "same", { content: content("AAAA") })],
        [entry("/a", "same", { content: content("BBBB") })]
      )),
      [{ _tag: "Updated", path: [...path("/a")], kind: "file", differences: ["content"] }]
    )
  })

  it("should include ctime in order when timestamp differences are requested", () => {
    const before = entry("/a", "same")
    const after = entry("/a", "same", { metadata: metadata({ mode: 0o600, atimeNs: 9n, ctimeNs: 10n }) })
    assert.deepStrictEqual(printable(compareOverlay([before], [after])), [{
      _tag: "Updated",
      path: [...path("/a")],
      kind: "file",
      differences: ["mode"]
    }])
    assert.deepStrictEqual(printable(compareOverlay([before], [after], true)), [{
      _tag: "Updated",
      path: [...path("/a")],
      kind: "file",
      differences: ["mode", "atimeNs", "ctimeNs"]
    }])
    assert.deepStrictEqual(
      compareOverlay(
        [before],
        [entry("/a", "same", { metadata: metadata({ atimeNs: 9n }) })]
      ),
      []
    )
  })

  it("should return copied paths and frozen records when comparison produces changes", () => {
    const inputPath = path("/a")
    const changes = compareOverlay([], [entry(inputPath, "a")])
    inputPath[1] = 98
    assert.deepStrictEqual(printable(changes), [{ _tag: "Added", path: [...path("/a")], kind: "file" }])
    assert.isTrue(Object.isFrozen(changes))
    assert.isTrue(Object.isFrozen(changes[0]))
  })
})
