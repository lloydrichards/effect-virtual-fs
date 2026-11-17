#!/usr/bin/env bash
set -eu

cd "$(dirname "$0")/.."
exec bun scripts/lint-effects.mjs "$@"
