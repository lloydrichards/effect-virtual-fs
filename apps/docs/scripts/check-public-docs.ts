#!/usr/bin/env bun

// oxlint-disable effecttsgo/node-builtin-import, effecttsgo/global-console -- This repository checker reads paths and reports diagnostics through the host CLI.

import path from "node:path"
import {
  type ClassDeclaration,
  type EnumDeclaration,
  type FunctionDeclaration,
  type InterfaceDeclaration,
  type ModuleDeclaration,
  Node,
  Project,
  type TypeAliasDeclaration,
  type VariableStatement
} from "ts-morph"
import { publicEntries, validateInventory } from "../../../tools/checks/repository.mjs"
import { apiPages } from "../app/api-pages"

const version = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

type PublicDeclaration =
  | VariableStatement
  | ClassDeclaration
  | InterfaceDeclaration
  | TypeAliasDeclaration
  | FunctionDeclaration
  | EnumDeclaration
  | ModuleDeclaration

const isDocumentedDeclaration = (node: Node): node is PublicDeclaration =>
  Node.isVariableStatement(node) || Node.isClassDeclaration(node) || Node.isInterfaceDeclaration(node) ||
  Node.isTypeAliasDeclaration(node) || Node.isFunctionDeclaration(node) || Node.isEnumDeclaration(node) ||
  Node.isModuleDeclaration(node)

const declarationNames = (node: PublicDeclaration): Array<string> =>
  Node.isVariableStatement(node)
    ? node.getDeclarations().map((declaration) => declaration.getName())
    : [node.getName() ?? "default"]

/** Checks syntax-level documentation contracts without loading a compiler project. */
export const checkPublicSource = (
  text: string,
  filename: string,
  publicSources: ReadonlySet<string> = new Set([filename])
): Array<string> => {
  const project = new Project({ useInMemoryFileSystem: true })
  const source = project.createSourceFile(filename, text)
  const failures: Array<string> = []
  const publicNames = new Set<string>()

  const declarations = source.getStatements().filter(isDocumentedDeclaration)
  const localExports = new Set<string>()

  const isPublic = (statement: PublicDeclaration): boolean =>
    statement.isExported() ||
    declarationNames(statement).some((name) => localExports.has(name))

  const publicOwner = (specifier: string, line: number): void => {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(filename), specifier))
      .replace(/\.js$/, ".ts")

    const sourcePath = target.endsWith(".ts") ? target : `${target}.ts`

    if (!specifier.startsWith(".") || !publicSources.has(sourcePath)) {
      failures.push(`${filename}:${line}: reexport needs an inventoried public defining module: ${specifier}`)
    }
  }

  for (const statement of source.getExportDeclarations()) {
    const specifier = statement.getModuleSpecifierValue()

    if (specifier !== undefined) {
      publicOwner(specifier, statement.getStartLineNumber())
    } else {
      for (const exported of statement.getNamedExports()) {
        const localName = exported.getName()

        const owner = source.getImportDeclarations().find((imported) =>
          imported.getDefaultImport()?.getText() === localName ||
          imported.getNamespaceImport()?.getText() === localName ||
          imported.getNamedImports().some((named) => (named.getAliasNode()?.getText() ?? named.getName()) === localName)
        )

        if (owner !== undefined) {
          publicOwner(owner.getModuleSpecifierValue(), statement.getStartLineNumber())
        } else if (declarations.some((declaration) => declarationNames(declaration).includes(localName))) {
          localExports.add(localName)
        } else {
          failures.push(
            `${filename}:${statement.getStartLineNumber()}: export ${localName} needs a documented local owner`
          )
        }
      }
    }

    for (const exported of statement.getNamedExports()) {
      publicNames.add(exported.getAliasNode()?.getText() ?? exported.getName())
    }
  }

  for (const assignment of source.getExportAssignments()) {
    const value = assignment.getExpression()

    if (
      Node.isIdentifier(value) &&
      declarations.some((declaration) => declarationNames(declaration).includes(value.getText()))
    ) {
      localExports.add(value.getText())
      publicNames.add("default")
    } else {
      failures.push(
        `${filename}:${assignment.getStartLineNumber()}: default export needs a documented named declaration`
      )
    }
  }

  if (path.posix.basename(filename) === "index.ts") {
    for (const statement of source.getStatements()) {
      if (!Node.isExportDeclaration(statement)) {
        failures.push(`${filename}:${statement.getStartLineNumber()}: root barrels contain reexports only`)
      }
    }

    return failures
  }

  for (const statement of declarations) {
    if (
      !statement.isExported() ||
      statement.getJsDocs().some((doc) => doc.getTags().some((tag) => tag.getTagName() === "internal"))
    ) continue

    if (statement.isDefaultExport()) publicNames.add("default")
    else for (const name of declarationNames(statement)) publicNames.add(name)
  }

  for (const statement of declarations) {
    if (!isPublic(statement)) continue

    const docs = statement.getJsDocs()

    if (docs.some((doc) => doc.getTags().some((tag) => tag.getTagName() === "internal"))) continue

    const location = `${filename}:${statement.getStartLineNumber()}`
    const tags = docs.flatMap((doc) => doc.getTags())

    if (!docs.some((doc) => doc.getDescription().trim().length > 0)) {
      failures.push(`${location}: public declaration needs a description`)
    }

    for (const name of ["since", "category"]) {
      const matching = tags.filter((tag) => tag.getTagName() === name)

      if (matching.length !== 1 || (matching[0]?.getCommentText()?.trim().length ?? 0) === 0) {
        failures.push(`${location}: public declaration needs exactly one nonempty @${name}`)
      }
    }

    const stability = tags.filter((tag) => tag.getTagName() === "stability")

    if (
      stability.length > 1 ||
      stability.some((tag) => !["stable", "unstable", "experimental"].includes(tag.getCommentText()?.trim() ?? ""))
    ) {
      failures.push(`${location}: @stability must be stable, unstable, or experimental`)
    }

    const since = tags.find((tag) => tag.getTagName() === "since")?.getCommentText()?.trim()

    if (since !== undefined && !version.test(since)) {
      failures.push(`${location}: @since must be a stable major.minor.patch version`)
    }

    // Members inherit version and category metadata from their containing declaration.
    // Re-exports inherit documentation from their defining public module.
    for (const doc of docs) {
      for (const match of doc.getText().matchAll(/\{@link(?:code|plain)?\s+([^\s|}]+)/g)) {
        const target = match[1]!

        if (/^https?:\/\//.test(target)) {
          if (!URL.canParse(target)) failures.push(`${location}: invalid documentation URL ${target}`)
        } else if (!publicNames.has(target)) {
          failures.push(`${location}: documentation link ${target} does not name a public export in this module`)
        }
      }
    }
  }

  return failures
}

