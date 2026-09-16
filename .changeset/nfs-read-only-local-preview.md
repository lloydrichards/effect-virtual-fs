---
"@effect-vfs/nfs": patch
---

Graduate the `read-only-local` profile from `experimental` to `preview`.

The profile now has the repeatable Linux kernel-client evidence that `preview` requires, alongside the existing pinned pynfs run and the documented macOS 26 mount. An opt-in privileged mount gate mounts the preview app with `nfsvers=4.1`, runs sixteen read-side checks, and confirms that a bare mount still ladders down from 4.2 to 4.1. The server's behavior is unchanged; this is a change in how well that behavior is evidenced.
