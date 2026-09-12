export const apiPages = [
  {
    packageDir: "packages/core",
    moduleNames: ["VirtualFileSystem", "BytePath", "Snapshot", "SnapshotDelta"],
    label: "Core · VirtualFileSystem",
    href: "/api/core/virtual-file-system",
    routePath: "core/virtual-file-system",
    contentPath: "content/api/core/virtual-file-system.mdx"
  },
  {
    packageDir: "packages/memory",
    moduleNames: ["MemoryFileSystem"],
    label: "Memory · MemoryFileSystem",
    href: "/api/memory/memory-file-system",
    routePath: "memory/memory-file-system",
    contentPath: "content/api/memory/memory-file-system.mdx"
  },
  {
    packageDir: "packages/persistence",
    moduleNames: ["CheckpointStore"],
    label: "Persistence · CheckpointStore",
    href: "/api/persistence/checkpoint-store",
    routePath: "persistence/checkpoint-store",
    contentPath: "content/api/persistence/checkpoint-store.mdx"
  }
] as const
