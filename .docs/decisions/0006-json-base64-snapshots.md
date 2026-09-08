# JSON and base64 snapshots

Status: accepted, 8 September 2026. Resolves the initial wire-format choice in D05.

## Decision

The initial versioned snapshot format uses JSON with base64 for byte fields. Keep the logical snapshot model
separate from its encoding. Snapshot-local identifiers preserve relationships as specified in
[decision 0005](0005-snapshot-local-identity.md).

The expected workload includes Vite-sized project trees with potentially many `node_modules` files. The user does
not expect gigabytes of file contents. This is workload guidance, not a supported maximum, performance guarantee,
or a decision to add package installation or complete Node module resolution to core.

## Tradeoffs and basis

The user chose JSON/base64 after considering encoding size and peak memory. JSON makes the record structure
inspectable, while base64 preserves arbitrary bytes. Base64 content occupies approximately four bytes for every
three input bytes before metadata and padding effects. See [RFC 4648, section 4](https://www.rfc-editor.org/rfc/rfc4648.html#section-4).

Binary encoding could avoid that expansion, but would add codec rules and tooling. It is not required for the initial
format. File contents encoded as base64 are not directly human-readable even though the JSON structure is inspectable.

Capture still copies file bytes. Encoding and decoding can hold additional strings and buffers, so saved size is
not a measure of peak memory. JSON/base64 does not settle resource defaults or eliminate the need for measurement.

## Remaining contracts and evidence

Specify the envelope and version, exact base64 alphabet and padding validation, numeric representations, decoder
limits, and format evolution. Canonical padded base64 remains a recommendation until the codec contract is written.
Do not add a second production codec merely for comparison in the first release.

Measure capture, encode, decode, and restore on a representative dependency-heavy project fixture. Record file count,
total content bytes, encoded size, timings, runtime, and peak memory where measurable. Include many small files as
well as larger files. Choose numeric limits separately using those results and the intended runtime environments.

The initial virtual-build acceptance remains the bounded entry-module, relative-dependency, and rebuild case in the
[design](../design/VirtualFileSystem-design.md). A dependency-heavy fixture informs capacity and snapshot measurements;
full virtual package resolution requires a separate scope decision. Subsequent
[decision 0007](0007-virtual-package-acceptance.md) adds a bounded virtual package-import milestone, not complete resolution support.

Required correctness tests cover arbitrary byte fields, hard links, metadata, invalid encodings, unsupported versions,
and independent restores. No codec, benchmark, or integration was implemented or run for this decision.
