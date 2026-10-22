/* eslint-disable effecttsgo/async-function */
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import assert from "node:assert/strict"
import { test } from "node:test"
import { makeCoordinator } from "../src/workbench/coordinator.ts"
import type { Command, View } from "../src/workbench/domain.ts"

void test(
  "should emit and check both source files when a static import becomes require",
  { timeout: 120000 },
  async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const coordinator = yield* makeCoordinator()

      let state: View = yield* coordinator.command({
        action: "view",
        generation: 0,
        revision: 0,
        edits: [],
        role: "compiler"
      })

      const command = (action: Command["action"], edits: Command["edits"] = []) =>
        coordinator.command({ action, generation: state.generation, revision: state.revision, edits, role: "compiler" })
          .pipe(Effect.tap((next) =>
            Effect.sync(() => {
              state = next
            })
          ))

      state = yield* command("compileRun", [{
        path: "/src/format.ts",
        text: "export const summarize = (items: string[]) => \"OLD\";\n"
      }])
      assert.equal(state.build?.status, "success")
      assert.match(state.output.map((item) => item.text).join(""), /OLD/)
      state = yield* command("compileRun", [
        { path: "/src/index.ts", text: "const { summarize } = require(\"./format\"); console.log(summarize([]));\n" },
        { path: "/src/format.ts", text: "export const summarize = (items: string[]) => \"NEW\";\n" }
      ])
      assert.equal(state.build?.status, "success")
      assert.match(state.output.map((item) => item.text).join(""), /NEW/)
      assert.match(state.files.find((file) => file.path === "/dist/format.js")!.text, /NEW/)
      state = yield* command("compile", [{
        path: "/src/format.ts",
        text: "export const summarize = (items: string[]): string => 42;\n"
      }])
      assert.equal(state.build?.status, "failed")
      assert.ok(state.build.diagnostics.some((item) => item.code === 2322 && item.file === "/src/format.ts"))
      assert.ok(Exit.isFailure(yield* Effect.exit(command("run"))))
    })))
  }
)
