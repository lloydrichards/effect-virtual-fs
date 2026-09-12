export const apiPages = [
  {
    packageDir: "packages/core",
    moduleName: "VirtualFileSystem",
    label: "Core · VirtualFileSystem",
    href: "/api/core/virtual-file-system",
    routePath: "core/virtual-file-system",
    contentPath: "content/api/core/virtual-file-system.mdx"
  },
  {
    packageDir: "packages/core",
    moduleName: "BytePath",
    label: "Core · BytePath",
    href: "/api/core/byte-path",
    routePath: "core/byte-path",
    contentPath: "content/api/core/byte-path.mdx"
  },
  {
    packageDir: "packages/core",
    moduleName: "Snapshot",
    label: "Core · Snapshot",
    href: "/api/core/snapshot",
    routePath: "core/snapshot",
    contentPath: "content/api/core/snapshot.mdx"
  },
  {
    packageDir: "packages/core",
    moduleName: "SnapshotDelta",
    label: "Core · SnapshotDelta",
    href: "/api/core/snapshot-delta",
    routePath: "core/snapshot-delta",
    contentPath: "content/api/core/snapshot-delta.mdx"
  },
  {
    packageDir: "packages/memory",
    moduleName: "MemoryFileSystem",
    label: "Memory · MemoryFileSystem",
    href: "/api/memory/memory-file-system",
    routePath: "memory/memory-file-system",
    contentPath: "content/api/memory/memory-file-system.mdx"
  },
  {
    packageDir: "packages/persistence",
    moduleName: "CheckpointStore",
    label: "Persistence · CheckpointStore",
    href: "/api/persistence/checkpoint-store",
    routePath: "persistence/checkpoint-store",
    contentPath: "content/api/persistence/checkpoint-store.mdx"
  }
] as const
