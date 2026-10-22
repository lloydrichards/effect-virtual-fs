// Standalone compatibility experiment. Run in a fresh Node process; mounts and CJS caches are global.
/* eslint-disable effecttsgo/node-builtin-import */
import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { NodeVirtualProvider } from "@effect-vfs/node"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Predicate from "effect/Predicate"
import * as Scope from "effect/Scope"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { create } from "node:vfs"

const require = createRequire(import.meta.url)

assert.ok(process.argv[2], "Pass the path to typescript@5.9.3/lib/typescript.js")

const compilerPath = path.resolve(process.argv[2])

const compilerVersion = require(compilerPath).version

assert.equal(compilerVersion, "5.9.3")

const run = (effect) => Effect.runPromise(effect.pipe(Effect.provide(NodeCrypto.layer)))

const source = "import { price } from \"./price\"; export const result: number = price(100);\n"

const original = "export const price = (amount: number): number => amount;\n"

const entries = [
  { kind: "directory", path: "/src" },
  { kind: "directory", path: "/compiler" },
  { kind: "file", path: "/compiler/typescript.cjs", bytes: fs.readFileSync(compilerPath) },
  { kind: "file", path: "/src/index.ts", bytes: Buffer.from(source) },
  { kind: "file", path: "/src/price.ts", bytes: Buffer.from(original) }
]

// Provision real standard libraries once, through Effect. Compilation then reads only mounted files.
for (const name of fs.readdirSync(path.dirname(compilerPath)).filter((name) => /^lib\..*\.d\.ts$/.test(name))) {
  entries.push({
    kind: "file",
    path: `/compiler/${name}`,
    bytes: fs.readFileSync(path.join(path.dirname(compilerPath), name))
  })
}

const baseVolume = await run(Vfs.fromFixture({ entries }, { execution: "sync" }))

const base = await run(baseVolume.snapshot)

const results = []

for (const [name, multiplier, expected] of [["A", "0.8", 80], ["B", "0.9", 90]]) {
  const volume = await run(Vfs.makeOverlay(base, { execution: "sync" }))
  const caller = await run(volume.caller())
  await run(
    caller.writeFile(
      "/src/price.ts",
      Buffer.from(`export const price = (amount: number): number => amount * ${multiplier};\n`),
      {
        access: "write",
        truncate: true
      }
    )
  )
  const scope = Scope.makeUnsafe()
  let routing
  let root

  try {
    const provider = await run(NodeVirtualProvider.bind(volume).pipe(Effect.provideService(Scope.Scope, scope)))
    routing = create(provider)
    root = routing.mount()
    const ts = require(`${root}/compiler/typescript.cjs`)

    const options = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      strict: true,
      noEmitOnError: true,
      types: [],
      lib: ["lib.es2022.d.ts"],
      rootDir: `${root}/src`,
      outDir: `${root}/dist`
    }

    // Deliberately omit host: no custom CompilerHost, fs shim, or manual output callback.
    const compile = () => {
      const program = ts.createProgram([`${root}/src/index.ts`], options)
      const diagnostics = ts.getPreEmitDiagnostics(program)
      const emitted = program.emit()
      const all = [...diagnostics, ...emitted.diagnostics]
      const files = program.getSourceFiles().map((file) => file.fileName)
      assert.ok(files.length > 2, "Must load real TypeScript standard libraries")
      assert.ok(
        files.every((file) => file.startsWith(`${root}/`)),
        `Every compiler source file must be mounted: ${JSON.stringify({ root, files })}`
      )

      return { emitted, diagnostics: all, files }
    }

    const first = compile()
    assert.deepEqual(first.diagnostics, [])
    assert.equal(first.emitted.emitSkipped, false)
    const output = Buffer.from(await run(caller.readFile("/dist/index.js"))).toString()
    assert.match(output, /require\("\.\/price"\)/)
    assert.equal(require(`${root}/dist/index.js`).result, expected)
    const capture = await run(volume.capture())
    assert.equal(capture.changes.filter(Predicate.isTagged("Added")).length, 3)

    // A fresh compile must observe an Effect edit and reject it without overwriting good output.
    await run(
      caller.writeFile("/src/price.ts", Buffer.from("export const price = (amount: number): number => \"broken\";\n"), {
        access: "write",
        truncate: true
      })
    )
    const broken = compile()
    assert.ok(broken.diagnostics.some((diagnostic) => diagnostic.code === 2322))
    assert.equal(broken.emitted.emitSkipped, true)
    assert.equal(Buffer.from(await run(caller.readFile("/dist/index.js"))).toString(), output)
    results.push({
      name,
      result: expected,
      compilerSourceFiles: first.files.length,
      changes: capture.changes.map((c) => c._tag),
      invalidEditDiagnostic: 2322
    })
  } finally {
    // The compiler and CJS loader use synchronous I/O and close their own descriptors before returning.
    try {
      await run(Scope.close(scope, Exit.void))
    } finally {
      routing?.unmount()
    }

    if (root) assert.equal(fs.existsSync(`${root}/src/index.ts`), false)
  }
}

const baseCaller = await run(baseVolume.caller())

assert.equal(Buffer.from(await run(baseCaller.readFile("/src/price.ts"))).toString(), original)

await assert.rejects(run(baseCaller.stat("/dist")))

process.stdout.write(
  JSON.stringify(
    {
      result: "passed",
      node: process.version,
      typescript: compilerVersion,
      platform: process.platform,
      arch: process.arch,
      customCompilerHost: false,
      baseUnchanged: true,
      results
    },
    null,
    2
  ) + "\n"
)
