/* eslint-disable effecttsgo/async-function */
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Scope from "effect/Scope"
import assert from "node:assert/strict"
import { test } from "node:test"
import { makeCoordinator } from "../src/workbench/coordinator.ts"
import type { Command, View } from "../src/workbench/domain.ts"

const request = (state: View, action: Command["action"], edits: Command["edits"] = []): Command => ({
  action,
  generation: state.generation,
  revision: state.revision,
  edits,
  role: "compiler"
})

const initialRequest: Command = { action: "view", generation: 0, revision: 0, edits: [], role: "compiler" }

void test(
  "should retain current worker state when a compilation request disconnects",
  { timeout: 120000 },
  async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const coordinator = yield* makeCoordinator()
      const initial = yield* coordinator.command(initialRequest)

      const pending = yield* coordinator.command(
        request(initial, "compile", [{
          path: "/src/format.ts",
          text: "export const summarize = (items: string[]) => \"DISCONNECTED \" + items.length;\n"
        }])
      ).pipe(Effect.forkChild)

      yield* Effect.sleep("100 millis")
      yield* Fiber.interrupt(pending)
      const state = yield* coordinator.command(initialRequest)
      assert.equal(state.revision, 1)
      assert.equal(state.build?.status, "success")
      const ran = yield* coordinator.command(request(state, "run"))
      assert.match(ran.output.map((item) => item.text).join(""), /DISCONNECTED 3/)
    })))
  }
)

void test("should reject stale Stop when another restore is booting", { timeout: 120000 }, async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const coordinator = yield* makeCoordinator()
    const initial = yield* coordinator.command(initialRequest)
    const restoring = yield* coordinator.command(request(initial, "restore")).pipe(Effect.forkChild)
    yield* Effect.sleep("100 millis")
    const staleStop = yield* coordinator.command(request(initial, "stop")).pipe(Effect.exit)
    const restored = yield* Fiber.join(restoring)
    assert.ok(Exit.isFailure(staleStop))
    const state = yield* coordinator.command(initialRequest)
    assert.equal(state.generation, restored.generation)
  })))
})

void test(
  "should terminate execution and reject commands when the owner scope closes",
  { timeout: 120000 },
  async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const owner = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(owner, Exit.void))
      const coordinator = yield* makeCoordinator(30000).pipe(Effect.provideService(Scope.Scope, owner))
      const initial = yield* coordinator.command(initialRequest)
      const restored = yield* coordinator.command(request(initial, "restore"))

      const compiled = yield* coordinator.command(
        request(restored, "compile", [{ path: "/src/index.ts", text: "while (true) {}\n" }])
      )

      const running = yield* coordinator.command(request(compiled, "run")).pipe(Effect.forkChild)
      yield* Effect.sleep("100 millis")
      const started = performance.now()
      yield* Scope.close(owner, Exit.void)
      assert.ok(performance.now() - started < 3000, "Worker shutdown waited for a synchronous loop")
      assert.ok(Exit.isFailure(yield* Fiber.await(running)))
      const after = yield* Effect.exit(coordinator.command(initialRequest))
      assert.ok(Exit.isFailure(after))
    })))
  }
)

void test(
  "should preserve saved files when edits follow an interrupted save request",
  { timeout: 120000 },
  async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const coordinator = yield* makeCoordinator()
      const initial = yield* coordinator.command(initialRequest)

      const saving = yield* coordinator.command(request(initial, "save", [
        { path: "/src/index.ts", text: "console.log(\"SAVED INDEX\");\n" },
        { path: "/src/format.ts", text: "export const saved = \"SAVED HELPER\";\n" }
      ])).pipe(Effect.forkChild)

      yield* Effect.sleep("10 millis")
      yield* Fiber.interrupt(saving)
      const saved = yield* coordinator.command(initialRequest)
      assert.equal(saved.checkpoint, 1)

      const edited = yield* coordinator.command(request(saved, "compileRun", [
        { path: "/src/index.ts", text: "console.log(\"LATER INDEX\");\n" },
        { path: "/src/format.ts", text: "export const saved = \"LATER HELPER\";\n" }
      ]))

      assert.match(edited.output.map((item) => item.text).join(""), /LATER INDEX/)
      const restored = yield* coordinator.command(request(edited, "restore"))
      assert.match(restored.files.find((file) => file.path === "/src/index.ts")!.text, /SAVED INDEX/)
      assert.match(restored.files.find((file) => file.path === "/src/format.ts")!.text, /SAVED HELPER/)
      assert.equal(restored.build, null)
      assert.deepEqual(restored.changes, [])
      assert.ok(Exit.isFailure(yield* Effect.exit(coordinator.command(request(edited, "run")))))
      const compiled = yield* coordinator.command(request(restored, "compileRun"))
      assert.match(compiled.output.map((item) => item.text).join(""), /SAVED INDEX/)
      const restoredAgain = yield* coordinator.command(request(compiled, "restore"))
      assert.equal(restoredAgain.checkpoint, 1)
      assert.deepEqual(restoredAgain.files, restored.files)
      const reset = yield* coordinator.command(request(restoredAgain, "reset"))
      assert.match(reset.files.find((file) => file.path === "/src/index.ts")!.text, /summarize/)
      assert.equal(reset.checkpoint, 0)
    })))
  }
)
