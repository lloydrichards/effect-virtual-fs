# Changesets

Add a changeset for every user-visible change after a package's first public release.

Core, memory, persistence, and nfs belong to one fixed Changesets group. Changesets versions them together, using the
largest requested bump in the group, and update their internal dependency ranges.
