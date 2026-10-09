#!/bin/bash
# Puts the two programs on a cluster, at the addresses of their keypairs (the same on every
# cluster). Run it from Linux or WSL, after `bash test.sh` has built them.
#
#   PAYER=<address> bash deploy.sh    # mainnet: says what it would do and what it costs, sends nothing
#   bash deploy.sh --send             # mainnet: deploys
#   CLUSTER=devnet bash deploy.sh --send
#
#   KEYPAIR    pays, and is the upgrade authority afterwards (default ~/.config/solana/id.json)
#   PAYER      its address, for a look at the costs before the key file is in place
#   AUTHORITY  another address to hand the upgrade authority to once both are deployed
#   RPC_URL    an RPC of your own; the public mainnet one often drops a deploy halfway
#   PRIORITY   a price per compute unit, in micro-lamports, so the writes land on a busy cluster
#
# A deploy first writes the program into a buffer account of the same size, which is paid
# back at the end: the wallet needs about twice the rent of the bigger program while it runs.
set -euo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"

cluster="${CLUSTER:-mainnet-beta}"
url="${RPC_URL:-$cluster}"
keypair="${KEYPAIR:-$HOME/.config/solana/id.json}"
target="${LURE_TARGET:-$HOME/lure-target}"
send=no; [ "${1:-}" = "--send" ] && send=yes

# Mainnet gets the hook without its probe log line; devnet keeps it for the examples.
hook_so="$target/hook/deploy/lure_hook_quiet.so"
[ "$cluster" = "devnet" ] && hook_so="$target/hook/deploy/lure_hook.so"
names=(leash hook)
binaries=("$target/leash/deploy/lure_leash.so" "$hook_so")
keys=("$target/leash/deploy/lure_leash-keypair.json" "$target/hook/deploy/lure_hook-keypair.json")

if [ -f "$keypair" ]; then payer=$(solana address -k "$keypair")
elif [ "$send" = no ] && [ -n "${PAYER:-}" ]; then payer="$PAYER"
else echo "no key file at $keypair"; exit 1; fi
if [ -n "${PAYER:-}" ] && [ "$PAYER" != "$payer" ]; then echo "the key file is for $payer, not $PAYER"; exit 1; fi
echo "cluster  $cluster"
echo "payer    $payer  ($(solana balance "$payer" --url "$url"))"
[ -n "${AUTHORITY:-}" ] && echo "upgrade authority afterwards: $AUTHORITY"
echo

lamports() { solana rent "$1" --url "$url" --lamports | awk '{print $3}'; }
sol() { awk "BEGIN{printf \"%.4f\", $1/1e9}"; }
total=0; peak=0
for i in 0 1; do
  so="${binaries[$i]}"
  [ -f "$so" ] || { echo "missing $so: run bash test.sh first"; exit 1; }
  id=$(solana address -k "${keys[$i]}")
  size=$(stat -c %s "$so")
  # The program's data account (45 bytes of header) and the small account at its address.
  data=$(lamports $((size + 45)))
  rent=$((data + $(lamports 36)))
  if solana program show "$id" --url "$url" >/dev/null 2>&1; then state="already there: this upgrades it"; rent=0
  else state="new"; fi
  [ $((total + rent + data)) -gt "$peak" ] && peak=$((total + rent + data))
  total=$((total + rent))
  echo "${names[$i]}  $id"
  echo "  $size bytes, sha256 $(sha256sum "$so" | cut -c1-16), $state"
  echo "  rent it keeps: $(sol $rent) SOL"
done
echo
echo "Stays in the programs: $(sol $total) SOL. Needed in the wallet while deploying: about $(sol $((peak + 10000000))) SOL."

if [ "$send" = no ]; then
  echo
  echo "Nothing was sent. Run again with --send to deploy."
  exit 0
fi

for i in 0 1; do
  so="${binaries[$i]}"; id=$(solana address -k "${keys[$i]}")
  if solana program show "$id" --url "$url" >/dev/null 2>&1; then
    old=$(solana program show "$id" --url "$url" | awk '/Data Length/ {print $3}')
    grow=$(( $(stat -c %s "$so") - old ))
    if [ "$grow" -gt 0 ]; then
      [ "$grow" -lt 10240 ] && grow=10240   # the loader extends by at least 10,240 bytes
      solana program extend "$id" "$grow" --url "$url" --keypair "$keypair"
    fi
  fi
  echo "deploying ${names[$i]}..."
  solana program deploy "$so" --program-id "${keys[$i]}" --url "$url" --keypair "$keypair" --max-sign-attempts 30 \
    ${PRIORITY:+--with-compute-unit-price "$PRIORITY"}
  if [ -n "${AUTHORITY:-}" ]; then
    solana program set-upgrade-authority "$id" --new-upgrade-authority "$AUTHORITY" \
      --skip-new-upgrade-authority-signer-check --url "$url" --keypair "$keypair"
  fi
  solana program show "$id" --url "$url"
done
echo "payer now holds $(solana balance "$payer" --url "$url")"
