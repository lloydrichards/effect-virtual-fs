// Exploratory benchmark. Build packages/nfs first so dist/internal/xdr.js matches its source.
// Run: node apps/scratchpad/benchmarks/xdr-effect-benchmark.mjs
import { performance } from "node:perf_hooks"
import { ByteSize, Effect, Iterable, MutableRef } from "effect"
import { Reader as SyncReader, Writer as SyncWriter } from "../../../packages/nfs/dist/internal/xdr.js"
import { make, XdrCodec, XdrDecodeError } from "../src/xdr-effect-proposal.ts"

const limits = {
  maxOpaqueBytes: ByteSize.bytes(1024),
  maxStringBytes: ByteSize.bytes(256),
  maxArrayElements: 256
}

const words = 256

const wordBytes = new Uint8Array(words * 4).fill(1)

const rpcBytes = new SyncWriter()
  .uint32(7)
  .uint32(0)
  .uint32(2)
  .opaque(Uint8Array.of(1, 2, 3))
  .string("client")
  .array([10, 11, 12], (writer, value) => writer.uint32(value))
  .bytes()

const syncWords = () => {
  const reader = new SyncReader(wordBytes, limits)
  let sum = 0

  for (let index = 0; index < words; index++) sum += reader.uint32()
  reader.finish()

  return sum
}

const boundaryWords = () => Effect.runSync(Effect.sync(syncWords))

const coarseWords = () => Effect.runSync(Effect.try({
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

const stateWords = () => Effect.runSync(Effect.try({
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

const effectWords = () => Effect.runSync(make.decode(wordBytes, limits, wordCodec).pipe(Effect.map((values) => values.reduce((sum, value) => sum + value, 0))))

const mutableWords = () => Effect.runSync(Effect.gen(function*() {
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

const syncRpc = () => {
  const reader = new SyncReader(rpcBytes, limits)
  const xid = reader.uint32()
  reader.uint32()
  reader.uint32()
  const opaque = reader.opaque()
  const name = reader.string()
  const values = reader.array((item) => item.uint32())
  reader.finish()

  return xid + opaque.length + name.length + values.length
}

const boundaryRpc = () => Effect.runSync(Effect.sync(syncRpc))

const rpcCodec = XdrCodec.struct({
  xid: XdrCodec.uint32,
  messageType: XdrCodec.uint32,
  rpcVersion: XdrCodec.uint32,
  opaque: XdrCodec.opaque(),
  name: XdrCodec.string(),
  values: XdrCodec.array(XdrCodec.uint32)
})

const effectRpc = () => Effect.runSync(make.decode(rpcBytes, limits, rpcCodec).pipe(
  Effect.map((value) => value.xid + value.opaque.length + value.name.length + value.values.length)
))

const syncWrite = () => new SyncWriter().uint32(7).opaque(Uint8Array.of(1, 2, 3)).string("client").bytes().length

const boundaryWrite = () => Effect.runSync(Effect.sync(syncWrite))

const writeCodec = XdrCodec.struct({
  xid: XdrCodec.uint32,
  opaque: XdrCodec.opaque(),
  name: XdrCodec.string()
})

const writeValue = { xid: 7, opaque: Uint8Array.of(1, 2, 3), name: "client" }

const effectWrite = () => Effect.runSync(make.encode(writeValue, writeCodec).pipe(Effect.map((bytes) => bytes.length)))

const cases = [
  ["words/sync", syncWords],
  ["words/boundary", boundaryWords],
  ["words/coarse", coarseWords],
  ["words/state", stateWords],
  ["words/codec", effectWords],
  ["words/mutable", mutableWords],
  ["rpc/sync", syncRpc],
  ["rpc/boundary", boundaryRpc],
  ["rpc/codec", effectRpc],
  ["write/sync", syncWrite],
  ["write/boundary", boundaryWrite],
  ["write/codec", effectWrite]
]

const iterations = 1000

const rounds = 7

const samples = new Map(cases.map(([name]) => [name, []]))

let checksum = 0

for (const [, run] of cases) for (let n = 0; n < iterations; n++) checksum += run()

for (let round = 0; round < rounds; round++) {
  const ordered = round % 2 === 0 ? cases : [...cases].reverse()

  for (const [name, run] of ordered) {
    const start = performance.now()

    for (let n = 0; n < iterations; n++) checksum += run()
    samples.get(name).push(performance.now() - start)
  }
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

process.stdout.write(JSON.stringify({ runtime: process.version, iterations, rounds, words, checksum, mediansMs: Object.fromEntries(
  [...samples].map(([name, values]) => [name, Number(median(values).toFixed(2))])
) }, null, 2) + "\n")
