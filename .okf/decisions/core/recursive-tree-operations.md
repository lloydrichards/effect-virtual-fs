---
type: Decision
title: Recursive tree operations
description: Core gains a walk that reaches each directory by name, a recursive mkdir in one transition, and a recursive remove over a post-order walk that stops at the first failure; copy stays in memory, and memory's tree helpers move onto the core verbs.
status: stable
tags: [walk, mkdir, remove, references, adapter]
sources:
  - id: api
    resource: ../../../packages/core/src/Caller.ts
    title: WalkOptions, RemoveOptions, and the recursive MkdirOptions field
  - id: contract
    resource: ../../../packages/core/src/VirtualFileSystem.ts
    title: WalkEntry, WalkFailure, and the walk, mkdir and remove contracts on Caller
  - id: engine
    resource: ../../../packages/core/src/internal/virtualFileSystem.ts
    title: walkChildren, reachFrame, walkFrames, makeDirectories, the lookup createMissing option, and emptyDirectory
  - id: walk-tests
    resource: ../../../packages/core/test/Walk.test.ts
    title: Order, bounds in both orders, links, vanished and renamed directories and roots, permissions, and access times
  - id: mkdir-tests
    resource: ../../../packages/core/test/MkdirRecursive.test.ts
    title: One change, partway failure, dots, links, and modes
  - id: remove-tests
    resource: ../../../packages/core/test/RemoveRecursive.test.ts
    title: Post-order removal, first failure, denied directories, a subtree or the target renamed out, a replacement, and force
  - id: families
    resource: ../../../packages/core/test/OperationFamilies.test.ts
    title: Recursive mkdir and remove rows for both addressing families
  - id: adapter
    resource: ../../../packages/memory/src/internal/treeOperations.ts
    title: readDirectory, glob and remove over the core walk and remove
  - id: transfer
    resource: ../../../packages/memory/src/internal/treeTransfer.ts
    title: fromCaller reaching every entry by its path
  - id: issue
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/205
    title: Recursive tree operations
generated: { by: claude-code, at: "2026-09-26T13:00:00+02:00" }
---

# Recursive tree operations

