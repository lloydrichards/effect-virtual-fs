// Vitest owns callback execution and timing.
/* oxlint-disable effecttsgo/async-function */
// Runtime execution is part of each codec measurement. Fixture encoding is outside timing.
import { ByteSize, Effect, Iterable, MutableRef } from "effect"
import { assert, test } from "vitest"
import { make as production, XdrCodec as ProductionCodec } from "../dist/internal/xdr.js"
import { xdrControls } from "./config.ts"
import { make, XdrCodec, XdrDecodeError } from "./xdr-effect-proposal.ts"

const limits = {
  maxOpaqueBytes: ByteSize.bytes(1024),
  maxStringBytes: ByteSize.bytes(256),
  maxArrayElements: 256
}

const words = 256

const wordBytes = new Uint8Array(words * 4).fill(1)

const productionRpcCodec = ProductionCodec.struct({
  xid: ProductionCodec.uint32,
  messageType: ProductionCodec.uint32,
  rpcVersion: ProductionCodec.uint32,
  opaque: ProductionCodec.opaque(),
  name: ProductionCodec.string(),
  values: ProductionCodec.array(ProductionCodec.uint32)
})

const rpcBytes = Effect.runSync(production.encode(
  {
    xid: 7,
    messageType: 0,
    rpcVersion: 2,
    opaque: Uint8Array.of(1, 2, 3),
    name: "client",
    values: [10, 11, 12]
  },
  productionRpcCodec,
  limits,
  1024
))

const productionWordCodec = ProductionCodec.fixedArray(ProductionCodec.uint32, words)

const productionWords = () =>
  Effect.runSync(
    production.decode(wordBytes, limits, productionWordCodec).pipe(
      Effect.map((values) => values.reduce((sum, value) => sum + value, 0))
    )
  )

const boundaryWords = () => Effect.runSync(Effect.sync(productionWords))

const coarseWords = () =>
  Effect.runSync(Effect.try({
    try: () => {
      const offset = MutableRef.make(0)
      const view = new DataView(wordBytes.buffer)
      let sum = 0

      for (let index = 0; index < words; index++) {
        const position = MutableRef.get(offset)

        if (position + 4 > wordBytes.length) throw new Error("Truncated XDR value")
        MutableRef.set(offset, position + 4)
        sum += view.getUint32(position)
      }

      return sum
    },
    catch: (error) => new XdrDecodeError({ detail: String(error) })
  }))

const stateWords = () =>
  Effect.runSync(Effect.try({
    try: () => {
      const view = new DataView(wordBytes.buffer)

      return Iterable.reduce(Iterable.range(0, words - 1), { offset: 0, sum: 0 }, (state) => {
        if (state.offset + 4 > wordBytes.length) throw new Error("Truncated XDR value")

        return { offset: state.offset + 4, sum: state.sum + view.getUint32(state.offset) }
      }).sum
    },
    catch: (error) => new XdrDecodeError({ detail: String(error) })
  }))

const wordCodec = XdrCodec.fixedArray(XdrCodec.uint32, words)

const effectWords = () =>
  Effect.runSync(
    make.decode(wordBytes, limits, wordCodec).pipe(
      Effect.map((values) => values.reduce((sum, value) => sum + value, 0))
    )
  )

const mutableWords = () =>
  Effect.runSync(Effect.gen(function*() {
    const offset = MutableRef.make(0)
    const view = new DataView(wordBytes.buffer)

    const uint32 = Effect.try({
      try: () => {
        const position = MutableRef.get(offset)

        if (position + 4 > wordBytes.length) throw new Error("Truncated XDR value")
        MutableRef.set(offset, position + 4)

        return view.getUint32(position)
      },
      catch: (error) => new XdrDecodeError({ detail: String(error) })
    })

    let sum = 0

    for (let index = 0; index < words; index++) sum += yield* uint32

    return sum
  }))

const productionRpc = () =>
  Effect.runSync(
    production.decode(rpcBytes, limits, productionRpcCodec).pipe(
      Effect.map((value) => value.xid + value.opaque.length + value.name.length + value.values.length)
    )
  )

const boundaryRpc = () => Effect.runSync(Effect.sync(productionRpc))

const rpcCodec = XdrCodec.struct({
  xid: XdrCodec.uint32,
  messageType: XdrCodec.uint32,
  rpcVersion: XdrCodec.uint32,
  opaque: XdrCodec.opaque(),
  name: XdrCodec.string(),
  values: XdrCodec.array(XdrCodec.uint32)
})

const effectRpc = () =>
  Effect.runSync(
    make.decode(rpcBytes, limits, rpcCodec).pipe(
      Effect.map((value) => value.xid + value.opaque.length + value.name.length + value.values.length)
    )
  )

const productionWriteCodec = ProductionCodec.struct({
  xid: ProductionCodec.uint32,
  opaque: ProductionCodec.opaque(),
  name: ProductionCodec.string()
})

const productionWrite = () =>
  Effect.runSync(
    production.encode(writeValue, productionWriteCodec, limits, 1024).pipe(
      Effect.map((bytes) => bytes.length)
    )
  )

const boundaryWrite = () => Effect.runSync(Effect.sync(productionWrite))

const writeCodec = XdrCodec.struct({
  xid: XdrCodec.uint32,
  opaque: XdrCodec.opaque(),
  name: XdrCodec.string()
})

const writeValue = { xid: 7, opaque: Uint8Array.of(1, 2, 3), name: "client" }

assert.deepStrictEqual(
  Effect.runSync(make.encode(writeValue, writeCodec)),
  Effect.runSync(production.encode(writeValue, productionWriteCodec, limits, 1024))
)

const effectWrite = () => Effect.runSync(make.encode(writeValue, writeCodec).pipe(Effect.map((bytes) => bytes.length)))

const cases: ReadonlyArray<readonly [string, () => number]> = [
  ["words/production", productionWords],
  ["words/production-wrapped", boundaryWords],
  ["words/coarse", coarseWords],
  ["words/state", stateWords],
  ["words/codec", effectWords],
  ["words/mutable", mutableWords],
  ["rpc/production", productionRpc],
  ["rpc/production-wrapped", boundaryRpc],
  ["rpc/codec", effectRpc],
  ["write/production", productionWrite],
  ["write/production-wrapped", boundaryWrite],
  ["write/codec", effectWrite]
]

const controls = Effect.runSync(xdrControls)

for (const prefix of ["words", "rpc", "write"]) {
  test(`${prefix}: equivalent codecs`, async ({ bench }) => {
    const group = cases.filter(([name]) => name.startsWith(`${prefix}/`))
    const expected = group[0]![1]()

    for (const [, run] of group) assert.strictEqual(run(), expected)

    for (let round = 0; round < controls.rounds; round++) {
      const ordered = round % 2 === 0 ? group : [...group].reverse()
      await bench.compare(
        ...ordered.map(([name, run]) =>
          bench(`${name}/round-${round + 1}`, () => {
            assert.strictEqual(run(), expected)
          })
        ),
        { time: controls.time, iterations: controls.iterations }
      )
    }
  })
}
