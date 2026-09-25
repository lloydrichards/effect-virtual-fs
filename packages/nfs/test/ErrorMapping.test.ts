import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { assert, it } from "@effect/vitest"
import { failureForFs, Status } from "../src/internal/nfs4.js"

const expected = {
  NotFound: Status.NOENT,
  AlreadyExists: Status.EXIST,
  NotEmpty: Status.NOTEMPTY,
  NotDirectory: Status.NOTDIR,
  AccessDenied: Status.ACCESS,
  InvalidHandle: Status.SERVERFAULT,
  ForeignHandle: Status.SERVERFAULT,
  InvalidReference: Status.SERVERFAULT,
  ForeignReference: Status.SERVERFAULT,
  StaleReference: Status.STALE,
  ClosedCaller: Status.SERVERFAULT,
  InvalidArgument: Status.INVAL,
  InvalidPathEncoding: Status.INVAL,
  PathTooLong: Status.NAMETOOLONG,
  NoSpace: Status.NOSPC,
  IsDirectory: Status.ISDIR,
  FileTooLarge: Status.FBIG,
  NoData: Status.SERVERFAULT,
  StorageRejected: Status.IO,
  OutcomeUnknown: Status.IO,
  VolumeUnavailable: Status.IO,
  VolumeBusy: Status.DELAY,
  SymlinkLoop: Status.INVAL,
  UnrepresentableName: Status.INVAL,
  InvalidEncoding: Status.SERVERFAULT,
  UnsupportedVersion: Status.SERVERFAULT,
  InvalidStructure: Status.SERVERFAULT,
  LimitExceeded: Status.SERVERFAULT,
  BaseMismatch: Status.SERVERFAULT,
  Storage: Status.IO,
  Ownership: Status.IO,
  IncompatibleStore: Status.IO,
  CorruptStore: Status.IO
} satisfies Readonly<Record<Vfs.VfsCode, number>>

it("translates every core filesystem failure to an NFSv4.1 status", () => {
  for (const [code, status] of Object.entries(expected)) {
    // SAFETY: expected has exactly the FsCode keys by its Record type.
    const fsCode = code as Vfs.VfsCode

    assert.strictEqual(failureForFs(new Vfs.VfsError({ code: fsCode, operation: "test" })), status, code)
  }
})

it("returns SERVERFAULT for an unexpected runtime error code", () => {
  for (const code of ["FutureCode", "toString"]) {
    // The constructor validates its code, so an unknown runtime code is forced onto a valid error afterwards.
    const error = Object.assign(new Vfs.VfsError({ code: "NotFound", operation: "test" }), { code })

    assert.strictEqual(failureForFs(error), Status.SERVERFAULT, code)
  }
})