Recursive traversal, `mkdir -p` and `rm -r` lived in the memory adapter as compositions over path verbs, with one directory handle held per directory and a `stat` per entry. The decisions were grilled on 2026-09-25 and recorded on [issue #205](https://github.com/lloydrichards/effect-virtual-fs/issues/205 "decided on").

## Context

`readDirectory` returns a reference per child and every verb accepts a reference, so a walk over references needs no handle at all. What only the engine can add is one permit hold per directory, each child's kind without a `stat`, and no access-time commit. Memory's `mkdir -p` depended on the settled dot-name rule (path `mkdir` of `.` fails `AlreadyExists`), which a rewrite over references could not keep, and on following symbolic links on the way, which only path resolution does. Memory had two bugs: `remove({ recursive, force })` forgave a `NotFound` anywhere, so a concurrent removal midway reported success over a partial tree, and `TreeTransfer.fromCaller` held every directory's handle until its stream ended.

## Decisions

1. **What core gets.** `Caller.walk(directory, options?)` as a `Stream` over references, `mkdir(entry, { recursive })` in one transition, and `remove(entry, { recursive, force })` over a post-order walk. `copy` stays in memory, where `FileSystem.copy` and `TreeTransfer.toCaller` already share the transfer engine.
2. **walk.** Each `WalkEntry` carries its path relative to the walk's root with no leading slash, its name, its reference, the reference of the directory it was listed in, its kind, and its depth (1 for a child of the root); the root itself is not an entry. Entries arrive depth first, pre-order by default or post-order with `order: "post"`, each directory's names in byte order. Every directory is read in its own observation under one permit, the children's kinds come from the same read, and nothing is written, so a walk holds no handle and refreshes no access time. A path root follows a final symbolic link as a path does; below it, links are reported and never followed. A directory is listed only with read permission, and a directory below the root is reached by name from the root, as a path lookup reaches it: every directory above it must be searchable and must still hold the name the walk listed for the object it listed. A directory below one the caller may read but not search so fails `AccessDenied`, as Node and `find` do. A directory that went away or was renamed out of the tree after it was listed is skipped silently, while the entry that named it has already been reported. A path root is reached by the name its path ends on in turn, so a root renamed away after it was listed has nothing more to walk; a root reached through a final symbolic link, a reference or a handle is held by the object it resolved to, as a descriptor holds it.
3. **Walk bounds.** `maxDepth`, `maxEntries` and `maxBytes` (a file's size or a link's target length) are optional and unbounded by default; directories have one name and links are not followed, so a walk always ends. Passing a bound fails with `LimitExceeded`, the bound in `field` and the entry in `path`, after the entries before it are handed on. A directory deeper than `maxDepth` is never read: a post-order walk, which reports a directory after its entries, fails at that directory before reading it. `WalkFailure` is `FsFailure` or that failure, so the code union of every other verb stays as it was. A failure names the entry's path under the root's path when the root was a path, and the relative path when it was a reference or a handle.
4. **mkdir recursive is one transition.** It resolves the path as `lookup` does and creates each missing directory inside one draft, so any failure (a limit, a denied parent, a directory the caller just created but cannot search) discards all of them and watchers receive every `Create` from one installation. Dot names are walked, never created; a symbolic link on the way is followed; a final directory, or a link to one, that already exists is success with no change and its parent's revision reported unchanged. The result names the directory the path ends on, with its parent's revision before and after the call, so a path that leaves a directory it created, such as `new/..`, reports the change it made. Only the components the caller wrote are created, never a name inside a link's target, so a dangling link fails `NotFound`, as `mkdir -p` does. A file on the way fails `NotDirectory` and a final file `AlreadyExists`. The mode applies to every directory created, as Node gives each the mode (not POSIX's `u+wx` for intermediates, which memory never had), and the times to the final one. An entry names one child, created unless it is already a directory; its dot names stay `InvalidArgument`.
5. **remove recursive is a composition.** `remove` first removes the entry in one change. When that fails `NotEmpty` and `recursive` is set, it empties the directory over a post-order walk, each removal its own change, then removes the entry again. Each entry is removed by its name in a directory the walk reached by name from the target's own name, and only while that name still holds the object the walk listed. A subtree another caller renames out of the target is left alone and the removal fails `NotFound` at the name it left; a replacement created under a listed name is left alone and the removal fails `NotFound` at that name; a target renamed away mid-walk leaves nothing to remove and the removal fails `NotFound` at the target. It stops at the first failure, whose `path` names the entry it stopped at under the path (or entry name) the caller gave, and leaves what it has not reached. A directory with entries must be readable and it refuses the first one that is not, as Node's `fs.rm` does; an empty one needs no permission on itself, as `rmdir` does. No permission is changed to make a directory removable; memory's `removeTree` for tree transfer keeps its own permission-restoring cleanup.
6. **force forgives the target only.** `force` forgives `NotFound` for the target itself, including a missing ancestor on its path, and the result is then `undefined`; the overloads keep `DirectoryChange` for a call without `force`. A target renamed away mid-walk is the target going missing, so `force` forgives it too. A `NotFound` below the target, such as a concurrent removal midway or a replacement under a listed name, fails the call, which fixes memory's partial-tree success. A stale directory reference in an entry is `StaleReference`, not a missing name, so `force` does not forgive it.
7. **remove judges a trailing slash.** A trailing slash on a path to anything but a directory fails `NotDirectory` before write permission, as `unlink` and `rmdir` do on Linux.
8. **Memory moves onto the core verbs.** `makeDirectory({ recursive })` is one core `mkdir`, `readDirectory({ recursive })` and `glob` collect the core walk, and `remove` is the core `remove`. `fromCaller` keeps its own traversal, since its entry budget judges a listing before visiting it and its reads keep their relatime behaviour, but reaches every entry by its path under the root instead of through directory handles, so it holds no handle and, like the walk, needs search permission on each directory above an entry.
9. **Measurement.** `apps/virtual-build` never calls walk or glob, so the milestone used a walk-shaped workload over a 10,010-entry tree: `readDirectory({ recursive })` went from 10,232 one-permit holds, 222 all-permit holds (111 once access times are fresh), and 111 handles held at once to 111 one-permit holds, none exclusive, and no handle; its time fell from about 70 ms (54 ms warm) to about 31 ms (26 ms warm). `fromCaller` over the same tree holds no handle instead of 111.

## Consequences

Recursive operations other than `mkdir` are compositions, not transactions: a walk sees each listing whole but no snapshot of the tree, and a failed recursive remove leaves what it did not reach. The [mutation and observation contract](../../contracts/mutation-and-observation.md "constrains") states the exception for `mkdir`. The [memory adapter compatibility contract](../../contracts/memory-adapter-compatibility.md "constrains") records where memory's tree helpers now differ from Node's. The [tree transfer contract](../../contracts/tree-transfer.md "constrains") records that `fromCaller` reaches every entry by its path. A test seam, `beforeTreeRemoval`, runs before each entry a recursive remove removes, so a concurrent removal can be pinned deterministically.

The adversarial review of 2026-09-26 changed decision 2 from descent by reference to descent by name, which also stops a recursive remove from following a subtree renamed out of its target, and made a post-order walk judge `maxDepth` before reading a directory. Its second round anchored the root by its name as well, so a recursive remove no longer empties a target another caller renamed away, and made each removal check that the name still holds the object the walk listed, so it no longer removes a replacement.
