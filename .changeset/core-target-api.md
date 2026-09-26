---
"@effect-vfs/core": minor
"@effect-vfs/memory": minor
"@effect-vfs/nfs": minor
"@effect-vfs/persistence": minor
---

`Caller` now accepts a path, object reference, or open handle as a `Target`, and the packages use one `VfsError` family. This changes existing calls and error handling across the fixed release group.

Replace `*Reference`, `*Handle`, and `*Bytes` methods with the corresponding `Caller` method. Use `Vfs.Entry(directory, name)` for an entry relative to a directory. Use `Vfs.Target.Path` for path options such as `followFinalSymlink`:

```ts
// Before
const work = yield * fs.lookupReference(root, encoder.encode("work"))
const metadata = yield * fs.lstat("/link")

// After
const work = yield * fs.lookup(Vfs.Entry(root, "work"))
const metadata = yield * fs.stat(
  Vfs.Target.Path({ path: "/link", followFinalSymlink: false })
)
```

`stat` now returns `Metadata` with a `revision`; `readDirectory` returns entries and a directory revision; `readLink` and `realPath` return bytes; `pread` returns `{ bytes, eof }`; and `access` returns the granted bits. Update callers that use the old return values. Match failures on `VfsError.code` and `operation`; `error.path` is now a `BytePath`.

`Volume.layer`, `Caller.layer`, and the other volume layers replace manual service wiring. Volume construction no longer requires a `Crypto` service. Remove `CurrentFileSystem`, `makeCrypto`, and `layerCrypto` from applications that used them.
