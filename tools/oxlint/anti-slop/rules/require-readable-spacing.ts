import type { CreateRule } from "@oxlint/plugins"

import createPaddingLineRule from "../vendor/eslint-stylistic/padding-line-between-statements.ts"

const screamingCaseConst =
  ":matches(VariableDeclaration[kind=\"const\"][declarations.length=1], ExportNamedDeclaration[declaration.kind=\"const\"][declaration.declarations.length=1]):has(VariableDeclarator[id.name=/^[A-Z][A-Z0-9_]*$/])"

const paddingRule = createPaddingLineRule([
  { blankLine: "always", prev: "import", next: "*" },
  { blankLine: "always", prev: "*", next: { selector: "Program > :not(ImportDeclaration)" } },
  { blankLine: "always", prev: { selector: "Program > :not(ImportDeclaration)" }, next: "*" },
  { blankLine: "always", prev: "*", next: ["function", "class", "interface", "type"] },
  { blankLine: "always", prev: ["function", "class", "interface", "type"], next: "*" },
  {
    blankLine: "always",
    prev: "*",
    next: ["multiline-const", "multiline-let", "multiline-var", "multiline-using"]
  },
  {
    blankLine: "always",
    prev: ["multiline-const", "multiline-let", "multiline-var", "multiline-using"],
    next: "*"
  },
  { blankLine: "always", prev: "*", next: ["return", "if", "switch", "try", "for", "while", "do"] },
  { blankLine: "always", prev: "block-like", next: "*" },
  { blankLine: "any", prev: "import", next: "import" },
  {
    blankLine: "any",
    prev: {
      selector: screamingCaseConst
    },
    next: {
      selector: screamingCaseConst
    }
  },
  {
    blankLine: "any",
    prev: {
      selector: ":matches(TSDeclareFunction, ExportNamedDeclaration[declaration.type=\"TSDeclareFunction\"])"
    },
    next: {
      selector:
        ":matches(TSDeclareFunction, FunctionDeclaration, ExportNamedDeclaration[declaration.type=\"TSDeclareFunction\"], ExportNamedDeclaration[declaration.type=\"FunctionDeclaration\"])"
    }
  }
])

/** Restore structural blank lines with whitespace-only fixes; keep local short bindings and overloads grouped. */
export const requireReadableSpacingRule: CreateRule = {
  ...paddingRule,
  meta: {
    ...paddingRule.meta,
    docs: {
      description: "Require readable spacing between declarations and logical statement groups."
    },
    schema: []
  }
}
