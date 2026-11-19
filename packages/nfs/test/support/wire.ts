// The client fixture encodes wire fields independently of the server codecs.
import * as Effect from "effect/Effect"

interface Cursor {
  readonly take: (size: number) => Buffer
}

interface Codec<A> {
  readonly encode: (value: A) => Buffer
  readonly decode: (cursor: Cursor) => A
}

const uint32: Codec<number> = {
  encode(value) {
    const word = Buffer.alloc(4)
    word.writeUInt32BE(value)

    return word
  },
  decode: (cursor) => cursor.take(4).readUInt32BE()
}

const uint64: Codec<bigint> = {
  encode(value) {
    const word = Buffer.alloc(8)
    word.writeBigUInt64BE(value)

    return word
  },
  decode: (cursor) => cursor.take(8).readBigUInt64BE()
}

const fixedOpaque = (size: number): Codec<Uint8Array> => {
  const aligned = Math.ceil(size / 4) * 4

  return {
    encode(value) {
      if (value.length !== size) throw new RangeError("Invalid fixture field width")

      return Buffer.concat([value, Buffer.alloc(aligned - size)])
    },
    decode: (cursor) => new Uint8Array(cursor.take(aligned).subarray(0, size))
  }
}

const opaque = (): Codec<Uint8Array> => ({
  encode: (value) => Buffer.concat([uint32.encode(value.length), fixedOpaque(value.length).encode(value)]),
  decode: (cursor) => fixedOpaque(uint32.decode(cursor)).decode(cursor)
})

export const Xdr = {
  uint32,
  uint64,
  fixedOpaque,
  opaque,
  boolean: {
    encode: (value: boolean) => uint32.encode(value ? 1 : 0),
    decode: (cursor: Cursor) => uint32.decode(cursor) !== 0
  },
  string: (): Codec<string> => ({
    encode: (value) => opaque().encode(Buffer.from(value, "utf8")),
    decode: (cursor) => Buffer.from(opaque().decode(cursor)).toString("utf8")
  }),
  array: <A>(item: Codec<A>): Codec<ReadonlyArray<A>> => ({
    encode: (values) => Buffer.concat([uint32.encode(values.length), ...values.map(item.encode)]),
    decode: (cursor) => Array.from({ length: uint32.decode(cursor) }, () => item.decode(cursor))
  })
}

export const replyReader = (bytes: Uint8Array) => {
  const buffer = Buffer.from(bytes)
  let offset = 0

  const cursor: Cursor = {
    take(size) {
      if (size > buffer.length - offset) throw new RangeError("Truncated reply fixture")
      const start = offset
      offset += size

      return buffer.subarray(start, offset)
    }
  }

  return {
    read: <A>(codec: Codec<A>) => Effect.sync(() => codec.decode(cursor)),
    finish: Effect.sync(() => {
      if (offset !== buffer.length) throw new Error("Unexpected trailing reply fields")
    })
  }
}

export const requestWriter = () => {
  const fields: Array<Uint8Array> = []

  return {
    write: <A>(codec: Codec<A>, value: A) => Effect.sync(() => void fields.push(codec.encode(value))),
    appendEncoded: (value: Uint8Array) => Effect.sync(() => void fields.push(value)),
    finish: Effect.sync(() => new Uint8Array(Buffer.concat(fields)))
  }
}

export type ReplyReader = ReturnType<typeof replyReader>

export type RequestWriter = ReturnType<typeof requestWriter>

export const encodeRecord = (payload: Uint8Array) =>
  Buffer.concat([uint32.encode(0x8000_0000 + payload.length), payload])

/** Collect records from a stream whose chunks can split record headers or payloads. */
export class ReplyRecords {
  private pending = Buffer.alloc(0)
  private readonly fragments: Array<Uint8Array> = []

  push(chunk: Uint8Array): ReadonlyArray<Uint8Array> {
    this.pending = Buffer.concat([this.pending, chunk])
    const records: Array<Uint8Array> = []

    while (this.pending.length >= 4) {
      const header = this.pending.readUInt32BE()
      const length = header & 0x7fff_ffff

      if (this.pending.length < length + 4) break
      this.fragments.push(this.pending.subarray(4, 4 + length))
      this.pending = this.pending.subarray(4 + length)

      if (header >= 0x8000_0000) {
        records.push(Buffer.concat(this.fragments))
        this.fragments.length = 0
      }
    }

    return records
  }
}

