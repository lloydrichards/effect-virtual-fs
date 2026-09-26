// Synchronous HMAC keeps reference-key methods free of Crypto service requirements.

const BLOCK_BYTES = 64

const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98,
  0x71374491,
  0xb5c0fbcf,
  0xe9b5dba5,
  0x3956c25b,
  0x59f111f1,
  0x923f82a4,
  0xab1c5ed5,
  0xd807aa98,
  0x12835b01,
  0x243185be,
  0x550c7dc3,
  0x72be5d74,
  0x80deb1fe,
  0x9bdc06a7,
  0xc19bf174,
  0xe49b69c1,
  0xefbe4786,
  0x0fc19dc6,
  0x240ca1cc,
  0x2de92c6f,
  0x4a7484aa,
  0x5cb0a9dc,
  0x76f988da,
  0x983e5152,
  0xa831c66d,
  0xb00327c8,
  0xbf597fc7,
  0xc6e00bf3,
  0xd5a79147,
  0x06ca6351,
  0x14292967,
  0x27b70a85,
  0x2e1b2138,
  0x4d2c6dfc,
  0x53380d13,
  0x650a7354,
  0x766a0abb,
  0x81c2c92e,
  0x92722c85,
  0xa2bfe8a1,
  0xa81a664b,
  0xc24b8b70,
  0xc76c51a3,
  0xd192e819,
  0xd6990624,
  0xf40e3585,
  0x106aa070,
  0x19a4c116,
  0x1e376c08,
  0x2748774c,
  0x34b0bcb5,
  0x391c0cb3,
  0x4ed8aa4a,
  0x5b9cca4f,
  0x682e6ff3,
  0x748f82ee,
  0x78a5636f,
  0x84c87814,
  0x8cc70208,
  0x90befffa,
  0xa4506ceb,
  0xbef9a3f7,
  0xc67178f2
])

const INITIAL_STATE = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]

const rotr = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits))

const sha256 = (message: Uint8Array): Uint8Array => {
  const padded = new Uint8Array(Math.ceil((message.length + 9) / BLOCK_BYTES) * BLOCK_BYTES)
  padded.set(message)
  padded[message.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setBigUint64(padded.length - 8, BigInt(message.length) * 8n)

  const state = Int32Array.from(INITIAL_STATE)
  const schedule = new Uint32Array(64)

  for (let block = 0; block < padded.length; block += BLOCK_BYTES) {
    for (let t = 0; t < 16; t++) schedule[t] = view.getUint32(block + t * 4)

    for (let t = 16; t < 64; t++) {
      const w15 = schedule[t - 15]!
      const w2 = schedule[t - 2]!
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)
      schedule[t] = (schedule[t - 16]! + s0 + schedule[t - 7]! + s1) | 0
    }

    let a = state[0]!
    let b = state[1]!
    let c = state[2]!
    let d = state[3]!
    let e = state[4]!
    let f = state[5]!
    let g = state[6]!
    let h = state[7]!

    for (let t = 0; t < 64; t++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + ROUND_CONSTANTS[t]!
        + schedule[t]!) | 0

      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0

      h = g
      g = f
      f = e
      e = (d + t1) | 0
      d = c
      c = b
      b = a
      a = (t1 + t2) | 0
    }

    state.set([
      state[0]! + a,
      state[1]! + b,
      state[2]! + c,
      state[3]! + d,
      state[4]! + e,
      state[5]! + f,
      state[6]! + g,
      state[7]! + h
    ])
  }

  const digest = new Uint8Array(32)
  const out = new DataView(digest.buffer)

  for (let word = 0; word < 8; word++) out.setUint32(word * 4, state[word]!)

  return digest
}

const concat = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  const joined = new Uint8Array(left.length + right.length)
  joined.set(left)
  joined.set(right, left.length)

  return joined
}

/** @internal */
export const hmacSha256 = (key: Uint8Array, message: Uint8Array): Uint8Array => {
  const block = new Uint8Array(BLOCK_BYTES)
  block.set(key.length > BLOCK_BYTES ? sha256(key) : key)
  const inner = block.map((byte) => byte ^ 0x36)
  const outer = block.map((byte) => byte ^ 0x5c)

  return sha256(concat(outer, sha256(concat(inner, message))))
}

// Compare every byte regardless of the first difference to avoid leaking a matching prefix.
/** @internal */
export const sameTag = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.length !== right.length) return false

  let difference = 0

  for (let index = 0; index < left.length; index++) difference |= left[index]! ^ right[index]!

  return difference === 0
}
