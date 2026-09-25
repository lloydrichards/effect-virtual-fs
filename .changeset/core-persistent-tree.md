---
"@effect-vfs/core": patch
---

A mutation on a live volume no longer copies the whole tree before committing, so its cost no longer grows with the number of entries: a `writeFile` on an 8,000-file volume drops from about 1.2 ms to about 12 µs of engine time. Every mutation now advances the volume revision once and stamps that revision on each object it touched, so `stat` and `readDirectory` report equal revisions for objects changed by the same operation; revisions still increase strictly and stay put across reads. Watch events for a hard-linked file list its names in the order the links were made.
