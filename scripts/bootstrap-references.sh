#!/usr/bin/env bash
set -euo pipefail

reference_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.reference"
mkdir -p "$reference_root"

checkout_reference() {
  local name="$1"
  local url="$2"
  local revision="$3"
  local destination="$reference_root/$name"

  if [[ ! -d "$destination/.git" ]]; then
    git clone --filter=blob:none --no-checkout "$url" "$destination"
  fi

  git -C "$destination" fetch --depth=1 origin "$revision"
  git -C "$destination" checkout --detach FETCH_HEAD
}

checkout_reference \
  "open_effect" \
  "https://github.com/lloydrichards/open_effect.git" \
  "14df59217416ba28a8b6a8fd0ab9ac1c891f14f3"

checkout_reference \
  "effected" \
  "https://github.com/spencerbeggs/effected.git" \
  "40f04b6cc06fc0894fb543298a8852441986d8c9"
