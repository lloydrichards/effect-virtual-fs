import { defineRule } from "@oxlint/plugins"

import type { ESTree } from "@oxlint/plugins"
import { isMatchPatternObject, isStringLiteral, propertyName } from "../shared/tagged-values.ts"

function isSystemErrorOptions(node: ESTree.ObjectExpression): boolean {
  const parent = node.parent
  if (parent.type !== "CallExpression" || !parent.arguments.includes(node)) return false
  const callee = parent.callee
  return (
    (callee.type === "Identifier" && callee.name === "systemError") ||
    (callee.type === "MemberExpression" &&
      !callee.computed &&
      callee.property.type === "Identifier" &&
      callee.property.name === "systemError")
  )
}

export const noManualTaggedConstructionRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Construct tagged values with their existing Effect constructor instead of writing `_tag` manually."
    },
    messages: {
      manualConstruction:
        "Use the existing Schema tagged `.make`, tagged class/error constructor, or Data.taggedEnum variant constructor instead of writing a literal `_tag` object."
    }
  },
  createOnce(context) {
    return {
      ObjectExpression(node) {
        if (isMatchPatternObject(node) || isSystemErrorOptions(node)) return
        const tag = node.properties.find(
          (property) =>
            property.type === "Property" &&
            propertyName(property) === "_tag" &&
            isStringLiteral(property.value)
        )
        if (tag !== undefined) {
          context.report({ node: tag, messageId: "manualConstruction" })
        }
      }
    }
  }
})
