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
  SymlinkLoop: Status.INVAL,
  UnrepresentableName: Status.INVAL
} satisfies Readonly<Record<Vfs.FsCode, number>>

it("translates every core filesystem failure to an NFSv4.1 status", () => {
  for (const [code, status] of Object.entries(expected)) {
    // SAFETY: expected has exactly the FsCode keys by its Record type.
    const fsCode = code as Vfs.FsCode

    assert.strictEqual(failureForFs(new Vfs.FsError({ code: fsCode, operation: "test" })), status, code)
  }
})

it("returns SERVERFAULT for an unexpected runtime error code", () => {
  for (const code of ["FutureCode", "toString"]) {
    // SAFETY: These invalid runtime values exercise compatibility with unknown core error codes.
    const error = new Vfs.FsError({ code: code as Vfs.FsCode, operation: "test" })

    assert.strictEqual(failureForFs(error), Status.SERVERFAULT, code)
  }
})
