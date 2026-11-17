/** Each case runs with only its owning rule enabled, so unrelated diagnostics cannot hide a false positive. */
export const ruleCases = {
  "anti-slop/no-reduce-accumulator-copy": {
    valid: [
      "const result = [1, 2].reduce((acc, value) => { acc.push(value); return acc }, [])",
      "const result = [1, 2, 3].reduce((acc, value) => acc.slice(-1).concat(value), [])",
      "const result = [1, 2, 3].reduce((acc, value) => acc.concat(value).slice(-2), [])",
      "const result = source.reduce((acc, value) => acc.concat(value), [])",
      "declare const source: Array<number>; source.reduce((acc, value) => acc.concat(value), [])",
      "const source = { reduce: (step, initial) => step(initial, 1) }; source.reduce((acc, value) => acc.concat(value), [])",
      "const result = [1, 2].reduce((acc) => acc.concat(), [])",
      "const result = [1, 2].reduce((acc) => acc.concat([]), [])",
      "const result = [1, 2].reduce((acc, value) => acc.concat(...values), [])",
      "const result = [1, 2].reduce((acc, value) => acc.concat(value), shared)"
    ],
    invalid: [
      "const result = [1, 2].reduce((acc, value) => acc.concat(value), [])",
      "const source: ReadonlyArray<number> = [1, 2]; source.reduceRight((acc, value) => { return acc['concat']([value]) }, [])"
    ]
  },
  "anti-slop/no-chained-type-assertions": {
    valid: ["const result = value as Result", "const result = { value: 1 } as const"],
    invalid: ["const result = (value as unknown) as Result"]
  },
  "anti-slop/no-conditional-empty-object-spread": {
    valid: ["const result = { ...base, ...extra }"],
    invalid: ["const result = { ...(present ? { value: 1 } : {}) }"]
  },
  "anti-slop/no-known-value-widening": {
    valid: ["const value = { id: 1 } satisfies Item"],
    invalid: ["const value: unknown = { id: 1 }"]
  },
  "anti-slop/no-module-mocking": {
    valid: ["const vi = { mock: () => 1 }; vi.mock()", "import { vi } from 'vitest'; vi.fn()"],
    invalid: ["import { vi as test } from 'vitest'; test.mock('dependency')", "jest.mock('dependency')"]
  },
  "anti-slop/no-object-parameters": {
    valid: ["const read = (value: Item) => value.id"],
    invalid: ["const read = (value: object) => value", "type Input = object; const read = (value: Input) => value"]
  },
  "anti-slop/require-public-effect-fn-signature": {
    valid: [
      "const read: Read = Effect.fnUntraced(function*() { return 1 }); export default read",
      "export default Effect.fnUntraced(function*(id: string): Effect.fn.Return<number> { return id.length })",
      "const make = Effect.fnUntraced; export const read = make(function*(): Effect.fn.Return<number> { return 1 })",
      "const make = value => value; export const read = make(function*() { return 1 })",
      "const make = other; const other = make; export const read = make(function*() { return 1 })",
      "import * as Effect from 'effect/Effect'; const factory = Effect.fnUntraced; function unrelated(factory) { return factory }; export const read: Read = factory(function*() { return 1 })",
      "export const read: () => Effect.Effect<number> = Effect.fnUntraced(function*() { return 1 })",
      "export const read = Effect.fnUntraced(function*(id: string): Effect.fn.Return<number> { return id.length })",
      "export const read = Effect.fn('read')(function*(id: string): Effect.fn.Return<number> { return id.length })",
      "const read = Effect.fnUntraced(function*(): Effect.fn.Return<number> { return 1 }); export { read }",
      "const read: () => Effect.Effect<number> = Effect.fnUntraced(function*() { return 1 }); export { read }",
      "/** @internal */\nexport const read = Effect.fnUntraced(function*() { return 1 })",
      "/** @internal */\nconst read = Effect.fnUntraced(function*() { return 1 }); export { read }",
      "const Effect = { fnUntraced: value => value }; export const read = Effect.fnUntraced(function*() { return 1 })",
      "import * as E from 'effect/Effect'; export const read: Read = E.fnUntraced(function*() { return 1 })",
      "const privateRead = Effect.fnUntraced(function*() { return 1 }); export const read: Read = privateRead",
      "import { fnUntraced as make } from 'effect/Effect'; export const read = make(function*(): Effect.fn.Return<number> { return 1 })"
    ],
    invalid: [
      "export default Effect.fnUntraced(function*() { return 1 })",
      "const read = Effect.fnUntraced(function*() { return 1 }); export default read",
      "const make = Effect.fnUntraced; export const read = make(function*() { return 1 })",
      "const make = Effect.fnUntraced; const alias = make; export default alias(function*() { return 1 })",
      "import { fnUntraced } from 'effect/Effect'; const make = fnUntraced; export const read = make(function*() { return 1 })",
      "export const read = Effect.fn('read')(function*() { return 1 })",
      "export const read = Effect.fnUntraced(function*() { return 1 })",
      "const read = Effect.fnUntraced(function*() { return 1 }); export { read }",
      "const original = Effect.fnUntraced(function*() { return 1 }); export const read = original",
      "import * as E from 'effect/Effect'; export const read = E.fnUntraced(function*() { return 1 })",
      "import { fnUntraced as make } from 'effect/Effect'; export const read = make(function*() { return 1 })",
      "export const read = Effect.fnUntraced(function*(id): Effect.fn.Return<number> { return id.length })",
      "export const read = Effect.fnUntraced(function*() { return 1 }) satisfies Read",
      "export const read = Effect.fnUntraced(function*() { return 1 }, (effect: Effect.Effect<number>): Effect.Effect<number> => effect)"
    ]
  },
  "anti-slop/require-public-internal-alias-type": {
    valid: [
      "import * as Internal from './internal/model.js'; export const read: Read = Internal.read",
      "import * as Internal from './internal/model.js'; export const read: typeof Internal.read = Internal.read",
      "export type { Item } from './internal/model.js'",
      "export { type Item } from './internal/model.js'",
      "/** @internal */\nexport { read } from './internal/model.js'",
      "import { read } from './internal/model.js'; export { type read }",
      "import * as Public from './public.js'; export const read = Public.read"
    ],
    invalid: [
      "import * as Internal from './internal/model.js'; export const read = Internal.read",
      "import * as Internal from './internal/model.js'; const read = Internal.read; export { read }",
      "import { read } from './internal/model.js'; export { read }",
      "import * as Internal from './internal/model.js'; const original = Internal.read; export const read = original",
      "export { read } from './internal/model.js'",
      "export * from './internal/model.js'",
      "import * as Internal from './internal/model.js'; export const read = Internal.deep.read"
    ]
  },
  "anti-slop/no-reflect-apply": {
    valid: ["const result = operation(value)", "const Reflect = { apply: () => 1 }; Reflect.apply()"],
    invalid: ["Reflect.apply(operation, null, [value])"]
  },
  "anti-slop/no-runtime-typeof": {
    valid: ["const absent = typeof optionalBinding === 'undefined'", "type Value = typeof binding"],
    invalid: ["const isText = typeof value === 'string'"]
  },
  "anti-slop/no-unsafe-dictionary-type": {
    valid: ["type Items = Record<string, Item>"],
    invalid: ["type Items = Record<string, unknown>"]
  },
  "anti-slop/no-shape-in-symbol-names": {
    valid: ["interface Response { readonly id: number }"],
    invalid: ["interface ResponseShape { readonly id: number }"]
  },
  "anti-slop/no-unknown-parameters": {
    valid: ["const read = (value: Item) => value.id", "const isItem = (value: unknown): value is Item => true"],
    invalid: ["const read = (value: unknown) => value"]
  },
  "anti-slop/no-unknown-returns": {
    valid: ["const read = (): Item => item"],
    invalid: ["const read = (): unknown => item", "const read = (): Promise<unknown> => promise"]
  },
  "anti-slop/no-unknown-type-aliases": {
    valid: ["type Item = { readonly id: number }"],
    invalid: ["type Item = unknown"]
  },
  "anti-slop/no-widen-then-assert": {
    valid: ["const original = { id: 1 }; const result = original.id"],
    invalid: ["const broad: unknown = { id: 1 }; const result = broad as Item"]
  },
  "anti-slop/require-readable-spacing": {
    valid: ["const first = 1\n\nconst second = 2"],
    invalid: ["const first = 1\nconst second = 2"]
  },
  "anti-slop/require-safety-comment-for-type-assertion": {
    valid: [
      "// SAFETY: The schema has checked the item.\nconst item = value as Item",
      "const item = { id: 1 } as const"
    ],
    invalid: ["const item = value as Item", "// SAFETY:\nconst item = value as Item"]
  },
  "anti-slop-effect/no-manual-effect-error-tag": {
    valid: [
      "import { Effect } from 'effect'; Effect.catch(task, error => state.reason._tag === 'Closed' ? stop : fail(error))",
      "import { Effect } from 'effect'; function run(Effect) { return Effect.catch(task, error => error.reason._tag === 'Missing') }",
      "local.catch(task, error => error.reason._tag === 'Missing')",
      "import { Effect } from 'effect'; Effect.catch(task, error => { { const error = state; return error.reason._tag === 'Missing' } })",
      "import { Effect } from 'effect'; Effect.catch(task, error => error._tag === 'Missing' ? recovered : Effect.fail(error))"
    ],
    invalid: [
      "import { Effect as E } from 'effect'; E.catch(task, error => error.reason._tag === 'Missing' ? recovered : failed)",
      "import * as E from 'effect/Effect'; task.pipe(E.catch(error => error['reason']['_tag'] === 'Missing'))",
      "import { catch as catchError } from 'effect/Effect'; catchError(task, error => { switch (error.reason._tag) { case 'Missing': return recovered } })",
      "import * as Root from 'effect'; Root.Effect.catch(task, error => error.reason._tag === 'A' ? a : error.reason._tag === 'B' ? b : failed)"
    ]
  },
  "anti-slop-effect/no-manual-tag-comparison": {
    valid: [
      "Predicate.isTagged(value, 'Missing')",
      "import { Effect } from 'effect'; Effect.catch(task, error => state._tag === 'Closed' ? stop : Effect.fail(error))",
      "import { Effect as E } from 'effect'; E.catch(task, error => error._tag === 'Missing' ? recovered : E.fail(error))",
      "import * as E from 'effect/Effect'; E.catch(task, error => error.reason._tag === 'Missing' ? recovered : E.fail(error))"
    ],
    invalid: [
      "const missing = value._tag === 'Missing'",
      "const result = value._tag === 'First' ? 'one' : value._tag === 'Second' ? 'two' : 'other'",
      "import { Effect } from 'effect'; function run(Effect) { return Effect.catch(task, error => error._tag === 'Missing') }"
    ]
  },
  "anti-slop-effect/no-package-spans": {
    valid: [
      "import { Effect } from 'effect'; Effect.fn(function* () { return 1 })",
      "import { fn } from 'effect/Effect'; function* body() { return 1 } fn(body)",
      "import { Effect } from 'effect'; Effect.fnUntraced(function* () { return 1 })",
      "import { Effect } from 'effect'; export const tracing = Effect.withSpan",
      "import type * as Effect from 'effect/Effect'; export type Trace = typeof Effect.withSpan",
      "import { Effect } from 'effect'; function run(Effect: Logger) { Effect.withSpan('log'); Effect.fn('item') }",
      "import { withSpan } from 'effect/Stream'; function run(withSpan: Logger) { withSpan('log') }",
      "import { Effect } from 'another-library'; Effect.withSpan('log')",
      "const Effect = { withSpan: String, fn: String }; Effect.withSpan('log'); Effect.fn('item')",
      "const first = second; const second = first; first('item')"
    ],
    invalid: [
      "import { Effect } from 'effect'; Effect.fn('library.read')(function* () { return 1 })",
      "import * as FX from 'effect/Effect'; FX.fn(`library.${operation}`)",
      "import { fn as build } from 'effect/Effect'; const name = 'library.read'; build(name)",
      "import { Effect } from 'effect'; Effect.fn(cached ? 'library.cache' : 'library.read')",
      "import { fn as build } from 'effect/Effect'; function run(name: string) { return build(name) }",
      "import { Effect as Provider } from 'effect'; const E = Provider; const make = E.fn; make('library.read')",
      "import { Effect } from 'effect'; Effect.withSpan('library.read')",
      "import { withSpan as trace } from 'effect/Effect'; const wrap = trace; wrap(task, 'library.read')",
      "import * as FX from 'effect'; const { Effect: E } = FX; const { withSpan: trace } = E; trace('library.read')",
      "import { Stream } from 'effect'; task.pipe(Stream.withSpan('library.stream'))",
      "import * as S from 'effect/Stream'; S['withSpan']('library.stream')",
      "import { withSpan as trace } from 'effect/Stream'; trace('library.stream')"
    ]
  },
  "anti-slop-effect/no-manual-tagged-construction": {
    valid: [
      "const value = new Missing({ id: 1 })",
      "import { systemError as makeError } from 'effect/PlatformError'; const value = makeError({ _tag: 'BadResource' })",
      "import { PlatformError as P } from 'effect'; P.systemError({ _tag: 'BadResource' })",
      "import { Match as M } from 'effect'; M.when({ _tag: 'Missing' }, handler)",
      "import { when as matchWhen } from 'effect/Match'; matchWhen({ _tag: 'Missing' }, handler)",
      "import * as M from 'effect/Match'; M.not({ _tag: 'Missing' }, handler)"
    ],
    invalid: [
      "const value = { _tag: 'Missing', id: 1 }",
      "const Match = customMatch; Match.when({ _tag: 'Missing' }, handler)",
      "import { Match } from 'effect'; function run(Match) { Match.when({ _tag: 'Missing' }, handler) }",
      "import * as M from 'other/Match'; M.when({ _tag: 'Missing' }, handler)",
      "const systemError = makeObject; systemError({ _tag: 'BadResource' })",
      "other.systemError({ _tag: 'BadResource' })"
    ]
  }
}
