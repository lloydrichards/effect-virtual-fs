import { defineRule } from "@oxlint/plugins"
import type { ESTree } from "@oxlint/plugins"

function containsTopType(type: ESTree.TSType): boolean {
  if (type.type === "TSUnknownKeyword" || type.type === "TSAnyKeyword") return true
  if (type.type === "TSParenthesizedType") return containsTopType(type.typeAnnotation)
  return type.type === "TSUnionType" && type.types.some(containsTopType)
}

function directReturn(body: ESTree.BlockStatement | ESTree.Expression): ESTree.Expression | null {
  if (body.type !== "BlockStatement") return body
  const [statement] = body.body
  return body.body.length === 1 && statement?.type === "ReturnStatement" ? statement.argument : null
}

/** Flag direct pass-throughs for review without guessing which functions own parsing. */
export const noUnknownParametersRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description: "Review functions that return an explicitly unknown or any parameter unchanged."
    },
    messages: {
      unknownParameter:
        "This function returns `{{parameter}}` unchanged. Check which boundary owns validation and keep `unknown` for raw input."
    }
  },
  createOnce(context) {
    const checkParameters = (node: ESTree.ArrowFunctionExpression | ESTree.Function) => {
      if (node.body === null) return
      const returned = directReturn(node.body)
      if (returned?.type !== "Identifier") return

      for (const parameter of node.params) {
        if (parameter.type !== "Identifier" || parameter.name !== returned.name) continue
        const annotation = parameter.typeAnnotation
        if (annotation !== null && annotation !== undefined && containsTopType(annotation.typeAnnotation)) {
          context.report({
            node: annotation.typeAnnotation,
            messageId: "unknownParameter",
            data: { parameter: parameter.name }
          })
        }
      }
    }

    return {
      ArrowFunctionExpression: checkParameters,
      FunctionDeclaration: checkParameters,
      FunctionExpression: checkParameters
    }
  }
})
