import { defineRule } from "@oxlint/plugins"

import { isCaughtReasonTag, isRepeatedTagTest, isTagMember, tagMemberFromComparison } from "../shared/tagged-values.ts"

export const noManualEffectErrorTagRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Use Effect reason handlers instead of manually branching on a caught error reason."
    },
    messages: {
      reason:
        "Use Effect.catchReason or Effect.catchReasons instead of manually discriminating a tagged `reason` in a broad Effect catch handler."
    }
  },
  createOnce(context) {
    return {
      BinaryExpression(node) {
        const tagMember = tagMemberFromComparison(node)
        if (
          tagMember === undefined ||
          !isCaughtReasonTag(context.sourceCode, tagMember) ||
          isRepeatedTagTest(context.sourceCode, node, tagMember)
        ) {
          return
        }
        context.report({
          node,
          messageId: "reason"
        })
      },
      SwitchStatement(node) {
        if (
          !isTagMember(node.discriminant) ||
          !isCaughtReasonTag(context.sourceCode, node.discriminant)
        ) {
          return
        }
        context.report({
          node,
          messageId: "reason"
        })
      }
    }
  }
})
