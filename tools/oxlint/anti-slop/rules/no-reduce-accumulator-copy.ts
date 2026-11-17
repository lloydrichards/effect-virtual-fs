import { defineRule } from "@oxlint/plugins"
import type { ESTree } from "@oxlint/plugins"

import {
  arrayMethodTarget,
  isKnownArrayExpression,
  resolveArrayBinding,
  unwrapArrayExpression
} from "../shared/array-method.ts"

function returnedExpression(body: ESTree.BlockStatement | ESTree.Expression): ESTree.Expression | null {
  if (body.type !== "BlockStatement") return body
  const statement = body.body[0]
  return body.body.length === 1 && statement?.type === "ReturnStatement" ? statement.argument : null
}

/** Report a direct concat of new values into a fresh array accumulator. */
export const noReduceAccumulatorCopyRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow returning a concatenated array accumulator when each iteration can grow it."
    },
    messages: {
      accumulatorCopy:
        "Returning a copy of a growing array accumulator can cause quadratic work. Consider pushing onto the fresh accumulator and returning it."
    }
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        const reducer = arrayMethodTarget(node.callee)
        if (reducer === null || (reducer.name !== "reduce" && reducer.name !== "reduceRight")) return
        const [callbackArgument, initialValue] = node.arguments
        if (callbackArgument === undefined || initialValue === undefined || node.arguments.length !== 2) return
        if (unwrapArrayExpression(initialValue).type !== "ArrayExpression") return
        if (!isKnownArrayExpression(context.sourceCode, reducer.object)) return

        const callback = unwrapArrayExpression(callbackArgument)
        if (callback.type !== "ArrowFunctionExpression" && callback.type !== "FunctionExpression") return
        const accumulator = callback.params[0]
        if (accumulator?.type !== "Identifier" || callback.body === null) return
        const returned = returnedExpression(callback.body)
        if (returned === null) return
        const copy = unwrapArrayExpression(returned)
        if (copy.type !== "CallExpression") return
        const concat = arrayMethodTarget(copy.callee)
        if (concat?.name !== "concat") return
        const accumulatorBinding = resolveArrayBinding(context.sourceCode, accumulator)
        if (
          accumulatorBinding === null || resolveArrayBinding(context.sourceCode, concat.object) !== accumulatorBinding
        ) {
          return
        }

        const appendsValues = copy.arguments.some((argument) => {
          const value = unwrapArrayExpression(argument)
          return value.type !== "SpreadElement" &&
            (value.type !== "ArrayExpression" ||
              value.elements.some((element) => element === null || element.type !== "SpreadElement"))
        })
        if (appendsValues) context.report({ node: copy, messageId: "accumulatorCopy" })
      }
    }
  }
})
