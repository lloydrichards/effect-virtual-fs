// Native integration test: faults occur after actual routing removal, then the original method is restored.
/* eslint-disable effecttsgo/async-function, effecttsgo/node-builtin-import */
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { create, MemoryProvider, VirtualFileSystem as NativeVfs } from "node:vfs"
import { makeWorkspace } from "../src/workbench/workspace.ts"

void test("should reject a build when mount cleanup reports failure", { timeout: 120000 }, async () => {
  // SAFETY: Node 26.11.1 implements mount/unmount, which its type declarations omit.
  const sibling = create(new MemoryProvider()) as ReturnType<typeof create> & { mount(): string; unmount(): void }
  const parent = path.dirname(sibling.mount())
  const before = fs.readdirSync(parent)
  // SAFETY: The same pinned runtime exposes the public unmount method on this prototype.
  const prototype = NativeVfs.prototype as NativeVfs & { unmount(): void }
  // eslint-disable-next-line typescript/unbound-method
  const unmount = prototype.unmount

  try {
    await Effect.runPromise(Effect.gen(function*() {
      const workspace = yield* makeWorkspace
      const boot = yield* workspace.execute({ action: "boot", generation: 0, revision: 0, edits: [], role: "compiler" })

      const input = {
        generation: boot.view.generation,
        revision: boot.view.revision,
        edits: [],
        role: "compiler" as const
      }

      const first = yield* workspace.execute({ ...input, action: "compile" })
      assert.equal(first.view.build?.status, "success")
      assert.deepEqual(fs.readdirSync(parent), before)
      prototype.unmount = function() {
        unmount.call(this)
        throw new Error("injected unmount failure")
      }

      const failed = yield* workspace.execute({ ...input, action: "compile" })
      assert.equal(failed.view.build?.status, "failed")
      assert.ok(failed.view.build.diagnostics.some((item) => item.message.includes("injected unmount failure")))
      assert.deepEqual(fs.readdirSync(parent), before)
      assert.ok(Exit.isFailure(yield* Effect.exit(workspace.execute({ ...input, action: "run" }))))
    }))
  } finally {
    prototype.unmount = unmount
    sibling.unmount()
  }
})
