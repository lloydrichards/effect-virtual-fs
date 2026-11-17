import { defineRule } from "@oxlint/plugins"

import type { ESTree, SourceCode, Variable } from "@oxlint/plugins"

import { functionParameterTypeAnnotation } from "../shared/function-parameters.ts"
import { publicVariables, unwrapPublicExpression } from "../shared/public-variables.ts"
import { resolveVariable } from "../shared/scope.ts"

function isEffectNamespace(node: ESTree.Expression, sourceCode: SourceCode): boolean {
  if (node.type !== "Identifier") return false
  const binding = resolveVariable(sourceCode, node)
  if (binding === null || binding.defs.length === 0) return node.name === "Effect"
  return binding.defs.some((definition) => {
    if (definition.type !== "ImportBinding" || definition.parent?.type !== "ImportDeclaration") return false
    const source = definition.parent.source.value
    return (source === "effect/Effect" && definition.node.type === "ImportNamespaceSpecifier") ||
      (source === "effect" && definition.node.type === "ImportSpecifier" &&
        definition.node.imported.type === "Identifier" && definition.node.imported.name === "Effect")
  })
}

function isEffectFn(node: ESTree.Expression, sourceCode: SourceCode, seen = new Set<Variable>()): boolean {
  node = unwrapPublicExpression(node)
  if (node.type === "CallExpression") return isEffectFn(node.callee, sourceCode, seen)
  if (node.type === "MemberExpression") {
    return !node.computed && node.property.type === "Identifier" &&
      (node.property.name === "fn" || node.property.name === "fnUntraced") &&
      isEffectNamespace(node.object, sourceCode)
  }
  if (node.type !== "Identifier") return false
  const binding = resolveVariable(sourceCode, node)
  if (binding === null || seen.has(binding)) return false
  seen.add(binding)
  if (
    binding.defs.some((definition) =>
      definition.type === "ImportBinding" && definition.parent?.type === "ImportDeclaration" &&
      definition.parent.source.value === "effect/Effect" && definition.node.type === "ImportSpecifier" &&
      definition.node.imported.type === "Identifier" &&
      (definition.node.imported.name === "fn" || definition.node.imported.name === "fnUntraced")
    )
  ) return true
  if (binding.defs.length !== 1 || binding.references.some((reference) => reference.isWrite() && !reference.init)) {
    return false
  }
  const definition = binding.defs[0]
  return definition?.type === "Variable" && definition.node.type === "VariableDeclarator" &&
    definition.node.parent.type === "VariableDeclaration" && definition.node.parent.kind === "const" &&
    definition.node.init !== null && isEffectFn(definition.node.init, sourceCode, seen)
}

function hasGeneratorContract(node: ESTree.CallExpression): boolean {
  const argument = node.arguments[0]
  if (argument === undefined || argument.type === "SpreadElement") return false
  const fn = unwrapPublicExpression(argument)
  return (fn.type === "FunctionExpression" || fn.type === "ArrowFunctionExpression") &&
    fn.returnType !== undefined && fn.returnType !== null &&
    fn.params.every((parameter) => functionParameterTypeAnnotation(parameter) != null)
}

/** Require a readable contract for exported Effect.fn operations. */
export const requirePublicEffectFnSignatureRule = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Require explicit public signatures for exported Effect.fn operations." },
    messages: {
      missingSignature:
        "Exported Effect.fn operation needs an explicit function type or annotated generator inputs and return contract."
    }
  },
  createOnce(context) {
    return {
      "Program:exit"(program) {
        const { declarations, exports, defaults } = publicVariables(program, context.sourceCode)
        const check = (initial: ESTree.Expression, node: ESTree.Node) => {
          let value = unwrapPublicExpression(initial)
          const seen = new Set<ESTree.VariableDeclarator>()
          while (value.type === "Identifier") {
            const declaration = declarations.get(value.name)
            if (declaration === undefined || seen.has(declaration)) return
            seen.add(declaration)
            if (declaration.id.type !== "Identifier" || declaration.id.typeAnnotation || declaration.init === null) {
              return
            }
            value = unwrapPublicExpression(declaration.init)
          }
          if (
            value.type === "CallExpression" && isEffectFn(value.callee, context.sourceCode) &&
            !hasGeneratorContract(value)
          ) context.report({ node, messageId: "missingSignature" })
        }
        for (const { declaration, node } of exports) {
          if (declaration.id.type !== "Identifier" || declaration.id.typeAnnotation || declaration.init === null) {
            continue
          }
          check(declaration.init, node)
        }
        for (const { value, node } of defaults) check(value, node)
      }
    }
  }
})
