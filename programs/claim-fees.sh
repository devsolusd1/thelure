#!/bin/bash
# Claims the fees every $LURE launch has earned, each into the wallet that launched it.
# Run from Linux or WSL.
#
#   bash claim-fees.sh           # says what is waiting on each, sends nothing
#   bash claim-fees.sh --send    # claims all of it
#
# Each line below is one launch: the file launch-lure.mjs wrote for it, and the key file of
# the wallet that made it.
set -euo pipefail
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
cd "$(dirname "$0")/examples"
# The site's own RPC: the public mainnet one is slow to confirm.
export RPC_URL="${RPC_URL:-$(node -e 'process.stdout.write(require("../../net.js").rpcUrl)')}"
[ "${1:-}" = "--send" ] && export SEND=1

launches=(
  "lure-relaunch.mainnet-beta.json $HOME/lure-target/relaunch-wallet.json"
  "lure.mainnet-beta.json $HOME/lure-target/mainnet-wallet.json"
)
for launch in "${launches[@]}"; do
  read -r file key <<<"$launch"
  [ -f "$file" ] || continue
  echo "================ $(node -e 'const l=require("./"+process.argv[1]); process.stdout.write("$LURE at "+l.mint)' "$file")"
  POOL="$(node -e 'process.stdout.write(require("./"+process.argv[1]).pool)' "$file")" KEYPAIR="$key" node claim-fees.mjs 2>&1 | grep -v "bigint: Failed" || true
  echo
done
