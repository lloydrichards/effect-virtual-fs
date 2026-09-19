import { defineRule } from "@oxlint/plugins"

import type { ESTree } from "@oxlint/plugins"

const internalTag = /@internal\b/

/** Keep inferred internal implementation names out of published declarations. */
export const requirePublicInternalAliasTypeRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Require a public type for exported values aliased from internal modules."
    },
    messages: {
      internalAlias:
        "Exported internal alias has an inferred type. Give it a public signature that does not name the internal module."
    }
  },
  createOnce(context) {
    const internalImports = new Set<string>()

    return {
      Program(node) {
        for (const statement of node.body) {
          if (statement.type !== "ImportDeclaration") continue
          if (typeof statement.source.value !== "string" || !statement.source.value.includes("/internal/")) continue
          for (const specifier of statement.specifiers) internalImports.add(specifier.local.name)
        }
      },
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
          const value = declaration.init
          const source = value.type === "MemberExpression" ? value.object : value
          if (source.type === "Identifier" && internalImports.has(source.name)) {
            context.report({ node: declaration.id, messageId: "internalAlias" })
          }
        }
      }
    }
  }
})
