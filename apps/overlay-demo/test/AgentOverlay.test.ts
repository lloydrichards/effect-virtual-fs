import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Ref, Stream } from "effect"
import { LanguageModel, Response } from "effect/unstable/ai"
import { AgentTurnLimitExceeded, runAgent, type ToolObservation } from "../src/agent.js"
import { escapeBlock, escapeInline } from "../src/presentation.js"

const encode = (value: string) => new TextEncoder().encode(value)
const decode = (value: Uint8Array) => new TextDecoder().decode(value)

const projectSnapshot = Effect.gen(function*() {
  const project = yield* Vfs.fromFixture({
    entries: [
      { kind: "file", path: "/BRIEF.md", bytes: encode("Prepare a Friday release.") }
    ]
  })
  return yield* project.snapshot
})

type ModelStep = Array<Response.PartEncoded>

const scriptedModel = (
  steps: ReadonlyArray<ModelStep>,
  requests: Array<LanguageModel.ProviderOptions>
) =>
  Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: (options) => {
        requests.push(options)
        const step = steps[requests.length - 1]
        return Effect.succeed(step ?? [{ type: "text", text: "Done." }])
      },
      streamText: () => Stream.empty
    })
  )

const call = (id: string, name: string, params: Record<string, unknown>): ModelStep => [{
  type: "tool-call",
  id,
  name,
  params,
  providerExecuted: false
}]

const text = (value: string): ModelStep => [{ type: "text", text: value }]

const stringLeaves = (value: unknown): ReadonlyArray<string> => {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(stringLeaves)
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(stringLeaves)
  return []
}

const promptText = (request: LanguageModel.ProviderOptions) => stringLeaves(request.prompt).join(" ")

const requestAt = (requests: ReadonlyArray<LanguageModel.ProviderOptions>, index: number) => {
  const request = requests[index]
  assert.isDefined(request)
  return request
}

const collectObservations = Effect.gen(function*() {
  const observations = yield* Ref.make<ReadonlyArray<ToolObservation>>([])
  return {
    observations,
    observe: (observation: ToolObservation) => Ref.update(observations, (current) => [...current, observation])
  }
})

