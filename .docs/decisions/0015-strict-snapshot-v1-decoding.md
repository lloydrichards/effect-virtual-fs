# Strict snapshot version 1 decoding

Status: accepted, 8 September 2026. Resolves canonical spelling and unknown-field policy in D05.

## Decision

Version 1 snapshot decoding requires canonical standard padded base64 and canonical decimal integer strings.
Reject unknown fields at every schema-defined object level, including the envelope, records, metadata, and entries.
New fields require an explicit format version change rather than silent acceptance by a version 1 decoder.

Base64 has no whitespace and uses canonical unused bits. Empty byte content remains valid. Decimal strings use `0`,
positive digits without leading zeros, or a minus sign followed by a nonzero decimal value where signed values are
allowed. Reject leading plus signs, whitespace, leading zeros, and `-0`. This does not determine numeric ranges or
allow negative values in fields whose eventual contract forbids them.

The user accepted this policy after reviewing the [validation proposal](../context/snapshot-validation-contract.md).
It does not accept the proposal's entire validation sequence, graph rules, error taxonomy, or allocation strategy.

## Examples and tradeoffs

Accept `Zg==` for byte 102; reject the equivalent noncanonical `Zh==`. Accept decimal `1`; reject `01`.
Reject an otherwise valid metadata object containing an unrecognized field.

Strict decoding exposes malformed or mismatched producers early and avoids silently losing data. External producers
must follow the format exactly. This decision does not require canonical JSON whitespace, object-key order, stable
record ordering, deterministic image IDs, or stable snapshot hashes.

## Implementation and evidence

The [Schema prototype](../contracts/models.ts) now refines the Effect field codecs for canonical spelling and exposes
`decodeSnapshotImage` with unknown-field rejection enabled. [Model checks](../contracts/models.check.mjs) verify these
rules against the pinned library. The initial behavior regression failed because noncanonical base64 was accepted;
it passes with the refinements. This is field-model evidence, not a complete snapshot decoder.

Required decoder cases cover canonical roundtrips; noncanonical base64 padding, whitespace, and unused bits;
noncanonical decimal strings; and unknown fields at every object level. Existing size limits must be respected while
validating. Exact bounds, error mapping, version migration, and decoder implementation remain follow-up work.
