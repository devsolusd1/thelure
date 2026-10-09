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
# The hook without its probe: it logs nothing. This is the build for real money.
quiet_so="$target/hook/deploy/lure_hook_quiet.so"

for program in leash hook; do
  (cd "$program" && CARGO_TARGET_DIR="$target/$program" cargo test --lib)
done
(cd leash && CARGO_TARGET_DIR="$target/leash" cargo build-sbf --sbf-out-dir "$target/leash/deploy")
# The hook is built twice into the same place: first without the probe, kept under its own
# name, then as it builds by default, with the one log line the devnet scripts read.
(cd hook && CARGO_TARGET_DIR="$target/hook" cargo build-sbf --no-default-features --sbf-out-dir "$target/hook/deploy")
cp "$HOOK_SO" "$quiet_so"
(cd hook && CARGO_TARGET_DIR="$target/hook" cargo build-sbf --sbf-out-dir "$target/hook/deploy")

(cd leash-tests && CARGO_TARGET_DIR="$sim" cargo test -- --nocapture)
# The hook's tests run against both builds, so the bytes that would hold money are tested too.
(cd hook-tests && CARGO_TARGET_DIR="$sim" cargo test -- --nocapture)
(cd hook-tests && CARGO_TARGET_DIR="$sim" HOOK_SO="$quiet_so" HOOK_QUIET=1 cargo test -- --nocapture)

for so in "$LEASH_SO" "$HOOK_SO" "$quiet_so"; do
  echo "binary: $(stat -c %s "$so") bytes at $so"
done
