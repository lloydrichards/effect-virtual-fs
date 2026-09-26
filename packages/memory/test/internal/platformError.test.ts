import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { assert, it } from "@effect/vitest"
import * as PlatformError from "effect/PlatformError"
import { toPlatformError } from "../../src/internal/platformError.js"

const systemReason = (error: PlatformError.PlatformError): PlatformError.SystemError =>
  error.reason instanceof PlatformError.SystemError ? error.reason : assert.fail("Expected a system error")

it("should map volume admission pressure to Busy when translating a core error", () => {
  const coreError = new Vfs.VfsError({ code: "VolumeBusy", operation: "writeFile" })
  const error = toPlatformError(coreError, "writeFile", "/file")

  const reason = systemReason(error)
  assert.strictEqual(reason._tag, "Busy")
  assert.strictEqual(reason.method, "writeFile")
  assert.strictEqual(reason.pathOrDescriptor, "/file")
  assert.strictEqual(reason.cause, coreError)
})
