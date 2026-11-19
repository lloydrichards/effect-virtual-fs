import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { assert, it } from "@effect/vitest"
import { Console, Effect, Fiber, Layer, Ref, Stream } from "effect"
import { LanguageModel, type Response } from "effect/ai"
import { describe } from "vitest"
import { AgentTurnLimitExceeded, runAgent, type ToolObservation } from "../src/agent.js"

import { walkthrough } from "../src/demo.js"

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

type JsonValue = string | number | boolean | null | ReadonlyArray<JsonValue> | { readonly [key: string]: JsonValue }

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

const call = (id: string, name: string, params: Readonly<Record<string, JsonValue>>): ModelStep => [{
  type: "tool-call",
  id,
  name,
  params,
  providerExecuted: false
}]

const text = (value: string): ModelStep => [{ type: "text", text: value }]

const promptText = (request: LanguageModel.ProviderOptions) => JSON.stringify(request.prompt)

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

describe("overlay agent", () => {
  it.live("should discard private edits and restore the captured handoff through the demo walkthrough", () => {
    const output: Array<string> = []

    const model = scriptedModel([
      call("proposal", "write_file", { path: "proposal.md", content: "Private proposal." }),
      text("Proposal ready."),
      call("plan", "write_file", {
        path: "release-plan.md",
        content: "- Ship Friday.\n- Run tests.\n- Prepare rollback."
      }),
      text("Plan ready."),
      call("read-plan", "read_file", { path: "release-plan.md" }),
      call("review", "write_file", { path: "REVIEW.md", content: "Pass.\nFriday and tests are covered." }),
      text("Review ready.")
    ], [])

    return walkthrough.pipe(
      Effect.provide(Layer.merge(model, BunCrypto.layer)),
      Effect.provideService(Console.Console, {
        ...console,
        log: (message: string) => {
          output.push(message)
        }
      }),
      Effect.timeout("10 seconds"),
      Effect.tap(() =>
        Effect.sync(() => {
          const transcript = output.join("\n")
          assert.include(transcript, "proposal.md does not exist")
          assert.include(transcript, "- Prepare rollback.")
          assert.include(transcript, "Friday and tests are covered.")
          assert.include(transcript, "A later live edit.")
          assert.include(transcript, "/plan.md still reads after root rename")
          assert.include(transcript, "NotFound")
        })
      )
    )
  }, 12_000)

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should run multi-turn tools against an isolated overlay when the model requests them",
      () =>
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
        })
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should reject paths before filesystem access when tools request absolute or traversing paths",
      () =>
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
        })
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should report a failed read without a successful observation when file bytes are malformed UTF-8",
      () =>
        Effect.gen(function*() {
          const project = yield* Vfs.fromFixture({
            entries: [{ kind: "file", path: "/invalid.txt", bytes: new Uint8Array([0xff]) }]
          })

          const caller = yield* (yield* Vfs.makeOverlay(yield* project.snapshot)).caller()
          const requests: Array<LanguageModel.ProviderOptions> = []
          const observed = yield* collectObservations

          const result = yield* runAgent({
            caller,
            observe: observed.observe,
            role: "planner",
            task: "Read invalid.txt."
          }).pipe(Effect.provide(scriptedModel([
            call("invalid-utf8", "read_file", { path: "invalid.txt" }),
            text("The file is not valid UTF-8.")
          ], requests)))

          assert.strictEqual(result.response, "The file is not valid UTF-8.")
          assert.deepStrictEqual(yield* Ref.get(observed.observations), [])
          assert.match(promptText(requestAt(requests, 1)), /Invalid UTF-8 file: invalid\.txt/)
        })
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should deliver two create events and reviewer observations when shared callers collaborate",
      () =>
        Effect.gen(function*() {
          const workspace = yield* Vfs.makeOverlay(yield* projectSnapshot)
          const author = yield* workspace.caller()
          const reviewer = yield* workspace.caller()
          const observed = yield* collectObservations

          const watched = yield* (yield* workspace.watch()).pipe(
            Stream.take(2),
            Stream.runCollect,
            Effect.forkChild({ startImmediately: true })
          )

          yield* runAgent({
            caller: author,
            observe: observed.observe,
            role: "author",
            task: "Write the release plan."
          }).pipe(Effect.provide(scriptedModel([
            call("author-write", "write_file", { path: "release-plan.md", content: "Ship Friday after tests pass." }),
            text("Plan written.")
          ], [])))

          const reviewerRequests: Array<LanguageModel.ProviderOptions> = []
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

          const watchEvents = Array.from(yield* Fiber.join(watched))

          const observedPaths = yield* Effect.forEach(
            watchEvents,
            (event) => Vfs.pathToBytes(event.path).pipe(Effect.map((path) => `${event._tag}:${decode(path)}`))
          )

          assert.deepStrictEqual(observedPaths, ["Create:/release-plan.md", "Create:/REVIEW.md"])
          assert.match(promptText(requestAt(reviewerRequests, 1)), /Ship Friday after tests pass\./)
          assert.deepStrictEqual(
            (yield* Ref.get(observed.observations)).filter((entry) => entry.role === "reviewer"),
            [
              { role: "reviewer", operation: "read", path: "release-plan.md" },
              { role: "reviewer", operation: "write", path: "REVIEW.md" }
            ]
          )

          yield* author.writeFile("/release-plan.md", encode("Later live edit."), {
            access: "write",
            truncate: true
          })
          assert.strictEqual(decode(yield* reviewer.readFile("/release-plan.md")), "Later live edit.")
        })
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should stop before another model request when the turn limit is reached",
      () =>
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
        })
    )
  })
})
