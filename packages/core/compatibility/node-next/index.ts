import { Search, VirtualFileSystem } from "@effect-vfs/core"
import * as VirtualFileSystemModule from "@effect-vfs/core/VirtualFileSystem"

export { VirtualFileSystem, VirtualFileSystemModule }

import * as SearchModule from "@effect-vfs/core/Search"

export { Search, SearchModule }

import type { Snapshot } from "@effect-vfs/core/Snapshot"

export const content = (snapshot: Snapshot) => {
  const query: Search.ContentQuery = {
    root: "/",
    include: ["**"],
    pattern: Search.Pattern.cases.Literal.make({ pattern: "TODO" })
  }

  return {
    lines: Search.lines(snapshot, query),
    files: SearchModule.files(snapshot, query),
    counts: Search.countLines(snapshot, query),
    scanLines: SearchModule.scanLines(snapshot, query),
    scanFiles: Search.scanFiles(snapshot, query),
    scanCounts: SearchModule.scanCountLines(snapshot, query)
  }
}
