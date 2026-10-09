// Creates the two Meteora configs tokens launch under on Lure, on one cluster ($LURE itself has
// no hook and its own script, launch-lure.mjs). A config can never
// be edited, and it names for good who claims Lure's share of the fees: read what this
// prints before sending.
//
//   TREASURY=<address> node make-configs.mjs                       # mainnet, dry run: builds them and simulates
//   TREASURY=<address> KEYPAIR=~/wallet.json SEND=1 node make-configs.mjs
//   CLUSTER=devnet TREASURY=<address> node make-configs.mjs
//
//   TREASURY     claims Lure's share of every fee, on every token, for good (required)
//   KEYPAIR      pays the rent, about 0.006 SOL a config; without SEND=1 only PAYER's address is needed
//   START_MCAP   market cap a token starts at, in SOL (default 30)
//   GRAD_MCAP    market cap at which a graduating token moves to a Meteora pool, in SOL (default 420)
//
// The hook program has to be on the cluster first (programs/deploy.sh): Meteora checks it.
// What it made is written to configs.<cluster>.json, addresses only.

import {
  ActivationType, BaseFeeMode, buildCurveWithMarketCap, CollectFeeMode, DynamicBondingCurveClient, MigrationFeeOption,
  MigrationOption, TokenAuthorityOption, TokenDecimal, TokenType,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { NATIVE_MINT } from "@solana/spl-token";
import { clusterApiUrl, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { neverGraduating } from "./curve-check.mjs";

const CLUSTER = process.env.CLUSTER ?? "mainnet-beta";
const RPC_URL = process.env.RPC_URL ?? clusterApiUrl(CLUSTER);
const HOOK = new PublicKey(process.env.HOOK_PROGRAM ?? "4akkPWLw1imyEhcqAJaHgPPrbDZr6VPaHPifVUV7K5tS");
const SEND = process.env.SEND === "1";
const KEYPAIR = (process.env.KEYPAIR ?? "~/.config/solana/id.json").replace(/^~/, homedir());
const START = Number(process.env.START_MCAP ?? 30);
const GRAD = Number(process.env.GRAD_MCAP ?? 420);
const SUPPLY = 1_000_000_000;

if (!process.env.TREASURY) throw new Error("Set TREASURY: the address that claims Lure's share of the fees. It cannot be changed later.");
const treasury = new PublicKey(process.env.TREASURY);
const wallet = existsSync(KEYPAIR) ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEYPAIR, "utf8")))) : null;
if (SEND && !wallet) throw new Error(`SEND=1 needs the key file at ${KEYPAIR}`);
const payer = wallet ? wallet.publicKey : new PublicKey(process.env.PAYER ?? process.env.TREASURY);

// One token, one shape. `feeBps` is the whole fee a trade pays, in SOL; Meteora keeps a
// fifth of it, the creator gets `creatorShare` percent of the rest and the treasury what is left.
const curve = ({ feeBps, creatorShare }) =>
  buildCurveWithMarketCap({
    token: {
      tokenType: TokenType.Token2022, // hook configs take nothing else
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: TokenDecimal.NINE,
      tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply: SUPPLY,
      leftover: 0,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: { startingFeeBps: feeBps, endingFeeBps: feeBps, numberOfPeriod: 0, totalDuration: 0 },
      },
      dynamicFeeEnabled: false,
      // Fees in SOL. In the token, a fee claim would be a transfer out of the vault, which the hook reads as a buy.
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: creatorShare,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    // The pool a curve graduates into: a 1% fee, its liquidity locked for good, half earning
    // for the treasury and half for the creator.
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.FixedBps100,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
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
    initialMarketCap: START,
    migrationMarketCap: GRAD,
  });

const tokens = curve({ feeBps: 100, creatorShare: 50 });
const CONFIGS = {
  graduating: { what: "launched tokens that graduate, 1% fee", config: tokens },
  infinite: { what: "launched tokens on infinite bonding, 1% fee", config: neverGraduating(tokens) },
};

const connection = new Connection(RPC_URL, "confirmed");
const client = DynamicBondingCurveClient.create(connection, "confirmed");
const sol = (lamports) => Number(lamports.toString()) / LAMPORTS_PER_SOL;
const count = (n) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

console.log(`cluster   ${CLUSTER}\nhook      ${HOOK}\ntreasury  ${treasury}  (claims Lure's share on every token, for good)`);
console.log(`payer     ${payer}  (${sol(await connection.getBalance(payer))} SOL)`);
console.log(`curve     starts at ${START} SOL of market cap${" "}and, if it graduates, does so at ${GRAD} SOL of market cap`);
const hookAccount = await connection.getAccountInfo(HOOK);
const hookReady = !!hookAccount?.executable;
if (!hookReady) console.log(`\nThe hook program is not on ${CLUSTER} yet: Meteora will refuse these configs until it is. Showing what would be made.`);

const made = {};
for (const [name, { what, config }] of Object.entries(CONFIGS)) {
  const key = Keypair.generate();
  const tx = await client.partner.createConfigWithTransferHook({
    ...config,
    config: key.publicKey,
    feeClaimer: treasury,
    leftoverReceiver: treasury,
    payer,
    quoteMint: NATIVE_MINT,
    transferHookProgram: HOOK,
  });
  console.log(`\n${name}: ${what}`);
  console.log(`   graduates when ${count(sol(config.migrationQuoteThreshold))} SOL sits in the curve${name !== "graduating" && config.curve.length > 1 ? " (more than all the SOL there is)" : ""}`);
  if (!hookReady) continue;
  tx.feePayer = payer;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  const sim = await connection.simulateTransaction(tx);
  if (sim.value.err) {
    console.log(`   REFUSED in simulation: ${JSON.stringify(sim.value.err)}\n   ${(sim.value.logs ?? []).slice(-4).join("\n   ")}`);
    process.exitCode = 1;
    continue;
  }
  console.log("   simulates cleanly");
  if (!SEND) continue;
  const signature = await sendAndConfirmTransaction(connection, tx, [wallet, key]);
  made[name] = key.publicKey.toBase58();
  console.log(`   created ${key.publicKey}\n   ${signature}`);
}

if (SEND && Object.keys(made).length) {
  const file = new URL(`./configs.${CLUSTER}.json`, import.meta.url);
  writeFileSync(file, `${JSON.stringify({ cluster: CLUSTER, hook: HOOK.toBase58(), treasury: treasury.toBase58(), startMarketCap: START, graduationMarketCap: GRAD, ...made }, null, 2)}\n`);
  console.log(`\nWritten to configs.${CLUSTER}.json. Put these addresses in the site's net.js.`);
} else if (!SEND) {
  console.log("\nNothing was sent. Run again with SEND=1 and KEYPAIR to create them.");
}
