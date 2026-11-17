import { strict as assert } from "node:assert"

import { lintRootFixtures } from "./root-fixtures.mjs"

export async function checkSuppressionIntegration() {
  const consoleCall = "console.log(\"fixture\")\n"

  const suppression = "// oxlint-disable-next-line eslint/no-console -- Exercise suppression policy.\n"

  // Test paths allow console under the ESLint rule. Native Effect lint still reports it.
  const nativeSuppression =
    "// oxlint-disable-next-line effecttsgo/global-console -- Exercise the test path override.\n"

  const usedSuppression =
    "// oxlint-disable-next-line eslint/no-console, effecttsgo/global-console -- Exercise an active suppression.\n"

  const { diagnostics, participants } = await lintRootFixtures({
    "packages/core/src/console.ts": consoleCall,
    "packages/core/src/stale.ts": suppression + "export const value = 1\n",
    "packages/core/src/suppressed.ts": usedSuppression + consoleCall,
    "packages/core/test/console.test.ts": nativeSuppression + consoleCall,
    "tools/checks/redundant.mjs": suppression + consoleCall,
    "packages/effect-preview/src/fixture.ts": consoleCall
  })

  assert.deepEqual(participants, [
    "packages/core/src/console.ts",
    "packages/core/src/stale.ts",
    "packages/core/src/suppressed.ts",
    "packages/core/test/console.test.ts",
    "tools/checks/redundant.mjs"
  ])

  // The pinned Oxlint JSON report has no rule code for unused directives.
  assert.deepEqual(
    diagnostics.map(({ code, filename, message, severity }) =>
      [filename, severity, code ?? message.split(" (")[0]].join(": ")
    ).sort(),
    [
      "packages/core/src/console.ts: error: eslint(no-console)",
      "packages/core/src/console.ts: warning: effecttsgo(global-console)",
      "packages/core/src/stale.ts: error: Unused oxlint-disable directive",
      "tools/checks/redundant.mjs: error: Unused oxlint-disable directive"
    ]
  )
}
