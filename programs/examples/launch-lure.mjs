// Launches $LURE, the token of LurePad itself, on a Meteora bonding curve: a plain token with
// no hook, so every router and terminal can trade it.
//
//   PAYER=<address> node launch-lure.mjs                   # mainnet, dry run: builds it and simulates
//   KEYPAIR=~/wallet.json SEND=1 node launch-lure.mjs      # creates the config and the token
//
//   KEYPAIR      pays, creates the token, and claims every fee it earns
//   START_USD    market cap it starts at, in dollars (default 8000)
//   GRAD_USD     market cap at which it graduates to a Meteora pool, in dollars (default 60000)
//   SOL_USD      the SOL price to convert with; read from Jupiter when not given
//   FEE_BPS      fee per trade, on the curve and in the pool after it (default 300 = 3%)
//   URI          the token's metadata (default: the file this site serves)
//   MINT_KEYPAIR a key file for the token's address, if one was made beforehand
//
// The curve is priced in SOL, so the dollar figures hold at the SOL price of the moment the
// config is created. What it made is written to lure.<cluster>.json, addresses only.

import {
  ActivationType, BaseFeeMode, buildCurveWithMarketCap, CollectFeeMode, DammV2DynamicFeeMode, deriveDbcPoolAddress,
  DynamicBondingCurveClient, MigratedCollectFeeMode, MigrationFeeOption, MigrationOption, TokenAuthorityOption, TokenDecimal, TokenType,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { NATIVE_MINT } from "@solana/spl-token";
import { clusterApiUrl, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const CLUSTER = process.env.CLUSTER ?? "mainnet-beta";
const RPC_URL = process.env.RPC_URL ?? clusterApiUrl(CLUSTER);
const SEND = process.env.SEND === "1";
const home = (path) => path.replace(/^~/, homedir());
const KEYPAIR = home(process.env.KEYPAIR ?? "~/.config/solana/id.json");
const START_USD = Number(process.env.START_USD ?? 8000);
const GRAD_USD = Number(process.env.GRAD_USD ?? 60000);
const FEE_BPS = Number(process.env.FEE_BPS ?? 300);
const TOKEN = { name: "LurePad", symbol: "LURE", uri: process.env.URI ?? "https://www.lurepad.fun/assets/lure.json" };
const SUPPLY = 1_000_000_000;

const readKey = (path) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
const wallet = existsSync(KEYPAIR) ? readKey(KEYPAIR) : null;
if (SEND && !wallet) throw new Error(`SEND=1 needs the key file at ${KEYPAIR}`);
if (!wallet && !process.env.PAYER) throw new Error("Set PAYER to the wallet's address for a dry run, or KEYPAIR to its key file.");
const owner = wallet ? wallet.publicKey : new PublicKey(process.env.PAYER);
const mint = process.env.MINT_KEYPAIR ? readKey(home(process.env.MINT_KEYPAIR)) : Keypair.generate();
const configKey = Keypair.generate();

async function solPrice() {
  if (process.env.SOL_USD) return Number(process.env.SOL_USD);
  const id = NATIVE_MINT.toBase58();
  const answer = await fetch(`https://lite-api.jup.ag/price/v3?ids=${id}`).then((r) => r.json());
  const price = answer?.[id]?.usdPrice;
  if (!(price > 0)) throw new Error("Could not read the SOL price from Jupiter. Pass it as SOL_USD.");
  return price;
}

const connection = new Connection(RPC_URL, "confirmed");
const client = DynamicBondingCurveClient.create(connection, "confirmed");
const sol = (lamports) => Number(lamports.toString()) / LAMPORTS_PER_SOL;
const count = (n, digits = 2) => n.toLocaleString("en-US", { maximumFractionDigits: digits });

const price = await solPrice();
const start = START_USD / price, grad = GRAD_USD / price;
console.log(`cluster   ${CLUSTER}\nowner     ${owner}  (${sol(await connection.getBalance(owner))} SOL)  pays, creates, and claims the fees`);
console.log(`token     ${TOKEN.name} ($${TOKEN.symbol}), ${count(SUPPLY, 0)} supply, 6 decimals, no hook, nothing can be minted or changed later`);
console.log(`metadata  ${TOKEN.uri}`);
console.log(`SOL       $${count(price)}`);
console.log(`curve     starts at $${count(START_USD, 0)} of market cap (${count(start)} SOL), graduates at $${count(GRAD_USD, 0)} (${count(grad)} SOL)`);
console.log(`fee       ${FEE_BPS / 100}% per trade, in SOL; Meteora keeps a fifth of it, the rest is the owner's to claim`);

// The site has to be serving the metadata before the token exists: terminals read it at once.
const metadata = await fetch(TOKEN.uri).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const metadataOk = metadata?.symbol === TOKEN.symbol && !!(await fetch(metadata.image, { method: "HEAD" }).catch(() => null))?.ok;
console.log(metadataOk ? `          the metadata and its image are being served` : `\nNOT READY: ${TOKEN.uri} is not being served yet, or its image is missing.`);

const config = buildCurveWithMarketCap({
  token: {
    tokenType: TokenType.SPLToken, // the plain token program: the widest support
    tokenBaseDecimal: TokenDecimal.SIX,
    tokenQuoteDecimal: TokenDecimal.NINE,
    tokenAuthorityOption: TokenAuthorityOption.Immutable,
    totalTokenSupply: SUPPLY,
    leftover: 0,
  },
  fee: {
    baseFeeParams: {
      baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
      feeSchedulerParam: { startingFeeBps: FEE_BPS, endingFeeBps: FEE_BPS, numberOfPeriod: 0, totalDuration: 0 },
    },
    dynamicFeeEnabled: false,
    collectFeeMode: CollectFeeMode.QuoteToken,
    // The creator and the fee claimer are the same wallet here, so this split changes nothing.
    creatorTradingFeePercentage: 50,
    poolCreationFee: 0,
    enableFirstSwapWithMinFee: false,
  },
  // After graduation: a Meteora pool with the same fee, its liquidity locked for good and
  // earning for the owner.
  migration: {
    migrationOption: MigrationOption.MET_DAMM_V2,
    migrationFeeOption: MigrationFeeOption.Customizable,
    migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    migratedPoolFee: { collectFeeMode: MigratedCollectFeeMode.QuoteToken, dynamicFee: DammV2DynamicFeeMode.Disabled, poolFeeBps: FEE_BPS },
  },
  liquidityDistribution: {
    partnerPermanentLockedLiquidityPercentage: 50,
    partnerLiquidityPercentage: 0,
    creatorPermanentLockedLiquidityPercentage: 50,
    creatorLiquidityPercentage: 0,
  },
  lockedVesting: {
    totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0,
    totalVestingDuration: 0, cliffDurationFromMigrationTime: 0,
  },
  activationType: ActivationType.Slot,
  initialMarketCap: start,
  migrationMarketCap: grad,
});
console.log(`          it graduates once ${count(sol(config.migrationQuoteThreshold))} SOL sits in the curve (about $${count(sol(config.migrationQuoteThreshold) * price, 0)})`);

// One transaction: the config, then the token and its pool under it. Nobody buys in it.
const tx = await client.partner.createConfigAndPool({
  ...config,
  config: configKey.publicKey,
  feeClaimer: owner,
  leftoverReceiver: owner,
  payer: owner,
  quoteMint: NATIVE_MINT,
  preCreatePoolParam: { ...TOKEN, poolCreator: owner, baseMint: mint.publicKey },
});
tx.feePayer = owner;
tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
const sim = await connection.simulateTransaction(tx);
if (sim.value.err) {
  console.log(`\nREFUSED in simulation: ${JSON.stringify(sim.value.err)}\n${(sim.value.logs ?? []).slice(-6).join("\n")}`);
  process.exit(1);
}
console.log(`\nIt simulates cleanly (${count(sim.value.unitsConsumed ?? 0, 0)} compute units).`);

if (!SEND) {
  console.log("Nothing was sent. Run again with SEND=1 and KEYPAIR to create it.");
} else if (!metadataOk) {
  console.log("Not sending: put the metadata online first.");
  process.exit(1);
} else {
  const before = await connection.getBalance(owner);
  const signature = await sendAndConfirmTransaction(connection, tx, [wallet, configKey, mint]);
  const pool = deriveDbcPoolAddress(NATIVE_MINT, mint.publicKey, configKey.publicKey);
  const out = {
    cluster: CLUSTER, mint: mint.publicKey.toBase58(), pool: pool.toBase58(), config: configKey.publicKey.toBase58(),
    owner: owner.toBase58(), solUsdAtLaunch: price, startUsd: START_USD, graduationUsd: GRAD_USD, feeBps: FEE_BPS,
  };
  writeFileSync(new URL(`./lure.${CLUSTER}.json`, import.meta.url), `${JSON.stringify(out, null, 2)}\n`);
  console.log(`\n$LURE is live.\n   contract address  ${out.mint}\n   pool              ${out.pool}\n   ${signature}`);
  console.log(`   cost: ${count(sol(before - (await connection.getBalance(owner))), 4)} SOL. Written to lure.${CLUSTER}.json.`);
}
