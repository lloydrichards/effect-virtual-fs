import { defineRule } from "@oxlint/plugins"

import type { ESTree } from "@oxlint/plugins"

import { publicVariables, unwrapPublicExpression } from "../shared/public-variables.ts"

const internalPath = /(?:^|\/)internal(?:\/|$)/
const internalTag = /@internal\b/

/** Require explicit contracts for value aliases, including separately exported aliases. */
export const requirePublicInternalAliasTypeRule = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Require an explicit public type for exported values aliased from internal modules." },
    messages: {
      internalAlias: "Exported internal alias has an inferred type. Give it an explicit public signature.",
      internalReexport: "A value re-export from an internal module needs an explicit public declaration and type."
    }
  },
  createOnce(context) {
    return {
      "Program:exit"(program) {
        const internalImports = new Set<string>()
        for (const statement of program.body) {
          if (
            statement.type === "ImportDeclaration" && typeof statement.source.value === "string" &&
            internalPath.test(statement.source.value)
          ) {
            for (const specifier of statement.specifiers) internalImports.add(specifier.local.name)
          }
          if (
            (statement.type === "ExportNamedDeclaration" || statement.type === "ExportAllDeclaration") &&
            statement.exportKind !== "type" && statement.source !== null &&
            typeof statement.source.value === "string" && internalPath.test(statement.source.value) &&
            !context.sourceCode.getCommentsBefore(statement).some((comment) => internalTag.test(comment.value)) &&
            (statement.type === "ExportAllDeclaration" ||
              statement.specifiers.some((specifier) =>
                specifier.type !== "ExportSpecifier" || specifier.exportKind !== "type"
              ))
          ) context.report({ node: statement, messageId: "internalReexport" })
        }
        const { declarations, defaults, exports } = publicVariables(program, context.sourceCode)
        const checkAlias = (initial: ESTree.Expression, node: ESTree.Node) => {
          let value = unwrapPublicExpression(initial)
          const seen = new Set<ESTree.VariableDeclarator>()
          while (true) {
            while (value.type === "MemberExpression") value = unwrapPublicExpression(value.object)
            if (value.type !== "Identifier") return
            if (internalImports.has(value.name)) {
              context.report({ node, messageId: "internalAlias" })
              return
            }
            const declaration = declarations.get(value.name)
            if (
              declaration === undefined || seen.has(declaration) || declaration.id.type !== "Identifier" ||
              declaration.id.typeAnnotation || declaration.init === null
            ) return

            seen.add(declaration)
            value = unwrapPublicExpression(declaration.init)
          }
        }

        for (const { declaration, node } of exports) {
          if (declaration.id.type === "Identifier" && !declaration.id.typeAnnotation && declaration.init !== null) {
            checkAlias(declaration.init, node)
          }
        }

        for (const { value, node } of defaults) checkAlias(value, node)

        for (const statement of program.body) {
          if (
            statement.type !== "ExportNamedDeclaration" || statement.source !== null || statement.exportKind === "type"
          ) continue
          if (context.sourceCode.getCommentsBefore(statement).some((comment) => internalTag.test(comment.value))) {
            continue
          }
          for (const specifier of statement.specifiers) {
            if (
              specifier.type === "ExportSpecifier" && specifier.exportKind !== "type" &&
              specifier.local.type === "Identifier" && internalImports.has(specifier.local.name)
            ) {
              context.report({ node: specifier, messageId: "internalReexport" })
            }
          }
        }
      }
    }
  }
})
