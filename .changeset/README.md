# Changesets

Add a changeset for every user-visible change after a package's first public release. Core, memory, and persistence
start at `0.0.1`; publishing a new package at that initial version does not need a version-bumping changeset.

All three packages belong to one fixed Changesets group. Future changesets version them together, using the
largest requested bump in the group, and update their internal dependency ranges.
