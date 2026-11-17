import { readdir, readFile } from "node:fs/promises"
import { createRequire, isBuiltin } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { discoverWorkspaces, publicEntries } from "./repository.mjs"

const root = fileURLToPath(new URL("../../", import.meta.url))

const require = createRequire(new URL("../../packages/effect-preview/package.json", import.meta.url))

const ts = require("typescript-js")

/** Capture imports with their runtime meaning, including mixed import/export lists. */
export function imports(source, filename = "source.ts") {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true)
  const result = []

  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause
      // verbatimModuleSyntax retains empty module loads for inline type specifiers.
      result.push({ specifier: node.moduleSpecifier.text, runtime: !clause?.isTypeOnly })
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      result.push({ specifier: node.moduleSpecifier.text, runtime: !node.isTypeOnly })
    } else if (
      ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)
    ) {
      result.push({ specifier: node.argument.literal.text, runtime: false })
    } else if (
      ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      result.push({ specifier: node.arguments[0].text, runtime: true })
    } else if (
      ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)
    ) {
      result.push({ specifier: node.moduleReference.expression.text, runtime: !node.isTypeOnly })
    }

    ts.forEachChild(node, visit)
  }

  visit(file)

  return result
}

/** Return one path per runtime cycle, without treating shared dependencies as cycles. */
export function cycles(graph) {
  const complete = new Set()
  const active = new Map()
  const stack = []
  const found = []

  const visit = (file) => {
    if (active.has(file)) {
      found.push([...stack.slice(active.get(file)), file])

      return
    }

    if (complete.has(file)) return
    active.set(file, stack.length)
    stack.push(file)

    for (const dependency of graph.get(file) ?? []) visit(dependency)
    stack.pop()
    active.delete(file)
    complete.add(file)
  }

  for (const file of graph.keys()) visit(file)

  return found
}

export function forbiddenImport(workspace, target, specifier) {
  if (target && target.manifest.name !== workspace.manifest.name) {
    if (!(workspace.policy.allowedDependencies ?? []).includes(target.manifest.name)) {
      return `${workspace.manifest.name} may not depend on ${target.manifest.name}`
    }

    if (specifier !== target.manifest.name && !specifier.startsWith(`${target.manifest.name}/`)) {
      return "Cross-workspace relative imports and aliases bypass published exports"
    }

    if (
      specifier.includes("/internal/") && !(workspace.manifest.name === "@effect-vfs/core" &&
        target.manifest.name === "@effect-vfs/effect-preview")
    ) {
      return "Cross-workspace internal imports are private"
    }
  }

  if (specifier.startsWith("effect/internal/") || specifier.includes("/node_modules/")) {
    return "Imports must use supported package exports"
  }

  if (
    (workspace.manifest.name === "@effect-vfs/core" || workspace.manifest.name === "@effect-vfs/effect-preview") &&
    (/^(?:node:|bun:|@effect\/platform-)/.test(specifier) || isBuiltin(specifier))
  ) {
    return "The filesystem engine must remain runtime neutral"
  }
}

async function sources(directory, repositoryRoot) {
  const result = []

  for (
    const entry of await readdir(path.join(repositoryRoot, directory), { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return []
      throw error
    })
  ) {
    const relative = `${directory}/${entry.name}`

    if (entry.isDirectory()) result.push(...await sources(relative, repositoryRoot))
    else if (/\.[cm]?tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) result.push(relative)
  }

  return result
}

export async function checkBoundaries({ directory = root, workspaces, quiet = false } = {}) {
  workspaces ??= await discoverWorkspaces(directory)
  const byName = new Map(workspaces.map((workspace) => [workspace.manifest.name, workspace]))
  const files = new Map()

  for (const workspace of workspaces) {
    for (const sourceDirectory of workspace.policy.sourceDirectories ?? ["src", "app"]) {
      for (const file of await sources(`${workspace.directory}/${sourceDirectory}`, directory)) {
        files.set(file, workspace)
      }
    }
  }

  const compilerOptions = new Map()

  for (const workspace of workspaces) {
    const configPath = path.join(directory, workspace.directory, "tsconfig.json")
    const config = ts.readConfigFile(configPath, (file) => ts.sys.readFile(file))
    compilerOptions.set(
      workspace.directory,
      config.error ?
        {} :
        ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath)).options
    )
  }

  const graph = new Map([...files.keys()].map((file) => [file, new Set()]))
  const issues = []

  const resolveRelative = (from, specifier) => {
    const candidate = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier)).replace(
      /\.[cm]?js$/,
      ".ts"
    )

    return [candidate, `${candidate}.ts`, `${candidate}.tsx`, `${candidate}/index.ts`].find((file) => files.has(file))
  }

  for (const [file, workspace] of files) {
    for (const entry of imports(await readFile(path.join(directory, file), "utf8"), file)) {
      const packageName = entry.specifier.startsWith("@")
        ? entry.specifier.split("/").slice(0, 2).join("/")
        : entry.specifier.split("/")[0]

      let target = byName.get(packageName)
      let resolved

      if (entry.specifier.startsWith(".")) {
        resolved = resolveRelative(file, entry.specifier)
        target = files.get(resolved)

        if (!resolved && entry.runtime && !/\.(?:css|json|svg|png|jpg|webp|mdx|html)(?:\?.*)?$/.test(entry.specifier)) {
          issues.push(`${file}: unresolved source import ${entry.specifier}`)
        }
      } else if (!target) {
        const resolution = ts.resolveModuleName(
          entry.specifier,
          path.join(directory, file),
          compilerOptions.get(workspace.directory),
          ts.sys
        ).resolvedModule

        const candidate = resolution && path.relative(directory, resolution.resolvedFileName).split(path.sep).join("/")

        if (candidate && files.has(candidate)) {
          resolved = candidate
          target = files.get(candidate)
        }
      } else if (target) {
        const subpath = entry.specifier === packageName ? "." : `.${entry.specifier.slice(packageName.length)}`
        resolved = publicEntries(target).find((item) => item.subpath === subpath)?.source

        if (!resolved) issues.push(`${file}: ${entry.specifier} is not an exported source entrypoint`)
      }

      const forbidden = forbiddenImport(workspace, target, entry.specifier)

      if (forbidden) issues.push(`${file}: ${forbidden}: ${entry.specifier}`)

      if (entry.runtime && resolved) graph.get(file).add(resolved)
    }
  }

  for (const cycle of cycles(graph)) issues.push(`Runtime import cycle: ${cycle.join(" -> ")}`)

  if (issues.length > 0) throw new Error(issues.join("\n"))

  if (!quiet) {
    console.log(`Architecture checks passed for ${files.size} source modules in ${workspaces.length} workspaces.`)
  }

  return { modules: files.size, workspaces: workspaces.length }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await checkBoundaries()
