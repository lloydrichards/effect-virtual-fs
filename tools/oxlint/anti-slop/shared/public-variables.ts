import type { ESTree, SourceCode } from "@oxlint/plugins"

const internalTag = /@internal\b/

/** Collect local value declarations exported inline or through an export list. */
export function publicVariables(program: ESTree.Program, sourceCode: SourceCode) {
  const declarations = new Map<string, ESTree.VariableDeclarator>()
  const exports: Array<{ declaration: ESTree.VariableDeclarator; node: ESTree.Node }> = []
  const defaults: Array<{ value: ESTree.Expression; node: ESTree.Node }> = []
  const isInternal = (node: ESTree.Node) =>
    sourceCode.getCommentsBefore(node).some((comment) => internalTag.test(comment.value))

  for (const statement of program.body) {
    const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement
    if (declaration?.type !== "VariableDeclaration") continue
    for (const binding of declaration.declarations) {
      if (binding.id.type === "Identifier") declarations.set(binding.id.name, binding)
    }
  }

  for (const statement of program.body) {
    if (statement.type === "ExportDefaultDeclaration" && !isInternal(statement)) {
      if (
        statement.declaration.type !== "FunctionDeclaration" && statement.declaration.type !== "ClassDeclaration" &&
        statement.declaration.type !== "TSInterfaceDeclaration"
      ) defaults.push({ value: statement.declaration, node: statement })
      continue
    }
    if (statement.type !== "ExportNamedDeclaration" || statement.exportKind === "type" || isInternal(statement)) {
      continue
    }
    if (statement.declaration?.type === "VariableDeclaration") {
      if (isInternal(statement.declaration)) continue
      for (const declaration of statement.declaration.declarations) {
        exports.push({ declaration, node: declaration.id })
      }
    } else if (statement.source === null) {
      for (const specifier of statement.specifiers) {
        if (
          specifier.type !== "ExportSpecifier" || specifier.exportKind === "type" ||
          specifier.local.type !== "Identifier"
        ) continue
        const declaration = declarations.get(specifier.local.name)
        if (declaration !== undefined && !isInternal(declaration.parent)) {
          exports.push({ declaration, node: specifier })
        }
      }
    }
  }

  return { declarations, exports, defaults }
}

/** Strip expression wrappers without treating an assertion as a public declaration contract. */
export function unwrapPublicExpression(node: ESTree.Expression): ESTree.Expression {
  while (
    node.type === "ParenthesizedExpression" || node.type === "TSAsExpression" ||
    node.type === "TSTypeAssertion" || node.type === "TSSatisfiesExpression" || node.type === "TSNonNullExpression"
  ) node = node.expression
  return node
}
