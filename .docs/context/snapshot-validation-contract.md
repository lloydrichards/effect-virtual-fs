# Snapshot validation contract

Status: mixed accepted policy and proposal, 8 September 2026. Expands D05 and D13. JSON/base64, snapshot-local
identity, and [strict version 1 decoding](../decisions/0015-strict-snapshot-v1-decoding.md) are accepted.
Validation order, graph rules, and detailed failure mapping remain proposals. This document adds no decoder implementation.

## Proposed result

Decoding returns an opaque, validated Snapshot or an ImageError. It never exposes a partially restored volume.
Schema handles field shapes and codecs. Additional validation establishes graph integrity and resource limits before
constructing the opaque value. Restoration separately checks the destination's configured limits.

The [model prototype](../contracts/models.ts) covers field shapes, canonical spelling, and codecs. Its `decodeSnapshotImage` helper rejects nested unknown fields. Its decoded SnapshotImage
is an intermediate value. Passing that schema does not establish the guarantees proposed here.

## Validation stages

| Stage                | Required work                                                                                                                                   | Proposed failure                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Input budget         | Check encoded byte length against the supplied limit before text decoding or JSON parsing.                                                      | LimitExceeded                          |
| Text and JSON        | Require valid UTF-8 JSON. Preserve parsing failure as a typed image failure.                                                                    | InvalidEncoding                        |
| Envelope             | Check the format identifier and version before interpreting record fields. A recognized format with an unsupported version has its own failure. | InvalidStructure or UnsupportedVersion |
| Shape and counts     | Reject unknown fields; check record and entry counts and required field types before decoding byte payloads.                                    | InvalidStructure or LimitExceeded      |
| Field representation | Validate canonical base64 and decimal integer spelling. Check decoded lengths against remaining budgets before allocating payload buffers.      | InvalidEncoding or LimitExceeded       |
| Graph                | Check identities, references, names, reachability, and directory structure.                                                                     | InvalidStructure                       |
| Ownership            | Construct the opaque snapshot with owned storage after every required check succeeds.                                                           | No partially published result          |

Apply stages in this order. Within a stage, do not promise which diagnostic wins when several fields are invalid.
Include record/field context in eventual diagnostics without copying arbitrary file payloads into error messages.
Mapping SchemaError into ImageError belongs at this public boundary; it does not happen automatically.

A byte-length gate bounds the JSON input but does not make JSON.parse streaming or eliminate its temporary allocations.
Record and entry limits can only be checked after parsing in a whole-document implementation. Document that memory cost
and measure it with the dependency-heavy workload before choosing default limits. Do not describe these limits as an
exact cap on process memory.

## Accepted field spelling

Use standard padded base64 with no whitespace and canonical unused bits. Empty byte content is valid. A practical
canonicality check compares input spelling with re-encoding, but decoded-size checks must happen before allocation.
Reject oversized decimal strings before constructing bigint values. Exact numeric ranges remain a separate contract.

For signed decimal timestamps, allow `0`, positive decimal digits without a leading zero, and a minus sign followed by
a nonzero decimal value. Reject `01`, `-0`, leading plus signs, and whitespace. This is a spelling decision, not a clock
precision or timestamp-range decision.

The pinned Effect codecs accept `Zh==` as the same byte as `Zg==`, and `01` as bigint `1n`. The
[executable probes](../contracts/models.check.mjs) record those behaviors. The prototype now adds spelling checks and configures unknown-field rejection in `decodeSnapshotImage`.
These checks do not enforce size budgets or validate the graph.

## Proposed graph rules

- Require unique record IDs and a root reference to an existing directory.
- Require every directory entry target to exist. Compare entry names as bytes within each directory.
- Reject empty names, slash, NUL, and the special names `.` and `..` in stored directory entries.
- Require a directory tree: root has no parent, every other directory has one parent, and directory cycles are invalid.
- Require every record to be reachable from root. Do not restore unreachable records as hidden allocated storage.
- Preserve multiple references to a regular file as hard links. Derive content lengths and link counts from validated
  state. Whether multiple references to a symlink are supported remains open and must match the operation profile.
- Store symlink targets without resolving them. Dangling targets are valid; symlink traversal loops do not constitute
  directory graph cycles. Target-byte restrictions must match the eventual path contract.

IDs are image-local labels. These rules do not require stable record order, deterministic IDs, or stable encoded hashes.

## Required implementation evidence

Keep these cases separate from the existing field-model checks:

| Case                                                                  | Observable result                                                          |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Documented image with two names for one file                          | Both restored names share file identity.                                   |
| Unknown field, noncanonical base64, or noncanonical integer           | Typed rejection under the selected strict policy.                          |
| Duplicate ID, duplicate byte name, missing target, or directory cycle | No Snapshot is returned.                                                   |
| Dangling symlink                                                      | Decode succeeds if all other fields and graph rules are valid.             |
| Encoded size over limit                                               | Reject before JSON parsing.                                                |
| Decoded payload over limit                                            | Reject before allocating that payload buffer.                              |
| Valid image exceeds destination capacity                              | Restore fails without changing an existing volume or publishing a new one. |
| Caller mutates input after successful decode                          | Snapshot contents remain unchanged.                                        |

Canonical spelling and rejection of unknown fields at every schema-defined object level are accepted. Defaults, timestamp ranges,
shared-memory input policy, and full decoder diagnostics remain explicit follow-up work.
