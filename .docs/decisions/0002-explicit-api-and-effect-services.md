# Explicit API and Effect services

Status: accepted, 8 September 2026. Resolves the API access-style portion of D01.

## Decision

The first core API supports both explicit volume/caller/handle objects and an optional Effect service layer.
The explicit API provides all core capabilities. The service layer stays thin and delegates to the same behavior.
Direct use still returns Effect values and uses Effect resource management; it does not require obtaining the caller
from the Effect environment.

Shared volume state, caller context, and handle lifetime remain separate in both styles. Providing an existing caller
through a service must not implicitly create a different volume or replace its credentials or working directory.

## Example

Alice and Bob use one volume with separate caller contexts. Alice works from `/project`; Bob works from `/`.
Alice opens `src/main.ts` relative to her directory. Bob observes her writes through the same volume, while his cwd
and independently opened handles remain unaffected. Either caller can be passed explicitly or supplied through the
optional service layer.

## Alternatives

- Explicit objects only would postpone convenient Effect environment integration.
- Services only would require direct integrations to obtain caller state through the environment.

The user selected both styles during the design discussion. This is a project API decision, not a POSIX requirement.
It follows the ownership model in the [design](../design/VirtualFileSystem-design.md).

## Remaining decisions and evidence

Exact exports, signatures, service/layer construction, operations, flags, and directory-reference types remain open.
This decision does not settle all of D01 or authorize core implementation.

Required tests must show equivalent results and failures through both styles, shared files with independent caller
contexts and handles, and scoped cleanup without affecting another consumer. These extend `POSIX-P08`, `POSIX-H01`,
and `POSIX-H11` in the [profile ledger](../context/posix-profile.md).
