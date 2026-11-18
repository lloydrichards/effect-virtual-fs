import { assert, it } from "@effect/vitest"
import * as FileSystemTesting from "../src/FileSystemTesting.js"
import * as Memory from "../src/index.js"
import * as MemoryFileSystem from "../src/MemoryFileSystem.js"
import * as TreeTransfer from "../src/TreeTransfer.js"

it.each(
  [
    ["FileSystemTesting", Memory.FileSystemTesting, FileSystemTesting],
    ["MemoryFileSystem", Memory.MemoryFileSystem, MemoryFileSystem],
    ["TreeTransfer", Memory.TreeTransfer, TreeTransfer]
  ] as const
)("exposes the %s module through the package root", (_name, rootExport, module) => {
  assert.strictEqual(rootExport, module)
})
