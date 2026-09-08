# Fixture and snapshot format example

Status: technical proposal, 8 September 2026. JSON/base64, final-state fixtures, and snapshot-local identity are
accepted. The schema, field names, defaults, timestamp representation, and remaining decoder rules below are proposed. Strict spelling and unknown-field rejection are accepted in decision 0015.
These examples are documentation data, not a published format or an implemented decoder.

## Fixture input

Recommend a record-list fixture for the low-level API. String paths are conveniences; a separate byte-path input form
will be needed. Require explicit parent directories initially. The root is implicit here. Directory creation by a
builder could be added separately without changing the low-level validation rules.

```json
{
  "entries": [
    { "path": "/b.txt", "kind": "hardLink", "target": "/a.txt" },
    { "path": "/a.txt", "kind": "file", "text": "hello" },
    { "path": "/shortcut", "kind": "symlink", "target": "missing.txt" }
  ]
}
```

The hard link appears first to demonstrate order independence. Resolve fixture references against declarations,
without following symlinks or replaying filesystem calls. For this initial syntax, recommend that a hard-link target
name a declared regular file directly; reject link-to-link chains until deliberately supported. A dangling symlink
is valid because its target is stored rather than resolved.

Recommend an explicit discriminator between UTF-8 text and raw byte file inputs in the eventual TypeScript fixture
shape. The example uses `text` for readability; raw bytes must remain available. Reject duplicate paths, conflicting
kinds, missing hard-link targets, invalid parents, and unsupported fields before exposing a volume.

## Encoded snapshot

This proposed image represents that fixture after expansion of metadata defaults. Names, content, and symlink targets
are base64. Records carry kind separately from permission bits. Runtime inode numbers and open-handle state are absent.

```json
{
  "format": "effect-vfs",
  "version": 1,
  "root": "d0",
  "records": [
    {
      "id": "d0",
      "kind": "directory",
      "metadata": {
        "uid": 0,
        "gid": 0,
        "mode": 493,
        "atimeNs": "0",
        "mtimeNs": "0",
        "ctimeNs": "0",
        "birthtimeNs": "0"
      },
      "entries": [
        { "name": "YS50eHQ=", "target": "f0" },
        { "name": "Yi50eHQ=", "target": "f0" },
        { "name": "c2hvcnRjdXQ=", "target": "s0" }
      ]
    },
    {
      "id": "f0",
      "kind": "file",
      "metadata": {
        "uid": 0,
        "gid": 0,
        "mode": 420,
        "atimeNs": "0",
        "mtimeNs": "0",
        "ctimeNs": "0",
        "birthtimeNs": "0"
      },
      "data": "aGVsbG8="
    },
    {
      "id": "s0",
      "kind": "symlink",
      "metadata": {
        "uid": 0,
        "gid": 0,
        "mode": 511,
        "atimeNs": "0",
        "mtimeNs": "0",
        "ctimeNs": "0",
        "birthtimeNs": "0"
      },
      "target": "bWlzc2luZy50eHQ="
    }
  ]
}
```

`493`, `420`, and `511` represent octal `0755`, `0644`, and `0777`. They illustrate candidate defaults, not accepted
permission policy. UID/GID zero are fixture ownership values, not a privilege grant. Decimal nanosecond strings
illustrate lossless integer encoding; they do not promise nanosecond clock precision. The epoch values illustrate
predictable fixture timestamps. The proposed birth-time field preserves metadata exposed by the existing memory adapter. Its representation and
precision still require a contract; it is not a POSIX timestamp requirement.

Both `a.txt` and `b.txt` point to `f0`. Loading them as independent file records would lose the accepted hard-link
relationship. Derive link counts and file lengths from validated structure and decoded bytes rather than accepting
conflicting redundant values. Preserve identity relationships while allowing new runtime inode numbers.

See the [validation contract](snapshot-validation-contract.md) for proposed decode stages, graph checks, and failure boundaries.

## Proposed codec rules

[Decision 0015](../decisions/0015-strict-snapshot-v1-decoding.md) requires canonical standard padded base64 and decimal
integer spelling, and rejects unknown fields at every schema-defined object level in version 1. Numeric ranges and
validation allocation strategy remain proposed. Recommend rejecting unsupported versions distinctly.

Keep format version independent from package version. The `format` identifier above is a proposal. Encoded record
ordering and numeric identifiers need not remain identical across captures; deterministic encoding is a separate
choice. Do not claim stable hashes based on this example.

Decode limits apply before expensive allocation where possible, then to record/entry counts, decoded lengths, topology,
and metadata. Restore recomputes usage against destination-controlled limits under the current recommendation.
Image data cannot increase the caller's permitted capacity. No image contains live callers, offsets, watchers, or
unlinked files retained solely by handles.

## What this example proves

Mechanical documentation checks can parse both JSON blocks, validate canonical base64, and confirm the intended names,
content, and shared record references. They do not validate a production codec, permission behavior, timestamp policy,
or snapshot isolation. Those require the eventual implementation and its separate behavior tests.

Before accepting this schema, settle exact metadata defaults and supported fields, byte-path fixture syntax, numeric
ranges, unknown-field policy, and limits. See the [resource contract](resource-and-byte-contract.md) for consumption
timing and [snapshot research](snapshots-and-consumers.md) for validation and isolation requirements.
