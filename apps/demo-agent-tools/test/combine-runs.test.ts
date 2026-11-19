import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { assert, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { codeModeHandlers } from "../src/codemode.js"
import { makeBaseSnapshot, projectRoot } from "../src/workspace.js"

const original = "# Release plan\n\nRelease on Friday.\n"

const edited = "Tests pass. Rollback ready."

const renameProgram = (to: string) => ({
  code: `return await tools.workspace.rename({ from: "plans/draft.md", to: ${JSON.stringify(to)} })`
})

const editProgram = {
  code: `return await tools.workspace.write_file({ path: "plans/draft.md", content: ${JSON.stringify(edited)} })`
}

const appliedFiles = Effect.fnUntraced(function*(base: Vfs.Snapshot, json: string) {
  const delta = yield* Schema.decodeEffect(Vfs.SnapshotDeltaFromBytes())(new TextEncoder().encode(json))
  const snapshot = yield* Vfs.applySnapshotDelta(base, delta)
  const volume = yield* Vfs.fromSnapshot(snapshot)
  const caller = yield* (yield* volume.caller()).withRoot(projectRoot)
  const listing = yield* caller.readDirectory("plans")

  return yield* Effect.forEach(
    listing.value,
    Effect.fnUntraced(function*(entry) {
      const name = new TextDecoder().decode(entry.name)
      const bytes = yield* caller.readFile("plans/" + name)

      return [name, new TextDecoder().decode(bytes)] as const
    })
  )
})

it.layer(BunCrypto.layer)((it) => {
  it.effect("should keep the source until one choice resolves the whole divergent rename", () =>
    Effect.gen(function*() {
      const base = yield* makeBaseSnapshot(true)
      const handlers = yield* codeModeHandlers
      const oursPath = "plans/a.md"
      const theirsPath = "plans/b.md"
      const ours = yield* handlers.execute(renameProgram(oursPath))
      const theirs = yield* handlers.execute(renameProgram(theirsPath))
      const request = { ours: ours.runId, theirs: theirs.runId }
      const unresolved = yield* handlers.combine_runs(request)

      if (unresolved.status !== "preview") throw new Error("Expected a conflict preview")

      assert.lengthOf(unresolved.conflicts, 1)
      const conflict = unresolved.conflicts[0]!

      if (conflict.kind !== "rename") throw new Error("Expected a rename conflict")

      assert.strictEqual(conflict.ours, projectRoot + "/" + oursPath)
      assert.strictEqual(conflict.theirs, projectRoot + "/" + theirsPath)
      assert.deepStrictEqual(yield* appliedFiles(base, unresolved.previewDelta), [["draft.md", original]])

      const options = [["ours", "a.md"], ["theirs", "b.md"], ["base", "draft.md"]] as const

      for (const [take, name] of options) {
        const resolved = yield* handlers.combine_runs({ ...request, resolutions: [{ key: conflict.key, take }] })

        if (resolved.status !== "ready") throw new Error("Expected a ready handoff")

        assert.deepStrictEqual(yield* appliedFiles(base, resolved.delta), [[name, original]])
      }

      assert.deepStrictEqual(
        (yield* handlers.inspect_run({ runId: ours.runId, action: "list", path: "plans" })).entry,
        { path: "plans", entries: [{ name: "a.md", kind: "file" }] }
      )
      assert.deepStrictEqual(
        (yield* handlers.inspect_run({ runId: theirs.runId, action: "list", path: "plans" })).entry,
        { path: "plans", entries: [{ name: "b.md", kind: "file" }] }
      )
    }))

  it.effect("should reject a rename onto an existing file when combining retained runs", () =>
    Effect.gen(function*() {
      const handlers = yield* codeModeHandlers
      const replaced = yield* handlers.execute(renameProgram("BRIEF.md"))
      const editedRun = yield* handlers.execute(editProgram)
      const failure = yield* handlers.combine_runs({ ours: replaced.runId, theirs: editedRun.runId }).pipe(Effect.flip)

      assert.strictEqual(failure.code, "InvalidStructure")
      assert.deepStrictEqual(
        (yield* handlers.inspect_run({ runId: replaced.runId, action: "read", path: "BRIEF.md" })).entry,
        { path: "BRIEF.md", content: original }
      )
    }))
})
