# Copying byte ownership

Status: accepted, 8 September 2026. Resolves the general byte-ownership model in D06.

## Decision

The initial API copies mutable byte inputs when their Effect executes, rather than when the Effect is constructed.
The operation uses its owned copy. Subsequent changes to the original buffer cannot change stored file contents.
File reads return independent buffers; changing a read result does not change the file. Callers must write changes
back explicitly.

Running the same Effect again consumes the input again at that execution. Do not interpret Effect construction as
a capture of the input's earlier contents. Snapshots retain the independent byte ownership already required by the
design; this decision does not introduce live mutable storage views.

## Example

A caller constructs a write Effect with a buffer containing `A`, changes that buffer to `B`, and then executes the
Effect. The operation copies and writes `B`. Later changes to that source buffer do not affect the stored contents.
Changing a buffer returned by a subsequent read also leaves the file unchanged.

## Tradeoffs and basis

The user accepted copying for predictable isolation between callers and snapshots. Copying costs time and temporary
memory, including storage beyond the volume's logical quota. Input ownership transfer and zero-copy APIs may be
investigated later if measurements justify them; they are not required initially.

This refines the byte-ownership questions in the [interface draft](../context/public-api-draft.md) and supports the
isolation requirements in the [design](../design/VirtualFileSystem-design.md).

## Remaining contracts and evidence

Specify exactly where capture occurs relative to validation and waiting for volume coordination. The proposed
synchronous copy before the first wait remains an implementation-contract recommendation. Shared-memory input
handling, multi-buffer capture, string validation, transfer limits, and codec details are not settled by this decision.

Required tests change inputs before execution and after consumption, execute one Effect multiple times with changed
input, and mutate read results. Assert stored bytes independently each time. Preserve snapshot and restore isolation
with their separate tests. No implementation or runtime tests were added for this decision.
