// Qualify the actual native worker protocol, compiler, checkpoint codec and timeout recovery.
/* eslint-disable effecttsgo/async-function */
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import assert from "node:assert/strict"
import { test } from "node:test"
import { makeCoordinator } from "../src/workbench/coordinator.ts"
import type { Command, View } from "../src/workbench/domain.ts"

void test("should compile, run and restore mounted files when workspace commands change source", {
  timeout: 180000
}, async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const coordinator = yield* makeCoordinator(300)

    let state: View = yield* coordinator.command({
      action: "view",
      generation: 0,
      revision: 0,
      edits: [],
      role: "compiler"
    })

    const command = (action: Command["action"], edits: Command["edits"] = [], role: Command["role"] = "compiler") =>
      coordinator.command({ action, generation: state.generation, revision: state.revision, edits, role }).pipe(
        Effect.tap((next) =>
          Effect.sync(() => {
            state = next
          })
        )
      )

    state = yield* command("compile")
    assert.equal(state.build?.status, "success", state.build?.diagnostics.map((item) => item.message).join("\n") ?? "")
    assert.ok(state.build.inputs > 60)
    state = yield* command("run")
    assert.match(state.output.map((item) => item.text).join(""), /1. Edit TypeScript/)
    state = yield* command("compileRun", [{
      path: "/src/format.ts",
      text: "export const summarize = (items: string[]) => \"CHANGED \" + items.length;\n"
    }])
    assert.match(state.output.map((item) => item.text).join(""), /CHANGED 3/)
    state = yield* command("save")
    assert.equal(state.checkpoint, 1)
    state = yield* command("compileRun", [{
      path: "/src/format.ts",
      text: "export const summarize = (items: string[]): string => 42;\n"
    }])
    assert.equal(state.build?.status, "failed")
    assert.ok(state.build.diagnostics.some((item) => item.code === 2322))
    const old = state
    state = yield* command("restore")
    assert.ok(state.generation > old.generation)
    assert.match(state.files.find((file) => file.path === "/src/format.ts")!.text, /CHANGED/)
    assert.equal(state.build, null)
    state = yield* command("compile", [], "viewer")
    assert.equal(state.build?.status, "failed")
    assert.ok(state.build.diagnostics.some((item) => /EACCES/.test(item.message)))
    state = yield* command("compileRun")
    assert.match(state.output.map((item) => item.text).join(""), /CHANGED 3/)
    state = yield* command("compileRun", [{ path: "/src/index.ts", text: "while (true) {}\n" }])
    assert.match(state.notice, /Run stopped/)
    assert.equal(state.build, null)
    assert.match(state.files.find((file) => file.path === "/src/format.ts")!.text, /CHANGED/)
    assert.doesNotMatch(state.files.find((file) => file.path === "/src/index.ts")!.text, /while/)
    state = yield* command("compileRun", [{
      path: "/src/index.ts",
      text: "console.error(\"error channel\"); console.log(\"x\".repeat(40000));\n"
    }])
    assert.ok(state.output.some((item) => item.channel === "stderr" && item.text.includes("error channel")))
    assert.equal(state.truncated, true)
    assert.ok(state.output.reduce((size, item) => size + item.text.length, 0) <= 32000)
    state = yield* command("compileRun", [{
      path: "/src/index.ts",
      text:
        "import { writeFileSync } from \"node:fs\"; import { join } from \"node:path\"; writeFileSync(join(__dirname, \"../src/format.ts\"), \"denied\");\n"
    }])
    assert.equal(state.runRevision, null)
    assert.match(state.output.map((item) => item.text).join(""), /EACCES/)
    assert.match(state.files.find((file) => file.path === "/src/format.ts")!.text, /CHANGED/)
    state = yield* command("compileRun", [{ path: "/src/index.ts", text: "throw new Error(\"x\".repeat(40000));\n" }])
    assert.equal(state.runRevision, null)
    assert.equal(state.truncated, true)
    assert.ok(state.output.reduce((size, item) => size + item.text.length, 0) <= 32000)

    const obsolete = state
    state = yield* command("restore")

    const stale = yield* Effect.exit(
      coordinator.command({
        action: "compile",
        generation: obsolete.generation,
        revision: obsolete.revision,
        edits: [],
        role: "compiler"
      })
    )

    assert.ok(Exit.isFailure(stale))

    const inFlight = yield* coordinator.command({
      action: "compileRun",
      generation: state.generation,
      revision: state.revision,
      edits: [{ path: "/src/index.ts", text: "while (true) {}\n" }],
      role: "compiler"
    }).pipe(Effect.forkChild)

    yield* Effect.sleep("100 millis")
    state = yield* command("stop")
    assert.match(state.notice, /Execution stopped/)
    assert.equal(state.build, null)
    const interrupted = yield* Fiber.await(inFlight)
    assert.ok(Exit.isFailure(interrupted))
    const refreshed = yield* command("view")
    assert.equal(refreshed.generation, state.generation)
    assert.doesNotMatch(refreshed.files.find((file) => file.path === "/src/index.ts")!.text, /while/)
    state = yield* command("reset")
    assert.equal(state.checkpoint, 0)
    assert.doesNotMatch(state.files.find((file) => file.path === "/src/format.ts")!.text, /CHANGED/)
  })))
})
