# Strict string filename boundary

Status: accepted, 8 September 2026. Resolves D02's output policy.

## Decision

Core preserves raw filename bytes. A string operation that must return a filename which cannot be represented
faithfully as a string fails with a structured error. It must not replace invalid sequences, skip entries, or
introduce an escape convention. Raw-byte operations remain available through core.

Valid string names continue to work normally. The presence of an unrepresentable sibling does not by itself prevent
access to a valid named file. A string directory listing that would include the unrepresentable name fails instead
of returning an incomplete or lossy listing.

## Example

A directory contains two distinct invalid UTF-8 names and a valid name containing the Unicode replacement character.
Replacement decoding could make these names indistinguishable. The string listing fails; the byte listing preserves
all three distinct names and permits callers to address them through core.

## Alternatives and basis

Reversible escaping would require a new addressing convention and rules for literal escape characters. Skipping
entries would hide files; replacement decoding could merge distinct names. The user accepted strict errors instead.

This is a project adapter policy implementing the byte-preservation and non-lossy conversion requirements in the
[design](../design/VirtualFileSystem-design.md), not a claim that POSIX specifies this string interface.

## Remaining contracts and evidence

Define the error tag and its `PlatformError` mapping before migration. Apply the policy explicitly to directory
listings, returned paths, and filename-bearing watch events, including how a watch stream reports the error.
The same representability question for raw symlink targets needs an explicit rule in the operation contract.
String input validation, including lone surrogates, remains open; this decision does not approve lossy input encoding.

Required tests cover distinct invalid byte names, a valid replacement-character name, a failed string listing,
successful byte listing/access, and access to a valid sibling. Link these to `POSIX-P05` and `POSIX-P06` in the
[profile ledger](../context/posix-profile.md). No tests were implemented or run for this decision.
