import type { ESTree, SourceCode } from "@oxlint/plugins"

import { arrayMethodTarget } from "../../shared/array-method.ts"
import { resolveVariable } from "../../shared/scope.ts"

const equalityOperators = new Set(["==", "===", "!=", "!=="])
const broadEffectCatchMethods = new Set(["catch", "catchAll", "catchIf"])

export const isStringLiteral = (
  node: ESTree.Node | null | undefined
): node is ESTree.StringLiteral => node?.type === "Literal" && typeof node.value === "string"

export const isTagMember = (
  node: ESTree.Node | null | undefined
): node is ESTree.MemberExpression =>
  node?.type === "MemberExpression" &&
  ((!node.computed &&
    node.property.type === "Identifier" &&
    node.property.name === "_tag") ||
    (node.computed &&
      isStringLiteral(node.property) &&
      node.property.value === "_tag"))

export const tagMemberFromComparison = (
  node: ESTree.BinaryExpression
): ESTree.MemberExpression | undefined => {
  if (!equalityOperators.has(node.operator)) return undefined
  if (isTagMember(node.left) && isStringLiteral(node.right)) return node.left
  if (isTagMember(node.right) && isStringLiteral(node.left)) return node.right
  return undefined
}

type EffectModule = "Effect" | "Match" | "PlatformError"

function imports(sourceCode: SourceCode, node: ESTree.Node, module: string, name?: string): boolean {
  if (node.type !== "Identifier") return false
  return resolveVariable(sourceCode, node)?.defs.some((definition) => {
    if (
      definition.type !== "ImportBinding" || definition.parent?.type !== "ImportDeclaration" ||
      definition.parent.importKind === "type" || definition.parent.source.value !== module
    ) return false

    return name === undefined
      ? definition.node.type === "ImportNamespaceSpecifier"
      : definition.node.type === "ImportSpecifier" && definition.node.importKind !== "type" &&
        (definition.node.imported.type === "Identifier"
          ? definition.node.imported.name === name
          : definition.node.imported.value === name)
  }) ?? false
}

function isModule(sourceCode: SourceCode, node: ESTree.Node, module: EffectModule): boolean {
  if (imports(sourceCode, node, "effect/" + module) || imports(sourceCode, node, "effect", module)) return true
  const member = arrayMethodTarget(node)
  return member?.name === module && imports(sourceCode, member.object, "effect")
}

function effectMethod(
  sourceCode: SourceCode,
  callee: ESTree.Node,
  module: EffectModule,
  names: Set<string>
): string | undefined {
  const member = arrayMethodTarget(callee)
  if (member !== null) {
    return names.has(member.name) && isModule(sourceCode, member.object, module)
      ? member.name
      : undefined
  }
  for (const name of names) if (imports(sourceCode, callee, "effect/" + module, name)) return name
  return undefined
}

export function broadEffectHandler(sourceCode: SourceCode, node: ESTree.Node) {
  let handler: ESTree.Node | null | undefined = node.parent
  while (handler && handler.type !== "ArrowFunctionExpression" && handler.type !== "FunctionExpression") {
    handler = handler.parent
  }
  const call = handler?.parent
  if (!handler || call?.type !== "CallExpression") return
  const index = call.arguments.indexOf(handler)
  const method = effectMethod(sourceCode, call.callee, "Effect", broadEffectCatchMethods)
  if (method === undefined || index < 0) return

  // Every inline function passed to catchIf is a predicate, recovery callback, or fallback.
  if (method !== "catchIf" && index !== call.arguments.length - 1) return
  return handler
}

export function isCaughtReasonTag(sourceCode: SourceCode, tag: ESTree.MemberExpression): boolean {
  const handler = broadEffectHandler(sourceCode, tag)
  const parameter = handler?.params[0]
  const reason = arrayMethodTarget(tag.object)
  if (parameter?.type !== "Identifier" || reason?.name !== "reason" || reason.object.type !== "Identifier") {
    return false
  }
  const binding = resolveVariable(sourceCode, reason.object)
  return binding?.defs.some((definition) => definition.type === "Parameter" && Object.is(definition.name, parameter)) ??
    false
}

/** Treat an alternate-chain with the same tag subject as one dispatch. */
export function isRepeatedTagTest(
  sourceCode: SourceCode,
  node: ESTree.BinaryExpression,
  tag: ESTree.MemberExpression
): boolean {
  const branch = node.parent
  const previous = branch?.parent
  if (
    branch?.type !== "ConditionalExpression" || branch.test !== node ||
    previous?.type !== "ConditionalExpression" || previous.alternate !== branch ||
    previous.test.type !== "BinaryExpression" || previous.test.operator === "in"
  ) return false
  const previousTag = tagMemberFromComparison(previous.test)
  return previousTag !== undefined && sourceCode.getText(previousTag.object) === sourceCode.getText(tag.object)
}

export const propertyName = (
  property: ESTree.ObjectProperty
): string | undefined => {
  if (!property.computed && property.key.type === "Identifier") {
    return property.key.name
  }
  if (
    property.key.type === "Literal" &&
    typeof property.key.value === "string"
  ) {
    return property.key.value
  }
  return undefined
}

const matchMethods = new Set(["when", "not"])
const systemErrorMethods = new Set(["systemError"])

export function isTaggedApiArgument(sourceCode: SourceCode, node: ESTree.ObjectExpression): boolean {
  const call = node.parent
  return call?.type === "CallExpression" && call.arguments[0] === node &&
    (effectMethod(sourceCode, call.callee, "Match", matchMethods) !== undefined ||
      effectMethod(sourceCode, call.callee, "PlatformError", systemErrorMethods) !== undefined)
}
