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
        href: "/api/core/vfs-error"
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
    moduleName: "VfsError",
    label: "Core · VfsError",
    href: "/api/core/vfs-error",
    routePath: "core/vfs-error",
    contentPath: "content/api/core/vfs-error.mdx"
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
    moduleName: "Volume",
    label: "Core · Volume",
    href: "/api/core/volume",
    routePath: "core/volume",
    contentPath: "content/api/core/volume.mdx"
  },
  {
    packageDir: "packages/core",
    moduleName: "Caller",
    label: "Core · Caller",
    href: "/api/core/caller",
    routePath: "core/caller",
    contentPath: "content/api/core/caller.mdx"
  },
  {
    packageDir: "packages/core",
    moduleName: "FileHandle",
    label: "Core · FileHandle",
    href: "/api/core/file-handle",
    routePath: "core/file-handle",
    contentPath: "content/api/core/file-handle.mdx"
  },
  {
    packageDir: "packages/core",
    moduleName: "Metadata",
    label: "Core · Metadata",
    href: "/api/core/metadata",
    routePath: "core/metadata",
    contentPath: "content/api/core/metadata.mdx"
  },
  {
    packageDir: "packages/core",
    moduleName: "Fixture",
    label: "Core · Fixture",
    href: "/api/core/fixture",
    routePath: "core/fixture",
    contentPath: "content/api/core/fixture.mdx"
  },
  {
    packageDir: "packages/core",
    moduleName: "Watch",
    label: "Core · Watch",
    href: "/api/core/watch",
    routePath: "core/watch",
    contentPath: "content/api/core/watch.mdx"
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
    packageDir: "packages/memory",
    moduleName: "TreeTransfer",
    label: "Memory · TreeTransfer",
    href: "/api/memory/tree-transfer",
    routePath: "memory/tree-transfer",
    contentPath: "content/api/memory/tree-transfer.mdx"
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
    packageDir: "packages/persistence",
    moduleName: "R2LiveImageStore",
    label: "Persistence · R2LiveImageStore",
    href: "/api/persistence/r2-live-image-store",
    routePath: "persistence/r2-live-image-store",
    contentPath: "content/api/persistence/r2-live-image-store.mdx"
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
