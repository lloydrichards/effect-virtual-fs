---
"@effect-vfs/core": patch
---

`FsError` and `ConfigurationError` now carry a message, so a failed cause reads as more than a bare tag.

`FsError` reports the operation and code, for example `open failed with NotFound`; it deliberately omits the path, which may be raw bytes or caller data. `ConfigurationError` names the option it rejected.
