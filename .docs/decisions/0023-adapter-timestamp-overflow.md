# Adapter timestamp overflow

Status: accepted, 9 September 2026. The user selected typed `InvalidData` failure after reviewing POSIX and
Node/Deno representation behavior.

## Decision

MemoryFileSystem path and handle stat fail with a typed PlatformError whose reason is `InvalidData` when atime,
mtime, or birthtime cannot be represented as a JavaScript Date. Include the metadata field name and the path or
descriptor in the error. Fail the whole observation; do not return absent dates, invalid Date objects, or clamped
values. Core metadata and snapshot timestamp values remain unchanged.

Conversion retains truncation of bigint nanoseconds toward zero to obtain whole milliseconds. Exact positive and
negative Date boundaries remain valid. ctime is not part of Effect File.Info and is not converted. Each successful
observation owns its Date objects.

## Basis

An accepted core timestamp such as `10n ** 100n` previously caused the adapter's `DateTime.makeUnsafe` call to die.
The timestamp exists, but the adapter cannot represent it. A typed failure preserves that distinction.

POSIX.1-2024 [localtime](https://pubs.opengroup.org/onlinepubs/9799919799.2024edition/functions/localtime.html)
requires `EOVERFLOW` for an unrepresentable conversion. This is precedent, not a POSIX requirement for this JavaScript
adapter. [Node 24.10.0](https://github.com/nodejs/node/blob/v24.10.0/lib/internal/fs/utils.js) constructs Date values
directly and can retain an Invalid Date alongside bigint nanoseconds. Deno likewise constructs Date directly for
available timestamps; its documented null represents unavailable timestamps. Neither defines the selected Effect
adapter policy. ECMAScript [TimeClip](https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-timeclip)
defines the Date range.

## Evidence

`packages/memory/test/Timestamp.test.ts` exercises public path and handle stat, overflow in each returned field,
valid Date boundaries, unchanged core metadata, and output ownership. The recorded red run reproduced the original
defect before the repair. See [validation](../evidence/adapter-timestamps/results.json).
