import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import { Config, Data, Effect, Layer, Schema } from "effect"
import { Chat, LanguageModel, Tool, Toolkit } from "effect/unstable/ai"
import { FetchHttpClient } from "effect/unstable/http"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export type AgentRole = "planner" | "author" | "reviewer"

export interface ToolObservation {
  readonly role: AgentRole
  readonly operation: "list" | "read" | "write"
  readonly path: string
}

export type ObserveTool = (observation: ToolObservation) => Effect.Effect<void>

export class AgentTurnLimitExceeded extends Data.TaggedError("AgentTurnLimitExceeded")<{
  readonly role: AgentRole
  readonly limit: number
}> {}

const ReadFile = Tool.make("read_file", {
  description: "Read a UTF-8 file in the assigned virtual project",
  parameters: Schema.Struct({ path: Schema.String }),
  success: Schema.String,
  failure: Schema.String,
  failureMode: "return"
})

const WriteFile = Tool.make("write_file", {
  description: "Create or replace a UTF-8 file in the assigned virtual project",
  parameters: Schema.Struct({ path: Schema.String, content: Schema.String }),
  success: Schema.String,
  failure: Schema.String,
  failureMode: "return"
})

const ListDirectory = Tool.make("list_directory", {
  description: "List the entries in a directory in the assigned virtual project",
  parameters: Schema.Struct({ path: Schema.String }),
  success: Schema.Array(Schema.String),
  failure: Schema.String,
  failureMode: "return"
})

export const WorkspaceTools = Toolkit.make(ReadFile, WriteFile, ListDirectory)

const projectPath = (input: string) => {
  if (input.startsWith("/")) {
    return Effect.fail("Use a path relative to the project root, not an absolute path")
  }
  const segments = input.split("/")
  if (segments.includes("..")) {
    return Effect.fail("Path traversal outside the project root is not allowed")
  }
  const normalized = segments.filter((segment) => segment !== "" && segment !== ".").join("/")
  return Effect.succeed(normalized === "" ? "." : normalized)
}

const fsFailure = (error: Vfs.FsError) => `${error.code}: ${error.operation}`

export const makeWorkspaceToolkit = Effect.fn("Agent.makeWorkspaceToolkit")(function*(
  caller: Vfs.Caller,
  role: AgentRole,
  observe: ObserveTool
) {
  const observed = (operation: ToolObservation["operation"], path: string) => observe({ role, operation, path })

  return yield* WorkspaceTools.pipe(Effect.provide(WorkspaceTools.toLayer(WorkspaceTools.of({
    read_file: Effect.fn("WorkspaceTools.readFile")(function*({ path }) {
      const relativePath = yield* projectPath(path)
      const bytes = yield* caller.readFile(relativePath).pipe(Effect.mapError(fsFailure))
      yield* observed("read", relativePath)
      return decoder.decode(bytes)
    }),
    write_file: Effect.fn("WorkspaceTools.writeFile")(function*({ content, path }) {
      const relativePath = yield* projectPath(path)
      yield* caller.writeFile(relativePath, encoder.encode(content), {
        access: "write",
        create: "ifMissing",
        truncate: true
      }).pipe(Effect.mapError(fsFailure))
      yield* observed("write", relativePath)
      return `Wrote ${relativePath}`
    }),
    list_directory: Effect.fn("WorkspaceTools.listDirectory")(function*({ path }) {
      const relativePath = yield* projectPath(path)
      const entries = yield* caller.readDirectory(relativePath).pipe(Effect.mapError(fsFailure))
      yield* observed("list", relativePath)
      return [...entries]
    })
  }))))
})

const maxAgentTurns = 8

export const runAgent = Effect.fn("Agent.run")(function*({
  caller,
  observe,
  role,
  task
}: {
  readonly caller: Vfs.Caller
  readonly observe: ObserveTool
  readonly role: AgentRole
  readonly task: string
}) {
  const toolkit = yield* makeWorkspaceToolkit(caller, role, observe)
  const chat = yield* Chat.fromPrompt([
    {
      role: "system",
      content: [
        `You are the ${role} in a small software project.`,
        "Use only the supplied workspace tools to inspect and change project files.",
        "All tool paths are relative to the project root.",
        "Complete the requested filesystem work, then respond with one short sentence."
      ].join(" ")
    },
    { role: "user", content: task }
  ])

  for (let turn = 1; turn <= maxAgentTurns; turn++) {
    const response = yield* chat.generateText({
      prompt: [],
      toolkit,
      concurrency: 1
    })
    if (response.toolCalls.length === 0) {
      return { response: response.text, turns: turn }
    }
  }

  return yield* new AgentTurnLimitExceeded({ role, limit: maxAgentTurns })
})

const OpenAiClientLive = OpenAiClient.layerConfig({
  apiKey: Config.redacted("OPENAI_API_KEY")
}).pipe(Layer.provide(FetchHttpClient.layer))

export const LanguageModelLive = Layer.effect(
  LanguageModel.LanguageModel,
  Effect.gen(function*() {
    const model = yield* Config.string("OPENAI_MODEL").pipe(Config.withDefault("gpt-5-mini"))
    return yield* OpenAiLanguageModel.make({ model })
  })
).pipe(Layer.provide(OpenAiClientLive))
