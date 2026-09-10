import { assert, describe, it } from "@effect/vitest"
import {
  compareOverlay,
  type ObservationEntry,
  type ObservationMetadata,
  type RawOverlayChange
} from "../src/internal/overlayChanges.js"

const encoder = new TextEncoder()
const path = (value: string): Uint8Array => encoder.encode(value)
const content = (value: string): Uint8Array => encoder.encode(value)
const metadata = (overrides: Partial<ObservationMetadata> = {}): ObservationMetadata => ({
  uid: 0,
  gid: 0,
  mode: 0o644,
  atimeNs: "1",
  mtimeNs: "2",
  ctimeNs: "3",
  birthtimeNs: "4",
  ...overrides
})
const entry = (
  name: string | Uint8Array,
  lineage: string | undefined,
  overrides: Partial<Omit<ObservationEntry, "path" | "lineage">> = {}
): ObservationEntry => ({
  path: typeof name === "string" ? path(name) : name,
  lineage,
  kind: "file",
  content: content("same"),
  metadata: metadata(),
  ...overrides
})
const printable = (changes: ReadonlyArray<RawOverlayChange>) =>
  changes.map((change) => {
    switch (change._tag) {
      case "Added":
      case "Removed":
        return { ...change, path: [...change.path] }
      case "Replaced":
      case "Updated":
        return { ...change, path: [...change.path], differences: [...change.differences] }
      case "Renamed":
        return { ...change, from: [...change.from], to: [...change.to], differences: [...change.differences] }
    }
  })

describe("overlay comparison", () => {
  it("should report same-path replacement by identity even when bytes and kind are equal", () => {
    assert.deepStrictEqual(printable(compareOverlay([entry("/x", "old")], [entry("/x", "new")])), [{
      _tag: "Replaced",
      path: [...path("/x")],
      beforeKind: "file",
      afterKind: "file",
      differences: []
    }])
  })

  it("should report an occupied rename and removal of the displaced destination", () => {
    const changes = compareOverlay(
      [entry("/from", "moving"), entry("/to", "displaced")],
      [entry("/to", "moving")]
    )
    assert.deepStrictEqual(printable(changes), [
      { _tag: "Renamed", from: [...path("/from")], to: [...path("/to")], kind: "file", differences: [] },
      { _tag: "Removed", path: [...path("/to")], kind: "file" }
    ])
  })

  it("should report both retained identities when their names swap", () => {
    assert.deepStrictEqual(
      printable(compareOverlay(
        [entry("/a", "one"), entry("/b", "two")],
        [entry("/a", "two"), entry("/b", "one")]
      )),
      [
        { _tag: "Renamed", from: [...path("/a")], to: [...path("/b")], kind: "file", differences: [] },
        { _tag: "Renamed", from: [...path("/b")], to: [...path("/a")], kind: "file", differences: [] }
      ]
    )
  })

  it("should expose an unambiguous alias rename while preserving its surviving name", () => {
    assert.deepStrictEqual(
      printable(compareOverlay(
        [entry("/a", "shared"), entry("/b", "shared")],
        [entry("/a", "shared"), entry("/c", "shared")]
      )),
      [
        { _tag: "Renamed", from: [...path("/b")], to: [...path("/c")], kind: "file", differences: [] }
      ]
    )
  })

  it("should leave ambiguous alias changes as additions and removals", () => {
    assert.deepStrictEqual(
      printable(compareOverlay(
        [entry("/a", "shared"), entry("/b", "shared")],
        [entry("/c", "shared"), entry("/d", "shared")]
      )),
      [
        { _tag: "Removed", path: [...path("/a")], kind: "file" },
        { _tag: "Removed", path: [...path("/b")], kind: "file" },
        { _tag: "Added", path: [...path("/c")], kind: "file" },
        { _tag: "Added", path: [...path("/d")], kind: "file" }
      ]
    )
  })

  it("should not infer a rename from equal contents without retained identity", () => {
    assert.deepStrictEqual(printable(compareOverlay([entry("/a", "old")], [entry("/b", "new")])), [
      { _tag: "Removed", path: [...path("/a")], kind: "file" },
      { _tag: "Added", path: [...path("/b")], kind: "file" }
    ])
  })

  it("should report a one-sided retained-lineage path delta without pairing a rename", () => {
    assert.deepStrictEqual(
      printable(compareOverlay(
        [entry("/a", "shared")],
        [entry("/a", "shared"), entry("/b", "shared")]
      )),
      [
        { _tag: "Added", path: [...path("/b")], kind: "file" }
      ]
    )
    assert.deepStrictEqual(
      printable(compareOverlay(
        [entry("/a", "shared"), entry("/b", "shared")],
        [entry("/a", "shared")]
      )),
      [
        { _tag: "Removed", path: [...path("/b")], kind: "file" }
      ]
    )
  })

  it("should omit a content edit that was reverted before comparison", () => {
    assert.deepStrictEqual(compareOverlay([entry("/a", "same")], [entry("/a", "same")]), [])
  })

  it("should detect a same-sized content change on a retained identity", () => {
    assert.deepStrictEqual(
      printable(compareOverlay(
        [entry("/a", "same", { content: content("AAAA") })],
        [entry("/a", "same", { content: content("BBBB") })]
      )),
      [{ _tag: "Updated", path: [...path("/a")], kind: "file", differences: ["content"] }]
    )
  })

  it("should report a new occupant at a rename source as an addition", () => {
    assert.deepStrictEqual(
      printable(compareOverlay(
        [entry("/a", "moving")],
        [entry("/a", undefined), entry("/b", "moving")]
      )),
      [
        { _tag: "Added", path: [...path("/a")], kind: "file" },
        { _tag: "Renamed", from: [...path("/a")], to: [...path("/b")], kind: "file", differences: [] }
      ]
    )
  })

  it("should hide timestamps by default and include them in fixed order on request", () => {
    const before = entry("/a", "same")
    const after = entry("/a", "same", { metadata: metadata({ mode: 0o600, atimeNs: "9", ctimeNs: "10" }) })
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
        [entry("/a", "same", { metadata: metadata({ atimeNs: "9" }) })]
      ),
      []
    )
  })

  it("should sort unsigned raw paths bytewise with prefixes first", () => {
    const slash = 47
    const changes = compareOverlay([], [
      entry(new Uint8Array([slash, 255]), "high"),
      entry(new Uint8Array([slash, 1, 0]), "long"),
      entry(new Uint8Array([slash, 1]), "short")
    ])
    assert.deepStrictEqual(printable(changes).map((change) => "path" in change ? change.path : []), [
      [slash, 1],
      [slash, 1, 0],
      [slash, 255]
    ])
  })

  it("should report directory descendants as separate final-state entries", () => {
    const directory = entry("/dir", "dir", {
      kind: "directory",
      content: undefined,
      metadata: metadata({ mode: 0o755 })
    })
    assert.deepStrictEqual(printable(compareOverlay([], [directory, entry("/dir/file", "file")])), [
      { _tag: "Added", path: [...path("/dir")], kind: "directory" },
      { _tag: "Added", path: [...path("/dir/file")], kind: "file" }
    ])
  })

  it("should return frozen records backed by copied paths", () => {
    const inputPath = path("/a")
    const changes = compareOverlay([], [entry(inputPath, "a")])
    inputPath[1] = 98
    assert.deepStrictEqual(printable(changes), [{ _tag: "Added", path: [...path("/a")], kind: "file" }])
    assert.isTrue(Object.isFrozen(changes))
    assert.isTrue(Object.isFrozen(changes[0]!))
  })
})
