import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { it as baseIt } from "@effect/vitest"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import type * as Scope from "effect/Scope"
import type { TestContext, TestOptions } from "vitest"

const effect = <A, E>(
  name: string,
  body: (context: TestContext) => Effect.Effect<A, E, Scope.Scope | Crypto.Crypto>,
  options?: number | TestOptions
): void => baseIt.effect(name, (context) => body(context).pipe(Effect.provide(BunCrypto.layer)), options)

export const it = { effect }
