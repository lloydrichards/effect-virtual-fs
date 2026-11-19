import { assert, it } from "@effect/vitest"
import * as Root from "../src/index.js"
import * as Server from "../src/NfsServer.js"

it("exports the NfsServer module through the package root", () => {
  assert.deepStrictEqual({ ...Root }, { ...Server })
})
