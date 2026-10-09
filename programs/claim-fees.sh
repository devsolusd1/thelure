#!/bin/bash
# Claims the fees $LURE has earned into the wallet that launched it. Run from Linux or WSL.
#
#   bash claim-fees.sh           # says what is waiting, sends nothing
#   bash claim-fees.sh --send    # claims
#
# The wallet's key file is read from ~/lure-target/mainnet-wallet.json unless KEYPAIR says otherwise.
set -euo pipefail
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
cd "$(dirname "$0")/examples"
export KEYPAIR="${KEYPAIR:-$HOME/lure-target/mainnet-wallet.json}"
# The site's own RPC: the public mainnet one is slow to confirm.
export RPC_URL="${RPC_URL:-$(node -e 'process.stdout.write(require("../../net.js").rpcUrl)')}"
[ "${1:-}" = "--send" ] && export SEND=1
node claim-fees.mjs
