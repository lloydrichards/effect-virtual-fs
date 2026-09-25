// Volume limits that more than one module enforces.

// The largest per-file limit a volume accepts, and the limit it applies when none is given: a file's size fits
// an unsigned 32-bit count.
/** @internal */
export const MAX_FILE_BYTES = 0xffffffff
