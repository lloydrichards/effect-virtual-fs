# Interface and data model review

Status: checked proposal, 8 September 2026. This directory contains no filesystem implementation and is outside the
workspace packages. Successful compilation does not finalize these declarations or prove filesystem behavior.

The directory-only core slice now exists. [implemented-consumers.ts](implemented-consumers.ts) checks its real
exports, including four deliberate type rejections. The broader declarations still describe future file/snapshot APIs
and must not be used as proof that those operations exist.

## Files and evidence

- [proposed.d.ts](proposed.d.ts) declares the proposed objects, operations, failures, and service identity.
- [models.ts](models.ts) provides executable Schema data models and Data error constructors; their types feed the declarations.
- [models.check.mjs](models.check.mjs) checks model constraints, the documented snapshot roundtrip, and tagged error handling.
- [consumers.ts](consumers.ts) exercises direct use, service/layer provision, directory-relative lookup, handle metadata,
  byte paths, and fixture/snapshot composition. It is not executable without an implementation.
- [tsconfig.json](tsconfig.json) checks the declarations and consumers together, with strict typing and no emit.

Checked against exact `effect@4.0.0-rc.112` and `typescript@7.0.2`, installed with lifecycle scripts disabled into
`/private/tmp/effect-vfs-api-check`. No repository dependencies or package lockfiles were changed.
The normal compile passes with `skipLibCheck: false`. Removing the ten `@ts-expect-error` directives from a temporary
copy produces ten errors at their intended call sites; restoring them returns the check to passing.

The initial compile reported missing `Disposable` and `AsyncDisposable` names in Effect's declarations. Adding
`ESNext.Disposable` to this isolated config resolved those declaration-library requirements. This is a type-library
requirement, not evidence of runtime disposable support. DOM types supply `TextEncoder` for the consumer example;
they do not prove browser runtime compatibility.

## What the checks establish

| Check                       | Evidence                                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------------------- |
| Explicit caller use         | Ordinary operations compose without a caller service requirement.                                     |
| Environment provision       | Supplying the same caller through a service or layer removes the service requirement.                 |
| Resource acquisition        | Open and cwd derivation require a scope; scoped composition removes that requirement.                 |
| Layer acquisition           | A layer can own a derived caller's scope. Providing an existing caller does not acquire its lifetime. |
| Opaque handles and paths    | Numeric descriptors, file handles used as directory bases, and raw arrays used as paths are rejected. |
| Proposed input distinctions | Number offsets and unsupported read-only truncate/append combinations are rejected.                   |
| Metadata authority          | Metadata mutation requires the caller; `file.chmod` is not exposed.                                   |
| Snapshot opacity            | Consumers cannot access a mutable record table on the snapshot value.                                 |

The final two consumer examples deliberately compile while escaping a scoped handle or supplying a directory base
from another volume. TypeScript does not prove runtime liveness or volume ownership. These require runtime checks.
No test here proves input copying, independent handles, permission enforcement, cleanup, quota accounting, snapshot
isolation, or build integration.

## Proposed choices represented by these types

The accepted decisions govern behavior. These specific type choices still need review:

- Bigint offsets, sizes, inode IDs, and nanosecond timestamp values; number-sized transfer counts and buffers.
- Root callers without a scope requirement, scoped cwd derivation, and the exact constructor/method names.
- Structured open flags. Read-only creation is expressible; append/truncate require writable access, and a mode is
  accepted only with creation enabled. These are candidate profile choices, not all POSIX flag combinations.
- Dense `data` and `hole` seek modes, whose inclusion remains proposed.
- `Metadata.birthtimeNs` preserves information needed by the current memory adapter. It is a project metadata field,
  not a POSIX timestamp claim. Its precision and snapshot representation remain proposals.
- Explicit fixture metadata and root overrides. Default values and conflicts between hard-link alias metadata require
  validation rules; the type alone cannot settle them. The low-level file fixture accepts bytes; a text helper is omitted.
- An opaque validated byte path; owned raw-byte results for directory names and symlink targets. Normalization and
  encoding rules remain runtime contracts.
- Named filesystem/configuration/image error families. Codes and mapping are incomplete proposals; error messages,
  and host numeric errno values remain unspecified. Concrete `Data.TaggedError` constructors are provided.
- Required decode limits, with numbers in the consumer chosen only for its tiny example. They are not default limits.

The ordinary directory-base model is represented; `O_SEARCH`, directory streams, and own-link metadata mutation
variants are not fully modeled. Watch notifications and the memory binding constructor are outside this declaration
slice. The types do not yet constitute a complete supported-operation whitelist.

## Model boundaries

Data values now derive their types from `Schema.Struct` and unions. Live capabilities remain interfaces, and byte paths
and snapshots remain opaque. `makeFixtureSchema` accepts a path schema; the executable `StringFixture` checks string
fixture shapes only. A real byte-path guard must accompany its eventual implementation.

`SnapshotImage` converts JSON base64 strings to byte arrays and decimal timestamp strings to bigint values. Its decoded
value is an intermediate record tree, not the opaque `Snapshot`. The schema does not check graph integrity, enforce
decoder budgets, copy buffers, or map `SchemaError` to `ImageError`. `DecodeLimits` checks limit values, not consumption.
In this Effect pin, base64 `Zh==` decodes like `Zg==`, and bigint `"01"` decodes to `1n`. Canonical spelling uses additional schema checks under [decision 0015](../decisions/0015-strict-snapshot-v1-decoding.md), with explicit decoder options for rejection of unknown fields.
The `decodeSnapshotImage` helper now enforces that policy, including nested unknown fields. Direct generic Schema
decoding must also supply `onExcessProperty: "error"`; the helper fixes this option for callers. Numeric refinements in this prototype are proposed constraints, not new ADRs.

The model checks run independently of the compile-only consumers. They establish field validation, JSON roundtripping,
strict field spelling and nested unknown-field rejection, and that the concrete errors work with `yield*` and `Effect.catchTag`; they do not establish filesystem behavior.

## Reproduce from the repository root

Use the repository-pinned Bun 1.2.21 and installed workspace dependencies. The real-export consumer examples import
core source directly; do not copy this config alone into a temporary directory.

```sh
bun install --frozen-lockfile
bun run tsc --project .docs/contracts/tsconfig.json
bun .docs/contracts/models.check.mjs .docs/contracts/models.ts .docs/context/snapshot-format-draft.md
```

CI runs both checks. `implemented-consumers.ts` exercises the actual directory slice; `consumers.ts` still exercises
the broader future declaration. As later operations are implemented, move their examples to real exports and retire
the corresponding duplicate declarations.

## Workspace tooling boundary

Root lint excludes this directory because the consumers intentionally contain invalid calls and the model script
executes throwing probes. Its strict TypeScript check and executable model checks remain separate validation gates;
this exclusion does not cover production packages. Recorded evidence under `.docs/evidence` is also excluded from
lint and formatting so saved lockfiles and logs keep their recorded bytes and hashes.