export const Operation = {
  COMMIT: 5,
  GETFH: 10,
  LOOKUP: 15,
  PUTFH: 22,
  PUTPUBFH: 23,
  PUTROOTFH: 24,
  SECINFO: 33,
  EXCHANGE_ID: 42,
  CREATE_SESSION: 43,
  DESTROY_SESSION: 44,
  SEQUENCE: 53,
  VERIFY: 37,
  NVERIFY: 17,
  RECLAIM_COMPLETE: 58,
  OPEN: 18,
  LOCK: 12,
  LOCKU: 14,
  LOCKT: 13,
  TEST_STATEID: 55,
  CLOSE: 4,
  READ: 25,
  FREE_STATEID: 45,
  GETATTR: 9,
  READDIR: 26,
  DESTROY_CLIENTID: 57,
  BIND_CONN_TO_SESSION: 41,
  BACKCHANNEL_CTL: 40,
  LOOKUPP: 16,
  SECINFO_NO_NAME: 52,
  READLINK: 27,
  RESTOREFH: 31,
  SAVEFH: 32,
  OPEN_DOWNGRADE: 21,
  ACCESS: 3,
  WRITE: 38,
  SETATTR: 34,
  CREATE: 6,
  REMOVE: 28,
  RENAME: 29,
  LINK: 11,
  SETCLIENTID: 35,
  OPENATTR: 19,
  RENEW: 30,
  OPEN_CONFIRM: 20,
  RELEASE_LOCKOWNER: 39,
  LAYOUTGET: 50,
  DELEGRETURN: 8,
  ILLEGAL: 10044,
  SET_SSV: 54
} as const

export const Status = {
  OK: 0,
  NOENT: 2,
  ISDIR: 21,
  STALE: 70,
  NOFILEHANDLE: 10020,
  CONN_NOT_BOUND_TO_SESSION: 10055,
  SAME: 10009,
  NOT_SAME: 10027,
  ATTRNOTSUPP: 10032,
  INVAL: 22,
  BADNAME: 10041,
  COMPLETE_ALREADY: 10054,
  DENIED: 10010,
  OLD_STATEID: 10024,
  BAD_STATEID: 10025,
  LOCKS_HELD: 10037,
  DELAY: 10008,
  BAD_HIGH_SLOT: 10077,
  RETRY_UNCACHED_REP: 10068,
  REP_TOO_BIG_TO_CACHE: 10067,
  SEQ_FALSE_RETRY: 10076,
  BADSESSION: 10052,
  NOT_ONLY_OP: 10081,
  REP_TOO_BIG: 10066,
  TOOSMALL: 10005,
  BADXDR: 10036,
  OP_NOT_IN_SESSION: 10071,
  SEQUENCE_POS: 10064,
  REQ_TOO_BIG: 10065,
  ROFS: 30,
  MINOR_VERS_MISMATCH: 10021,
  TOO_MANY_OPS: 10070,
  CLIENTID_BUSY: 10074,
  SERVERFAULT: 10006,
  BAD_COOKIE: 10003,
  SHARE_DENIED: 10015,
  NOTSUPP: 10004,
  OP_ILLEGAL: 10044,
  NOTDIR: 20,
  SYMLINK: 10029,
  NAMETOOLONG: 63,
  LOCKED: 10012,
  WRONG_TYPE: 10083,
  BADCHAR: 10040,
  ENCR_ALG_UNSUPP: 10079,
  IO: 5,
  FBIG: 27,
  OPENMODE: 10038,
  BADOWNER: 10039,
  PERM: 1,
  EXIST: 17,
  ACCESS: 13,
  NOSPC: 28,
  NO_GRACE: 10033,
  CLID_INUSE: 10017,
  STALE_CLIENTID: 10022,
  SEQ_MISORDERED: 10063,
  BADHANDLE: 10001,
  FHEXPIRED: 10014
} as const
