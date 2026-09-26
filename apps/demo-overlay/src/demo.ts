import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { Cause, Console, Effect, Layer, Predicate, Queue, Ref, Stream } from "effect"
import { LanguageModelLive, type ObserveTool, runAgent, type ToolObservation } from "./agent.js"
import {
  pacing,
  showChanges,
  showFile,
  showMessage,
  showRestoredFiles,
  showStage,
  showTakeaway,
  showTitle,
  showToolAction,
  showWatchEvent
} from "./presentation.js"

const encode = (value: string) => new TextEncoder().encode(value)

const decode = (value: Uint8Array) => new TextDecoder().decode(value)

const program = Effect.scoped(Effect.gen(function*() {
  yield* showTitle

  const template = yield* Vfs.fromFixture({
    entries: [
      {
        kind: "file",
        path: "/BRIEF.md",
        bytes: encode("Prepare a Friday release plan. The test suite must pass before release.")
      }
    ]
  })

  const base = yield* template.snapshot

  // Both overlays start from this snapshot. Writes to either overlay leave the base unchanged.
  yield* showStage(
    1,
    "STARTING PROJECT",
    "One immutable snapshot becomes the starting point for every agent workspace."
  )
  yield* showMessage("BRIEF.md", "Prepare a Friday release plan. Tests must pass first.")
  yield* showMessage("TOOLS", "list, read, and write inside this virtual project only")
  yield* pacing

  const actions = yield* Ref.make<ReadonlyArray<ToolObservation>>([])

  const observe: ObserveTool = (action) =>
    Ref.update(actions, (current) => [...current, action]).pipe(
      Effect.andThen(showToolAction({ actor: action.role, tool: action.operation, path: action.path }))
    )

  const privateWorkspace = yield* Vfs.makeOverlay(base)
  const privatePlanner = yield* privateWorkspace.caller()

  yield* showStage(
    2,
    "DISPOSABLE PLANNER",
    "The planner receives its own overlay. Its proposal will be inspected, then discarded."
  )

  const plannerResult = yield* runAgent({
    caller: privatePlanner,
    observe,
    role: "planner",
    task: [
      "Read BRIEF.md, then create proposal.md.",
      "The file must contain exactly three short bullet points and no heading.",
      "You must use the tools."
    ].join(" ")
  })

  const privateProposal = decode(yield* privatePlanner.readFile("/proposal.md"))
  const templateReader = yield* (yield* Vfs.fromSnapshot(base)).caller()
  const proposalInTemplate = yield* templateReader.readFile("/proposal.md").pipe(Effect.option)
  yield* showMessage("PLANNER", `${plannerResult.response} (${plannerResult.turns} turns)`)
  yield* showFile("PRIVATE", "proposal.md", privateProposal)
  yield* showMessage(
    "TEMPLATE",
    Predicate.isTagged(proposalInTemplate, "None") ? "proposal.md does not exist" : "unexpected change"
  )
  yield* pacing

  const sharedWorkspace = yield* Vfs.makeOverlay(base)
  const author = yield* sharedWorkspace.caller()
  const reviewer = yield* sharedWorkspace.caller()
  // The watch belongs to the shared overlay, so it reports both callers' file changes.
  const watchQueue = yield* Queue.unbounded<Vfs.Change>()
  const watch = yield* sharedWorkspace.watch()
  yield* watch.pipe(
    Stream.runForEach((event) => showWatchEvent(event).pipe(Effect.andThen(Queue.offer(watchQueue, event)))),
    Effect.forkScoped
  )

  yield* showStage(
    3,
    "AUTHOR AND REVIEWER SHARE AN OVERLAY",
    "Separate callers share files, while the model sessions remain independent."
  )

  const authorResult = yield* runAgent({
    caller: author,
    observe,
    role: "author",
    task: [
      "Read BRIEF.md, then create release-plan.md that satisfies every requirement.",
      "The file must contain exactly three short bullet points and no heading.",
      "You must use the tools."
    ].join(" ")
  })

  const reviewerResult = yield* runAgent({
    caller: reviewer,
    observe,
    role: "reviewer",
    task: [
      "Independently read BRIEF.md and release-plan.md from your workspace.",
      "Then create REVIEW.md stating whether the plan satisfies the brief and why.",
      "The file must contain exactly two short lines.",
      "You must use the tools."
    ].join(" ")
  })

  const recordedActions = yield* Ref.get(actions)

  const reviewerReadAuthorFile = recordedActions.some((action) =>
    action.role === "reviewer" && action.operation === "read" && action.path === "release-plan.md"
  )

  if (!reviewerReadAuthorFile) {
    return yield* Effect.die(new Error("Reviewer finished without reading the author's release-plan.md"))
  }

  const sharedWrites = recordedActions.filter((action) =>
    action.role !== "planner" && action.operation === "write"
  ).length

  // Drain the watch before printing the capture stage so late events stay with their writes.
  yield* Queue.takeN(watchQueue, sharedWrites)
  yield* showMessage("AUTHOR", `${authorResult.response} (${authorResult.turns} turns)`)
  yield* showMessage("REVIEWER", `${reviewerResult.response} (${reviewerResult.turns} turns)`)
  yield* pacing

  yield* showStage(
    4,
    "CAPTURED HANDOFF",
    "Final differences and restored files come from one captured state."
  )
  const livePlan = decode(yield* author.readFile("/release-plan.md"))
  const liveReview = decode(yield* reviewer.readFile("/REVIEW.md"))
  const planLines = livePlan.trim().split("\n")
  const reviewLines = liveReview.trim().split("\n")

  if (
    planLines.length !== 3 ||
    planLines.some((line) => !line.startsWith("-")) ||
    !/friday/i.test(livePlan) ||
    !/test/i.test(livePlan) ||
    reviewLines.length !== 2
  ) {
    return yield* Effect.die(new Error("The model did not produce the requested compact output files"))
  }

  const captured = yield* sharedWorkspace.capture()
  yield* showMessage("ORCHESTRATOR", "capture complete; mutate the live workspace once more")
  // A later edit proves that restoring the capture reads frozen data, not the live overlay.
  yield* author.writeFile("/release-plan.md", encode("A later live edit."), {
    access: "write",
    truncate: true
  })
  const restored = yield* (yield* Vfs.fromSnapshot(captured.snapshot)).caller()
  const restoredPlan = decode(yield* restored.readFile("/release-plan.md"))
  const restoredReview = decode(yield* restored.readFile("/REVIEW.md"))

  yield* showChanges(captured.changes)
  yield* showRestoredFiles([
    { path: "release-plan.md", content: restoredPlan },
    { path: "REVIEW.md", content: restoredReview }
  ])
  yield* showMessage("LIVE NOW", decode(yield* author.readFile("/release-plan.md")))
  yield* showMessage("CAPTURE", "still contains the agent output shown above")
  yield* pacing
  yield* showTakeaway
}))

await Effect.runPromise(program.pipe(
  Effect.provide(Layer.merge(LanguageModelLive, BunCrypto.layer)),
  Effect.catchCause(Effect.fnUntraced(function*(cause) {
    yield* Console.error(`Demo failed:\n${Cause.pretty(cause)}`)
    process.exitCode = 1
  }))
))
