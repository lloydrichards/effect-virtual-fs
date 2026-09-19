import { defineRule } from "@oxlint/plugins"

import type { ESTree } from "@oxlint/plugins"

const internalTag = /@internal\b/

function isEffectFn(node: ESTree.Node): boolean {
  if (node.type !== "CallExpression" || node.callee.type !== "CallExpression") return false
  const fn = node.callee.callee
  return fn.type === "MemberExpression" &&
    !fn.computed &&
    fn.object.type === "Identifier" &&
    fn.object.name === "Effect" &&
    fn.property.type === "Identifier" &&
    (fn.property.name === "fn" || fn.property.name === "fnUntraced")
}

/** Require a readable contract for exported Effect.fn operations. */
export const requirePublicEffectFnSignatureRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Require explicit public signatures for exported Effect.fn operations."
    },
    messages: {
      missingSignature:
        "Exported Effect.fn operation needs an explicit function type showing its inputs, result, failures, and services."
    }
  },
  createOnce(context) {
    return {
      ExportNamedDeclaration(node) {
        if (node.declaration?.type !== "VariableDeclaration") return
        const comments = [
          ...context.sourceCode.getCommentsBefore(node),
          ...context.sourceCode.getCommentsBefore(node.declaration)
        ]
        if (comments.some((comment) => internalTag.test(comment.value))) return

        for (const declaration of node.declaration.declarations) {
          if (declaration.id.type !== "Identifier" || declaration.id.typeAnnotation || declaration.init === null) {
            continue
          }
          if (isEffectFn(declaration.init)) {
            context.report({ node: declaration.id, messageId: "missingSignature" })
          }
        }
      }
    }
  }
})
