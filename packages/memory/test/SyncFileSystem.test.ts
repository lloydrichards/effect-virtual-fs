import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { Layer } from "effect"
import * as MemoryFileSystem from "../src/MemoryFileSystem.js"
import * as FileSystemTest from "./FileSystemTest.js"

FileSystemTest.suite(
  "sync memory",
  MemoryFileSystem.layerFromFixture({ entries: [{ kind: "directory", path: "/tmp" }] }, { execution: "sync" })
    .pipe(Layer.provide(NodeCrypto.layer))
)
