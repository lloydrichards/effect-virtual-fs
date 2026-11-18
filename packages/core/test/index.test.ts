import { assert, it } from "@effect/vitest"
import * as BytePath from "../src/BytePath.js"
import * as Caller from "../src/Caller.js"
import * as FileHandle from "../src/FileHandle.js"
import * as Fixture from "../src/Fixture.js"
import * as Core from "../src/index.js"
import * as LiveVolume from "../src/LiveVolume.js"
import * as Metadata from "../src/Metadata.js"
import * as Search from "../src/Search.js"
import * as Snapshot from "../src/Snapshot.js"
import * as SnapshotDelta from "../src/SnapshotDelta.js"
import * as Target from "../src/Target.js"
import * as Testing from "../src/Testing.js"
import * as VfsError from "../src/VfsError.js"
import * as VirtualFileSystem from "../src/VirtualFileSystem.js"
import * as Volume from "../src/Volume.js"
import * as Watch from "../src/Watch.js"

it.each(
  [
    ["BytePath", Core.BytePath, BytePath],
    ["Caller", Core.Caller, Caller],
    ["FileHandle", Core.FileHandle, FileHandle],
    ["Fixture", Core.Fixture, Fixture],
    ["LiveVolume", Core.LiveVolume, LiveVolume],
    ["Metadata", Core.Metadata, Metadata],
    ["Search", Core.Search, Search],
    ["Snapshot", Core.Snapshot, Snapshot],
    ["SnapshotDelta", Core.SnapshotDelta, SnapshotDelta],
    ["Target", Core.Target, Target],
    ["Testing", Core.Testing, Testing],
    ["VfsError", Core.VfsError, VfsError],
    ["VirtualFileSystem", Core.VirtualFileSystem, VirtualFileSystem],
    ["Volume", Core.Volume, Volume],
    ["Watch", Core.Watch, Watch]
  ] as const
)("exposes the %s module through the root entry point", (_name, rootExport, module) => {
  assert.strictEqual(rootExport, module)
})
