# Schema, Data, and capability interfaces

Research: 8 September 2026, exact `effect@4.0.0-rc.112`. This is a modeling recommendation, not an accepted API change.
Source is the pinned [npm artifact](https://registry.npmjs.org/effect/-/effect-4.0.0-rc.112.tgz).
Paths and lines below refer to its `src` directory, not this repository.

## Effect uses different representations for different purposes

| Purpose                        | Pinned source evidence                                                                                                                           | Recommendation for core                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Services and live capabilities | `FileSystem.ts:78` interface and `:663` service tag; marked `File` interface at `:1040`; `Path.ts:84` and `:255`.                                | Keep volume, caller, and handle interfaces. Supply callers through `Context.Service`.                                         |
| Metadata records               | `FileSystem.ts:1126` defines `File.Info` as an interface.                                                                                        | A record is sufficient; a `Schema.Struct` companion is useful when validation or encoding is shared. A class is not required. |
| Locally constructed failures   | `PlatformError.ts:36`, `:109`, `:157` use `Data.TaggedError` and `Data.Error`.                                                                   | Replace error-only interfaces with concrete Data errors when implementing runtime failures.                                   |
| Validated and encoded data     | `Schema.ts:3581` supplies `Struct`; `:1516` supplies `decodeUnknownEffect`.                                                                      | Define snapshot/fixture/configuration schemas and derive their TypeScript types.                                              |
| Serializable failures          | `unstable/rpc/RpcClientError.ts` uses `Schema.Error`; `unstable/http/HttpClientError.ts:302` defines a serializable companion to its Data error. | Use schema-backed errors or a diagnostic projection when error encoding is required.                                          |
| Opaque values                  | `DateTime.ts:50` defines an interface with specialized constructors; `Brand.ts:228` provides nominal branding.                                   | Keep byte paths opaque with explicit copying and validation. Add an appropriate codec separately.                             |

Schema is a runtime companion to a type, not a replacement for TypeScript interfaces. It supplies validation,
decoding, encoding, and integration with schema-consuming Effect modules. Keeping types derived from schemas avoids
duplicate field definitions. Live resource methods and lifetime obligations still need capability interfaces.

Data supplies lightweight constructors, discriminants, matching helpers, and yieldable errors. It does not validate
unknown fields. `Data.taggedEnum`'s `$is` checks the tag, not the full payload. Do not substitute it for decoding a
snapshot or validating configuration.

## Version-specific details

- The pinned schema-aware tagged error constructor is `Schema.TaggedError`, at `Schema.ts:15207`.
  `Schema.TaggedErrorClass` does not exist in this release, despite that name appearing in skill guidance.
- `Schema.brand` at `Schema.ts:5242` adds nominal typing without adding runtime checks. Apply constraints separately.
- `Schema.Uint8ArrayFromBase64` at `Schema.ts:13665` is a candidate building block for snapshot byte fields.
  Verify the chosen canonical alphabet/padding policy rather than assuming the codec enforces every format rule.
- Runtime probes confirmed that ordinary records, `Data.Class` instances, and tagged-enum records participate in
  structural `Equal.equals` comparison in this pin. Equality is not a unique reason to choose Data here.
- Data instances are not frozen, and its constructors accept invalid field types at runtime. Neither Data nor a
  schema declaration replaces byte copying, scope ownership, graph validation, or quota checks.

## Suggested changes to the declaration plan

1. Keep `Volume`, `Caller`, `FileHandle`, `DirectoryHandle`, and `CurrentFileSystem` as capability interfaces/service identity.
2. Use `Schema.Struct` and schema unions for fixture/image records, identities, configuration, and reusable metadata
   when their validation/encoding requirements are shared. Derive the corresponding types from those schemas.
3. Implement `FsError`, `ConfigurationError`, and `ImageError` with Data errors initially unless their serialization
   is a concrete requirement. Schema-aware errors remain available when needed; do not serialize live handles.
4. Use Data tagged unions for internal state transitions where constructor/matching helpers help and no codec is needed.
5. Keep `Snapshot` and byte paths opaque. A schema describes the encoded image and byte representation without exposing
   mutable live storage.

The modeling direction was approved for the documentation prototype. [models.ts](../contracts/models.ts) now supplies
schema-derived data types and concrete Data errors to [proposed.d.ts](../contracts/proposed.d.ts). Live capabilities remain
declarations. [Model checks](../contracts/models.check.mjs) exercise field validation, the documented image roundtrip,
and tagged error handling. No core implementation was changed. Graph validation, budget enforcement, buffer ownership,
and error mapping still require implementation; schema decoding alone does not supply them.

The prototype subsequently added strict snapshot field spelling and nested unknown-field rejection under
[decision 0015](../decisions/0015-strict-snapshot-v1-decoding.md). Use `decodeSnapshotImage` for the configured model
boundary. It still returns SchemaError and does not construct an opaque Snapshot or enforce decoder budgets.
