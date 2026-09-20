export const apiPages = [
  {
    packageDir: "packages/core",
    moduleName: "VirtualFileSystem",
    label: "Core · VirtualFileSystem",
    href: "/api/core/virtual-file-system",
    routePath: "core/virtual-file-system",
    contentPath: "content/api/core/virtual-file-system.mdx",
    relatedLinks: [
      {
        label: "Filesystem error types",
        href: "/api/core/virtual-file-system-error"
      },
      {
        label: "Volumes, callers, and handles",
        href: "/concepts/filesystem-model"
      },
      {
        label: "Build and transport filesystem snapshots",
        href: "/guides/fixtures-and-snapshots"
      },
      {
        label: "Create an isolated overlay workspace",
        href: "/guides/overlay-filesystems"
      }
    ]
  },
  {
    packageDir: "packages/core",
    moduleName: "VirtualFileSystemError",
    label: "Core · VirtualFileSystemError",
    href: "/api/core/virtual-file-system-error",
    routePath: "core/virtual-file-system-error",
    contentPath: "content/api/core/virtual-file-system-error.mdx"
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
    packageDir: "packages/core",
    moduleName: "LiveVolume",
    label: "Core · LiveVolume",
    href: "/api/core/live-volume",
    routePath: "core/live-volume",
    contentPath: "content/api/core/live-volume.mdx"
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
    contentPath: "content/api/persistence/checkpoint-store.mdx",
    relatedLinks: [
      {
        label: "Save and restore SQLite checkpoints",
        href: "/guides/sqlite-checkpoints"
      }
    ]
  },
  {
    packageDir: "packages/persistence",
    moduleName: "SqliteLiveImageStore",
    label: "Persistence · SqliteLiveImageStore",
    href: "/api/persistence/sqlite-live-image-store",
    routePath: "persistence/sqlite-live-image-store",
    contentPath: "content/api/persistence/sqlite-live-image-store.mdx"
  },
  {
    packageDir: "packages/nfs",
    moduleName: "NfsServer",
    label: "NFS · NfsServer",
    href: "/api/nfs/nfs-server",
    routePath: "nfs/nfs-server",
    contentPath: "content/api/nfs/nfs-server.mdx"
  }
] as const
