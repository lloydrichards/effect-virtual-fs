# Evidence retention policy

This directory contains small, curated artifacts that support an enduring design
decision, benchmark, or reproduced regression. It is not a general archive for
command output.

Keep in Git only:

- `results.json` manifests with commands, exit codes, and relevant versions or hashes;
- intentional failing or focused regression probes cited by a decision or context document;
- reproducible research inputs and measurements that a document relies on.

Do not commit routine successful build, lint, format, type-check, test, install,
or generated command logs. Summarize their outcome in the context document and
record it in the relevant result manifest instead.

`.gitignore` ignores new files here by default. When a new artifact meets the
criteria above, include it intentionally and link to it from the document that
explains its continued value. With GitButler, use exact file exceptions in
`.gitignore` so its workspace scanner continues to see the retained artifacts.
