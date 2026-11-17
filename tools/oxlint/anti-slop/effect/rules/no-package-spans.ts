import { defineRule } from "@oxlint/plugins"

import type { ESTree, SourceCode, Variable } from "@oxlint/plugins"

import { unwrapPublicExpression } from "../../shared/public-variables.ts"
import { resolveVariable } from "../../shared/scope.ts"

type EffectBinding = "root" | "Effect" | "Stream" | "fn" | "withSpan"

function propertyName(node: ESTree.Node, computed: boolean): string | undefined {
  if (!computed && node.type === "Identifier") return node.name
  if (node.type === "Literal" && typeof node.value === "string") return node.value
}

function memberBinding(owner: EffectBinding | undefined, name: string | undefined): EffectBinding | undefined {
  if (owner === "root" && (name === "Effect" || name === "Stream")) return name
  if (owner === "Effect" && name === "fn") return name
  if ((owner === "Effect" || owner === "Stream") && name === "withSpan") return name
}

function importBinding(definition: Variable["defs"][number]): EffectBinding | undefined {
  const { node, parent } = definition
  if (parent?.type !== "ImportDeclaration" || parent.importKind === "type") return

  const source = parent.source.value
  const owner = source === "effect" ? "root" : source === "effect/Effect" ? "Effect" : source === "effect/Stream" ?
    "Stream" :
    undefined

  if (node.type === "ImportNamespaceSpecifier") return owner
  if (node.type === "ImportSpecifier" && node.importKind !== "type") {
    return memberBinding(owner, propertyName(node.imported, false))
  }
}

function constInitializer(definition: Variable["defs"][number] | undefined) {
  if (definition?.type !== "Variable" || definition.node.type !== "VariableDeclarator") return
  const node = definition.node
  if (node.parent.type === "VariableDeclaration" && node.parent.kind === "const" && node.init !== null) {
    return { pattern: node.id, value: node.init }
  }
}

function effectBinding(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
  visited = new Set<Variable>()
): EffectBinding | undefined {
  const node = unwrapPublicExpression(expression)
  if (node.type === "MemberExpression" && node.object.type !== "Super") {
    return memberBinding(effectBinding(sourceCode, node.object, visited), propertyName(node.property, node.computed))
  }
  if (node.type !== "Identifier") return

  const variable = resolveVariable(sourceCode, node)
  if (variable === null || variable.defs.length !== 1 || visited.has(variable)) return
  visited.add(variable)

  const definition = variable.defs[0]
  if (definition?.type === "ImportBinding") return importBinding(definition)
  const alias = constInitializer(definition)
  if (alias === undefined) return

  const owner = effectBinding(sourceCode, alias.value, visited)
  if (alias.pattern.type === "Identifier") return owner
  if (alias.pattern.type === "ObjectPattern") {
    const property = alias.pattern.properties.find((candidate) =>
      candidate.type === "Property" && candidate.value.type === "Identifier" && candidate.value.name === variable.name
    )
    if (property?.type === "Property") return memberBinding(owner, propertyName(property.key, property.computed))
  }
}

function isSpanName(sourceCode: SourceCode, expression: ESTree.Expression, visited = new Set<Variable>()): boolean {
  if (
    (expression.type === "TSAsExpression" || expression.type === "TSTypeAssertion") &&
    expression.typeAnnotation.type === "TSStringKeyword"
  ) return true
  const node = unwrapPublicExpression(expression)
  if (node.type === "TemplateLiteral" || (node.type === "Literal" && typeof node.value === "string")) return true
  if (node.type === "BinaryExpression" && node.operator === "+") {
    return isSpanName(sourceCode, node.left, new Set(visited)) || isSpanName(sourceCode, node.right, visited)
  }
  if (node.type === "ConditionalExpression") {
    return isSpanName(sourceCode, node.consequent, new Set(visited)) && isSpanName(sourceCode, node.alternate, visited)
  }
  if (node.type !== "Identifier") return false
  const variable = resolveVariable(sourceCode, node)
  if (variable === null || variable.defs.length !== 1 || visited.has(variable)) return false
  visited.add(variable)
  if (
    variable.identifiers.some((id) =>
      id.type === "Identifier" && id.typeAnnotation?.typeAnnotation.type === "TSStringKeyword"
    )
  ) return true
  const alias = constInitializer(variable.defs[0])
  return alias?.pattern.type === "Identifier" && isSpanName(sourceCode, alias.value, visited)
}

export const noPackageSpansRule = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Leave tracing spans to applications that consume the library." },
    messages: {
      namedFn: "Use Effect.fnUntraced for library operations. The consuming application owns tracing spans.",
      withSpan: "Create the span in the consuming application."
    }
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        const binding = effectBinding(context.sourceCode, node.callee)
        if (binding === "withSpan") context.report({ node, messageId: "withSpan" })
        const name = node.arguments[0]
        if (
          binding === "fn" && name !== undefined && name.type !== "SpreadElement" &&
          isSpanName(context.sourceCode, name)
        ) {
          context.report({ node, messageId: "namedFn" })
        }
      }
    }
  }
})
