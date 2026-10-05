#!/bin/bash
# Builds the leash program and runs every test. Run it from Linux or WSL.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"

# Cargo is slow on a Windows drive mounted in WSL, so build somewhere native.
target="${LURE_TARGET:-$HOME/lure-target}"
out="$target/leash/deploy"

(cd leash && CARGO_TARGET_DIR="$target/leash" cargo test --lib)
(cd leash && CARGO_TARGET_DIR="$target/leash" cargo build-sbf --sbf-out-dir "$out")
(cd leash-tests && CARGO_TARGET_DIR="$target/leash-tests" LEASH_SO="$out/lure_leash.so" cargo test -- --nocapture)

echo "binary: $(stat -c %s "$out/lure_leash.so") bytes at $out/lure_leash.so"
