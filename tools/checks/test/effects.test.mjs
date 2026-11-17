import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import compiler from "../../../packages/config-typescript/base.json" with { type: "json" }
import { root } from "../repository.mjs"

const runDiagnostics = async (args, directory) => {
  const child = Bun.spawn(args, { cwd: directory, stdout: "pipe", stderr: "pipe" })

  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ])

  if (status !== 1 || stderr !== "" || !stdout.trimStart().startsWith("{")) {
    throw new Error(`Expected diagnostics from ${args[0]} (exit ${status})\n${stderr}${stdout}`)
  }

  return JSON.parse(stdout).diagnostics
}

test("should enforce channel contracts and preserve narrow exceptions in both Effect checks", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "vfs-effect-policy-"))
  const workspace = "packages/core"
  const fixturePath = (file) => path.join(directory, workspace, file)

  try {
    await mkdir(fixturePath("src/internal"), { recursive: true })
    await mkdir(fixturePath("node_modules"))
    await mkdir(path.join(directory, "tools/oxlint"), { recursive: true })

    const require = createRequire(path.join(root, workspace, "package.json"))
    const effect = path.dirname(require.resolve("effect/package.json"))

    await Promise.all([
      symlink(effect, fixturePath("node_modules/effect"), "dir"),
      symlink(path.join(root, "node_modules"), path.join(directory, "node_modules"), "dir"),
      symlink(
        path.join(root, "tools/oxlint/anti-slop"),
        path.join(directory, "tools/oxlint/anti-slop"),
        "dir"
      ),
      writeFile(
        path.join(directory, "oxlint.config.ts"),
        `export { default } from ${JSON.stringify(path.join(root, "oxlint.config.ts"))}\n`
      ),
      writeFile(fixturePath("package.json"), JSON.stringify({ name: "@test/effect-policy", type: "module" })),
      writeFile(
        fixturePath("tsconfig.json"),
        JSON.stringify({
          extends: path.join(root, "packages/config-typescript/base.json"),
          include: ["src/**/*.ts"]
        })
      )
    ])

    const experimentalImport = `
import { Effect } from "effect"
import { value } from "../experimental.js"

export const nested = Effect.gen(function*() {
  const number = yield* Effect.succeed(value)
  yield* Effect.yieldNow

  return number + Effect.runSync(Effect.succeed(1))
})
`

    const files = {
      "src/internal/invalid.ts": `
import { Effect, type Layer, type Stream } from "effect"

declare const task: Effect.Effect<string, "failure", "dependency">

declare const stream: Stream.Stream<string, "failure", "dependency">

declare const layer: Layer.Layer<"service", "failure", "dependency">

declare const mayThrow: () => number

// SAFETY: Intentionally erase an Effect error to exercise diagnostic policy.
export const erasedEffect = task as Effect.Effect<string, never, "dependency">

// SAFETY: Intentionally erase a Stream requirement to exercise diagnostic policy.
export const erasedStream = stream as Stream.Stream<string, "failure">

// SAFETY: Intentionally erase Layer errors and requirements to exercise diagnostic policy.
export const erasedLayer = layer as Layer.Layer<"service">

export const unknownError = Effect.fail<unknown>("failure")

export const anyError = Effect.fail<any>("failure")

export const unknownRequirement = Effect.context<unknown>()

export const untypedTry = Effect.try(mayThrow)
`,
      "src/internal/valid.ts": `
import { Effect, Schema } from "effect"

declare const task: Effect.Effect<string, "failure", "dependency">

declare const input: unknown

declare const mayThrow: () => number

class ReadFailure extends Schema.TaggedError<ReadFailure>()("ReadFailure", { cause: Schema.Unknown }) {}

export const widenedError: Effect.Effect<string, "failure" | "other", "dependency"> = task

export const preserveChannels = <A, E, R>(source: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => source

export const decode = Schema.decodeUnknownEffect(Schema.String)

export const unknownSuccess = Effect.succeed(input)

export const typedTry = Effect.try({ try: mayThrow, catch: (cause) => new ReadFailure({ cause }) })
`,
      "src/experimental.ts": "/** @stability experimental */\nexport const value = 1\n",
      "src/internal/outside.ts": experimentalImport,
      "src/internal/runtime.ts": experimentalImport + "\nexport const broken = Effect.fail<unknown>(\"failure\")\n",
      "src/internal/synchronous.ts": experimentalImport + "\nexport const broken = Effect.fail<unknown>(\"failure\")\n"
    }

    await Promise.all(Object.entries(files).map(([file, source]) => writeFile(fixturePath(file), source)))

    const options = { ...compiler.compilerOptions.plugins[0], diagnostics: true }
    delete options.name

    const [native, standalone] = await Promise.all([
      runDiagnostics([
        path.join(root, "node_modules/.bin/oxlint"),
        "--format",
        "json",
        ...Object.keys(files).map((file) => `${workspace}/${file}`)
      ], directory),
      runDiagnostics([
        "bun",
        path.join(root, "node_modules/@effect/tsgo/dist/effect-tsgo.cjs"),
        "diagnostics",
        "--project",
        `${workspace}/tsconfig.json`,
        "--format",
        "json",
        "--lspconfig",
        JSON.stringify(options)
      ], directory)
    ])

    const channelErrors = [
      "any-unknown-in-error-context:error",
      "any-unknown-in-error-context:error",
      "any-unknown-in-error-context:error",
      "effect-try-without-catch:error",
      "unsafe-effect-type-assertion:error",
      "unsafe-effect-type-assertion:error",
      "unsafe-effect-type-assertion:error"
    ]

    const checks = [
      {
        diagnostics: native.map(({ code, filename, severity }) => ({
          rule: code.replace(/^effecttsgo\((.+)\)$/, "$1"),
          file: path.basename(filename),
          severity
        })),
        nestedRunnerSeverity: "warning"
      },
      {
        diagnostics: standalone.map(({ name, file, severity }) => ({
          rule: name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
          file: path.basename(file),
          severity
        })),
        nestedRunnerSeverity: "message"
      }
    ]

    for (const { diagnostics, nestedRunnerSeverity } of checks) {
      const rulesIn = (file) =>
        diagnostics.filter((diagnostic) => diagnostic.file === file)
          .map(({ rule, severity }) => `${rule}:${severity}`)
          .sort()

      expect(rulesIn("invalid.ts")).toEqual(channelErrors)
      expect(rulesIn("valid.ts")).toEqual([])
      expect(rulesIn("outside.ts")).toEqual([
        "experimental-api-usage:warning",
        `run-effect-inside-effect:${nestedRunnerSeverity}`
      ])
      expect(rulesIn("runtime.ts")).toEqual([
        "any-unknown-in-error-context:error",
        `run-effect-inside-effect:${nestedRunnerSeverity}`
      ])
      expect(rulesIn("synchronous.ts")).toEqual(["any-unknown-in-error-context:error"])
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 15_000)