describe("overlay agent harness", () => {
  it("escapes terminal control characters in model-controlled text", () => {
    assert.strictEqual(escapeInline("safe\n\u001b[2J"), "safe\\u{0a}\\u{1b}[2J")
    assert.strictEqual(escapeBlock("safe\n\u009b2J"), "safe\n\\u{9b}2J")
  })

  it.effect("runs genuine multi-turn tools against an isolated overlay", () =>
    Effect.gen(function*() {
      const base = yield* projectSnapshot
      const privateCaller = yield* (yield* Vfs.makeOverlay(base)).caller()
      const siblingCaller = yield* (yield* Vfs.makeOverlay(base)).caller()
      const requests: Array<LanguageModel.ProviderOptions> = []
      const observed = yield* collectObservations
      const model = scriptedModel([
        call("read-1", "read_file", { path: "BRIEF.md" }),
        call("write-1", "write_file", { path: "proposal.md", content: "Ship Friday after tests pass." }),
        call("list-1", "list_directory", { path: "." }),
        text("The private proposal is ready.")
      ], requests)

      const result = yield* runAgent({
        caller: privateCaller,
        observe: observed.observe,
        role: "planner",
        task: "Read the brief and write a proposal."
      }).pipe(Effect.provide(model))

      assert.deepStrictEqual(result, { response: "The private proposal is ready.", turns: 4 })
      assert.strictEqual(decode(yield* privateCaller.readFile("/proposal.md")), "Ship Friday after tests pass.")
      assert.strictEqual((yield* siblingCaller.readFile("/proposal.md").pipe(Effect.option))._tag, "None")
      assert.deepStrictEqual(yield* Ref.get(observed.observations), [
        { role: "planner", operation: "read", path: "BRIEF.md" },
        { role: "planner", operation: "write", path: "proposal.md" },
        { role: "planner", operation: "list", path: "." }
      ])
      assert.strictEqual(requests.length, 4)
      assert.match(promptText(requestAt(requests, 1)), /tool-result/)
      assert.match(promptText(requestAt(requests, 1)), /Prepare a Friday release\./)
      assert.match(promptText(requestAt(requests, 2)), /Wrote proposal\.md/)
      assert.match(promptText(requestAt(requests, 3)), /proposal\.md/)
    }))

  it.effect("rejects absolute and traversing tool paths before filesystem access", () =>
    Effect.gen(function*() {
      const base = yield* projectSnapshot
      const invalidPaths = ["/project/BRIEF.md", "../BRIEF.md"]

      for (const invalidPath of invalidPaths) {
        const caller = yield* (yield* Vfs.makeOverlay(base)).caller()
        const requests: Array<LanguageModel.ProviderOptions> = []
        const observed = yield* collectObservations
        const model = scriptedModel([
          call("invalid-1", "read_file", { path: invalidPath }),
          text("Rejected.")
        ], requests)
        const result = yield* runAgent({
          caller,
          observe: observed.observe,
          role: "planner",
          task: "Try an invalid path."
        }).pipe(Effect.provide(model))

        assert.strictEqual(result.response, "Rejected.")
        assert.deepStrictEqual(yield* Ref.get(observed.observations), [])
        assert.match(
          promptText(requestAt(requests, 1)),
          invalidPath.startsWith("/") ? /relative to the project root/ : /traversal/
        )
      }
    }))

  it.effect("lets separate callers collaborate and captures their stable result", () =>
    Effect.gen(function*() {
      const workspace = yield* Vfs.makeOverlay(yield* projectSnapshot)
      const author = yield* workspace.caller()
      const reviewer = yield* workspace.caller()
      const observed = yield* collectObservations
      const watched = yield* (yield* workspace.watch).pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true })
      )

      const reviewerRequests: Array<LanguageModel.ProviderOptions> = []
      yield* runAgent({
        caller: author,
        observe: observed.observe,
        role: "author",
        task: "Write the release plan."
      }).pipe(Effect.provide(scriptedModel([
        call("author-write", "write_file", { path: "release-plan.md", content: "Ship Friday after tests pass." }),
        text("Plan written.")
      ], [])))

      yield* runAgent({
        caller: reviewer,
        observe: observed.observe,
        role: "reviewer",
        task: "Review the release plan."
      }).pipe(Effect.provide(scriptedModel([
        call("review-read", "read_file", { path: "release-plan.md" }),
        call("review-write", "write_file", { path: "REVIEW.md", content: "Approved: tests gate the release." }),
        text("Review written.")
      ], reviewerRequests)))

      const capture = yield* workspace.capture()
      yield* author.writeFile("/release-plan.md", encode("Later live edit."), {
        access: "write",
        truncate: true
      })
      const captured = yield* (yield* Vfs.fromSnapshot(capture.snapshot)).caller()

      assert.strictEqual(decode(yield* captured.readFile("/release-plan.md")), "Ship Friday after tests pass.")
      assert.strictEqual(decode(yield* captured.readFile("/REVIEW.md")), "Approved: tests gate the release.")
      assert.strictEqual(decode(yield* author.readFile("/release-plan.md")), "Later live edit.")
      assert.match(promptText(requestAt(reviewerRequests, 1)), /Ship Friday after tests pass\./)
      const watchEvents = Array.from(yield* Fiber.join(watched))
      const observedPaths = yield* Effect.forEach(watchEvents, (event) =>
        Vfs.pathToBytes(event.path).pipe(Effect.map((path) => `${event._tag}:${decode(path)}`)))
      assert.deepStrictEqual(observedPaths, ["Create:/release-plan.md", "Create:/REVIEW.md"])
      const capturedPaths = yield* Effect.forEach(capture.changes, (change) =>
        change._tag === "Renamed"
          ? Effect.succeed(change._tag)
          : Vfs.pathToBytes(change.path).pipe(Effect.map(decode)))
      assert.deepStrictEqual(capturedPaths, ["/REVIEW.md", "/release-plan.md"])
      assert.deepStrictEqual(
        (yield* Ref.get(observed.observations)).filter((entry) =>
          entry.role === "reviewer"
        ),
        [
          { role: "reviewer", operation: "read", path: "release-plan.md" },
          { role: "reviewer", operation: "write", path: "REVIEW.md" }
        ]
      )
    }))

  it.effect("fails at the turn limit without making a ninth model request", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.makeOverlay(yield* projectSnapshot)).caller()
      const requests: Array<LanguageModel.ProviderOptions> = []
      const observed = yield* collectObservations
      const steps = Array.from(
        { length: 9 },
        (_, index) => call(`read-${index + 1}`, "read_file", { path: "BRIEF.md" })
      )
      const failure = yield* runAgent({
        caller,
        observe: observed.observe,
        role: "planner",
        task: "Keep reading forever."
      }).pipe(
        Effect.provide(scriptedModel(steps, requests)),
        Effect.flip
      )

      assert.instanceOf(failure, AgentTurnLimitExceeded)
      assert.deepStrictEqual(failure, new AgentTurnLimitExceeded({ role: "planner", limit: 8 }))
      assert.strictEqual(requests.length, 8)
      assert.strictEqual((yield* Ref.get(observed.observations)).length, 8)
    }))
})
