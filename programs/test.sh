#!/bin/bash
# Builds both programs and runs every test. Run it from Linux or WSL.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"

# Cargo is slow on a Windows drive mounted in WSL, so build somewhere native.
target="${LURE_TARGET:-$HOME/lure-target}"
# Both simulator test crates share one target directory, so LiteSVM compiles once.
sim="$target/leash-tests"
export LEASH_SO="$target/leash/deploy/lure_leash.so"
export HOOK_SO="$target/hook/deploy/lure_hook.so"

for program in leash hook; do
  (cd "$program" && CARGO_TARGET_DIR="$target/$program" cargo test --lib)
  (cd "$program" && CARGO_TARGET_DIR="$target/$program" cargo build-sbf --sbf-out-dir "$target/$program/deploy")
done
(cd leash-tests && CARGO_TARGET_DIR="$sim" cargo test -- --nocapture)
(cd hook-tests && CARGO_TARGET_DIR="$sim" cargo test -- --nocapture)

for so in "$LEASH_SO" "$HOOK_SO"; do
  echo "binary: $(stat -c %s "$so") bytes at $so"
done
