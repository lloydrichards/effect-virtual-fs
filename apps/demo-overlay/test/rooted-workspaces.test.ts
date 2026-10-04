import { BytePath } from "@effect-vfs/core"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { assert, it } from "@effect/vitest"
import { Effect, Option, Result } from "effect"
import { rootedWorkspaces } from "../src/rooted-workspaces.js"

it.effect("shows only rebased project events and retains reads after root rename", () =>
  Effect.gen(function*() {
    const result = yield* rootedWorkspaces()
    assert.deepStrictEqual(
      result.events.map((event) => ({
        kind: event._tag,
        path: Option.getOrThrow(BytePath.toStringOption(event.path))
      })),
      [{ kind: "Create", path: "/plan.md" }]
    )
    assert.strictEqual(result.content, "Release on Friday.")
    assert.isTrue(Result.isFailure(result.sibling))

    if (Result.isFailure(result.sibling)) assert.strictEqual(result.sibling.failure.code, "NotFound")
  }).pipe(Effect.provide(BunCrypto.layer)))
