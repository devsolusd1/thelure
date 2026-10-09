// Claims the trading fees a wallet has earned on a Meteora curve, as partner (it made the
// config) and as creator (it made the pool), into that same wallet.
//
//   PAYER=<address> node claim-fees.mjs                 # says what is waiting and simulates the claims
//   KEYPAIR=~/wallet.json SEND=1 node claim-fees.mjs    # claims
//
//   POOL     the pool to claim from (default: $LURE's, from lure.<cluster>.json)
//   KEYPAIR  the wallet that made the config and the pool; it also pays the network fee
//
// Meteora's own share stays in the pool for Meteora.

import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { clusterApiUrl, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import BN from "bn.js";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

const CLUSTER = process.env.CLUSTER ?? "mainnet-beta";
const RPC_URL = process.env.RPC_URL ?? clusterApiUrl(CLUSTER);
const SEND = process.env.SEND === "1";
const KEYPAIR = (process.env.KEYPAIR ?? "~/.config/solana/id.json").replace(/^~/, homedir());
const U64_MAX = new BN("18446744073709551615");

const launched = new URL(`./lure.${CLUSTER}.json`, import.meta.url);
const poolAddress = process.env.POOL ?? (existsSync(launched) ? JSON.parse(readFileSync(launched, "utf8")).pool : null);
if (!poolAddress) throw new Error("Set POOL to the pool's address.");
const pool = new PublicKey(poolAddress);

const wallet = existsSync(KEYPAIR) ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEYPAIR, "utf8")))) : null;
if (SEND && !wallet) throw new Error(`SEND=1 needs the key file at ${KEYPAIR}`);
if (!wallet && !process.env.PAYER) throw new Error("Set PAYER to the wallet's address for a dry run, or KEYPAIR to its key file.");
const me = wallet ? wallet.publicKey : new PublicKey(process.env.PAYER);

const connection = new Connection(RPC_URL, "confirmed");
const client = DynamicBondingCurveClient.create(connection, "confirmed");
const sol = (lamports) => (Number(lamports.toString()) / LAMPORTS_PER_SOL).toLocaleString("en-US", { maximumFractionDigits: 6 });
const read = async () => { const found = await client.state.getPool(pool); return found.poolState ?? found; };

const state = await read();
const before = await connection.getBalance(me);
console.log(`cluster  ${CLUSTER}\npool     ${pool}\nwallet   ${me}  (${sol(before)} SOL)`);
console.log(`waiting  ${sol(state.partnerQuoteFee)} SOL as partner, ${sol(state.creatorQuoteFee)} SOL as creator: ${sol(state.partnerQuoteFee.add(state.creatorQuoteFee))} SOL in all`);
console.log(`         (${sol(state.protocolQuoteFee)} SOL more is Meteora's and stays in the pool)`);

const shared = { payer: me, pool, maxBaseAmount: U64_MAX, maxQuoteAmount: U64_MAX, receiver: me };
const claims = [
  ["partner", state.partnerQuoteFee, () => client.partner.claimPartnerTradingFee({ ...shared, feeClaimer: me })],
  ["creator", state.creatorQuoteFee, () => client.creator.claimCreatorTradingFee({ ...shared, creator: me })],
];

for (const [who, owed, build] of claims) {
  if (owed.isZero()) { console.log(`\n${who}: nothing to claim`); continue; }
  const tx = await build();
  tx.feePayer = me;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  const sim = await connection.simulateTransaction(tx);
  if (sim.value.err) {
    console.log(`\n${who}: REFUSED in simulation: ${JSON.stringify(sim.value.err)}\n${(sim.value.logs ?? []).slice(-5).join("\n")}`);
    process.exitCode = 1;
    continue;
  }
  if (!SEND) { console.log(`\n${who}: the claim of ${sol(owed)} SOL simulates cleanly`); continue; }
  const signature = await sendAndConfirmTransaction(connection, tx, [wallet]);
  console.log(`\n${who}: claimed ${sol(owed)} SOL\n   ${signature}`);
}

if (SEND) {
  const after = await connection.getBalance(me);
  console.log(`\nThe wallet went from ${sol(before)} to ${sol(after)} SOL (${sol(after - before)} SOL more, network fees paid).`);
} else {
  console.log("\nNothing was sent. Run again with SEND=1 and KEYPAIR to claim.");
}
