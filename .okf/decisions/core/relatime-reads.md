---
type: Decision
title: Relatime reads
description: Reads refresh access times under the Linux relatime rule, observe under one permit and escalate to a change only when the time is due, and a change that leaves the value unchanged offers no durable commit.
status: stable
tags: [metadata, timestamps, coordination, durability, performance]
sources:
  - id: engine
    resource: ../../../packages/core/src/internal/virtualFileSystem.ts
    title: RELATIME_INTERVAL_NS, accessDue, refreshDue, accessing, refreshAccess and the unchanged-draft skip in committed
  - id: tests
    resource: ../../../packages/core/test/Relatime.test.ts
    title: The rule for each read, including a status-only change, the 24 h bound, and reads beside a held observation
  - id: live-tests
    resource: ../../../packages/core/test/LiveCommit.test.ts
    title: Only a due read commits, a same-instant read and a repeated due read commit nothing, and an unchanged draft offers nothing
  - id: transfer-tests
    resource: ../../../packages/memory/test/TreeTransfer.test.ts
    title: A live fromCaller read keeps a recent access time
  - id: issue
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/200
    title: Relax atime so reads can share the read permit
generated: { by: claude-code, at: "2026-09-26T10:40:00+02:00" }
---

# Relatime reads

Follows the [persistent tree rebuild](persistent-tree-rebuild.md "follows"), whose gate lets observations share the volume while a change runs alone, and settles the lazy access-time question the [live durable volume research](../../research/live-durable-volume.md "resolves") left open. The decisions were grilled on 2026-09-25 and recorded on [issue #200](https://github.com/lloydrichards/effect-virtual-fs/issues/200 "decided on").

## Context

Every `readFile`, `readDirectory` and handle read wrote the access time, so each ran as a change: it took every permit, and on a durable volume it encoded the whole image and offered it to the store, only to persist the new time. Measured with 8 readers for 2 s, an in-memory volume with one writer read 128k to 147k times a second against 177k to 189k with access times off. A live volume with 200 files managed about 95 reads a second and one with 1,000 files about 20, against about 215k with access times off.

## Decisions

1. **relatime.** A read refreshes a node's access time only when that time is not newer than its modification time or its status-change time, or is at least 24 hours older than the volume clock's current time (`RELATIME_INTERVAL_NS`, fixed). An access time already equal to the current time is never refreshed, as Linux `atime_needs_update` skips it, so reads at one instant of a frozen or coarse clock store nothing. This is the Linux mount default. The clock is read on every read, after the permission check, as before, so a clock outside the timestamp domain still fails the read with `InvalidArgument`.
2. **A read takes one permit.** It runs as an observation and checks the rule. Only when the time is due does it run again as a change, which repeats every check and the same rule (one predicate serves both), since another read may have refreshed the time in between. The change's result is the one returned. The checks, their order and their codes are those of the read before this decision.
3. **Which reads.** `readFile`, `readDirectory` and handle `pread` observe first. A cursor `read` stays a change, because two reads beside each other would start at the same offset; it applies the same rule inside its change. A handle read of zero bytes touches no access time.
4. **A change that leaves the value unchanged offers no commit**, whatever the reason: no pending inode, no open-count change, and the same allocator and usage. Its handle writes and events still apply. This covers a read whose time another read refreshed first, a zero-byte write and an empty `setattr`. An access-time refresh still advances no revision.
5. **Rejected alternatives.** noatime would change the contract for little gain once relatime lands. An in-memory access-time table flushed on the next change would lose times on a crash, and every snapshot, capture, overlay and NFS attribute would have to merge it.
6. **Pins.** The memory `TreeTransfer` pin now expects a live read to keep a recent access time. The `LiveCommit` rejected-read pin stays, reading a second after the write so its access time is due, and its comment says so. New pins cover the rule for each read, a status-only change, the 24 h bound, that only a due read commits, that a read at the instant its access time already holds commits nothing, that two due reads waiting behind one change commit one refresh, and reads running beside a held observation while a due read and a cursor read wait.

## Consequences

Measured on the same machine against the parent commit, 8 readers for 2 s: in memory with one writer, 110k to 111k reads a second became 113k to 120k; a live volume with 200 files went from 111 to 114 reads a second alone to 142k to 145k, and with a writer from about 100 (writer 12 a second) to about 1,000 (writer 110 a second); one with 1,000 files went from 23 alone to about 141k. The [permissions and metadata contract](../../contracts/permissions-and-metadata.md "constrains") states the rule, the [mutation revisions contract](../../contracts/mutation-revisions.md "constrains") keeps refreshes revision-neutral, and the [tree transfer contract](../../contracts/tree-transfer.md "constrains") no longer says every source read commits.