if (import.meta.main) {
  const root = path.resolve(import.meta.dirname, "../../..")
  const failures: Array<string> = []
  let modules = 0
  const workspaces = await validateInventory()

  const publicSources = new Set(
    workspaces.filter((workspace) => workspace.policy.kind === "library" && workspace.manifest.private !== true)
      .flatMap((workspace) => publicEntries(workspace).map((entry) => entry.source))
  )

  const exportedSources = new Set<string>()

  for (const workspace of workspaces) {
    if (workspace.policy.kind !== "library" || workspace.manifest.private === true) continue

    for (const entry of publicEntries(workspace)) {
      const text = await Bun.file(path.join(root, entry.source)).text()
      failures.push(...checkPublicSource(text, entry.source, publicSources))

      if (path.basename(entry.source) === "index.ts") continue
      exportedSources.add(entry.source)
      const moduleName = path.basename(entry.source, ".ts")

      const page = apiPages.find((candidate) =>
        candidate.packageDir === workspace.directory && candidate.moduleName === moduleName
      )

      if (page === undefined) failures.push(`${workspace.manifest.name}${entry.subpath.slice(1)}: missing API page`)
      modules += 1
    }
  }

  for (const page of apiPages) {
    if (!exportedSources.has(`${page.packageDir}/src/${page.moduleName}.ts`)) {
      failures.push(`${page.href}: API page does not correspond to an exported public module`)
    }
  }

  if (failures.length > 0) throw new Error(`Public documentation checks failed:\n${failures.join("\n")}`)
  console.log(`Public documentation contracts are valid for ${modules} exported modules.`)
}
