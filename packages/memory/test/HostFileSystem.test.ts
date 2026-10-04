import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem"
import * as FileSystemTest from "./FileSystemTest.js"

FileSystemTest.suite("Node host", NodeFileSystem.layer, "node")
