// Proves the Lure hook inside real Meteora swaps on devnet.
//
// It launches a token on a Meteora bonding curve with the hook installed, caps wallets at
// 1% of supply, then trades through the curve and reports what the hook saw in each swap.
//
//   npm install
//   KEYPAIR=~/.config/solana/id.json node meteora-probe.mjs            # the cap is fixed at launch
//   KEYPAIR=~/.config/solana/id.json LEASH=1 node meteora-probe.mjs    # the cap lives in a leash, and an agent raises it
//
// Set CONFIG to a config address printed by an earlier run to reuse it and save its rent.
// The keypair pays for everything: about 0.02 devnet SOL a run.

import {
  ActivationType, BaseFeeMode, buildCurveWithMarketCap, CollectFeeMode, deriveDbcPoolAddress, deriveDbcPoolAuthority,
  DynamicBondingCurveClient, MigrationFeeOption, MigrationOption, SwapMode, TokenAuthorityOption, TokenDecimal, TokenType,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, sendAndConfirmTransaction, SystemProgram, Transaction, TransactionInstruction,
} from "@solana/web3.js";
import BN from "bn.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const HOOK = new PublicKey(process.env.HOOK_PROGRAM ?? "4akkPWLw1imyEhcqAJaHgPPrbDZr6VPaHPifVUV7K5tS");
const LEASH_PROGRAM = new PublicKey(process.env.LEASH_PROGRAM ?? "GrojbAndyBXQTo5GxgqXAmDDKjDWkPBPeGniBEQsa89p");
const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const KEYPAIR = (process.env.KEYPAIR ?? "~/.config/solana/id.json").replace(/^~/, homedir());
const WITH_LEASH = process.env.LEASH === "1";

const DECIMALS = 6;
const SUPPLY = 1_000_000_000;
const CAP = BigInt(SUPPLY / 100) * 10n ** BigInt(DECIMALS); // 1% of supply, in base units
const OVER_CAP = 6000; // HookError::OverMaxPerWallet
const PARAM_OUT_OF_BOUNDS = 7; // LeashError::ParamOutOfBounds

const connection = new Connection(RPC_URL, "confirmed");
const client = DynamicBondingCurveClient.create(connection, "confirmed");
const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEYPAIR, "utf8"))));
const sol = (n) => new BN(Math.round(n * LAMPORTS_PER_SOL));
const tokens = (base) => (Number(base) / 10 ** DECIMALS).toLocaleString("en-US", { maximumFractionDigits: 0 });
const pct = (base) => `${((Number(base) / 10 ** DECIMALS / SUPPLY) * 100).toFixed(3)}%`;
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const i64 = (n) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
const meta = (pubkey, { signer = false, writable = false } = {}) => ({ pubkey, isSigner: signer, isWritable: writable });

const send = (tx, signers = []) => sendAndConfirmTransaction(connection, tx, [wallet, ...signers]);
const startBalance = await connection.getBalance(wallet.publicKey);
console.log(`hook     ${HOOK}\nwallet   ${wallet.publicKey}  (${startBalance / LAMPORTS_PER_SOL} SOL)\nmode     ${WITH_LEASH ? "cap read from a leash" : "cap fixed at launch"}\n`);

let step = 0;
const say = (text, signature) => console.log(`\n${++step}. ${text}${signature ? `\n   ${signature}` : ""}`);
function check(label, ok) {
  if (!ok) throw new Error(`FAILED: ${label}`);
  console.log(`   check: ${label}`);
}

/* ---------------- A Meteora config that launches tokens with our hook ---------------- */

async function createConfig() {
  // A flat 1% fee, paid in SOL, on a curve that starts at 1 SOL of market cap.
  const curve = buildCurveWithMarketCap({
    token: {
      tokenType: TokenType.Token2022,
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: TokenDecimal.NINE,
      tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply: SUPPLY,
      leftover: 0,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: { startingFeeBps: 100, endingFeeBps: 100, numberOfPeriod: 0, totalDuration: 0 },
      },
      dynamicFeeEnabled: false,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: 50,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
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
    initialMarketCap: 1,
    migrationMarketCap: 20,
  });
  const config = Keypair.generate();
  const signature = await send(
    await client.partner.createConfigWithTransferHook({
      ...curve,
      config: config.publicKey,
      feeClaimer: wallet.publicKey,
      leftoverReceiver: wallet.publicKey,
      payer: wallet.publicKey,
      quoteMint: NATIVE_MINT,
      transferHookProgram: HOOK,
    }),
    [config],
  );
  say(`config with our hook: ${config.publicKey}`, signature);
  return config.publicKey;
}

const config = process.env.CONFIG ? new PublicKey(process.env.CONFIG) : await createConfig();
if (process.env.CONFIG) say(`reusing config ${config}`);

/* ---------------- The token's rules (and its leash), then the pool ---------------- */

const mint = Keypair.generate();
const agent = Keypair.generate();
const [rules, rulesBump] = PublicKey.findProgramAddressSync([Buffer.from("rules"), mint.publicKey.toBuffer()], HOOK);
const [list, listBump] = PublicKey.findProgramAddressSync([Buffer.from("extra-account-metas"), mint.publicKey.toBuffer()], HOOK);
const [leash, leashBump] = PublicKey.findProgramAddressSync(
  [Buffer.from("leash"), mint.publicKey.toBuffer(), wallet.publicKey.toBuffer()],
  LEASH_PROGRAM,
);
const poolAuthority = deriveDbcPoolAuthority();

// The mint key signs, so only whoever is launching this token can set its rules.
// The curve's own vault is exempt: it holds the whole supply.
const initRules = new TransactionInstruction({
  programId: HOOK,
  keys: [
    meta(wallet.publicKey, { signer: true, writable: true }),
    meta(mint.publicKey, { signer: true }),
    meta(rules, { writable: true }),
    meta(list, { writable: true }),
    meta(SystemProgram.programId),
  ],
  data: Buffer.concat([
    Buffer.from([0, rulesBump, listBump, 0]),
    poolAuthority.toBuffer(),
    WITH_LEASH ? leash.toBuffer() : Buffer.alloc(32),
    u64(WITH_LEASH ? 0 : CAP),
  ]),
});

// A leash that moves no SOL. Its one parameter is the cap: it starts at 1% of supply and
// the agent may move it between 0.5% and 3%.
const initLeash = new TransactionInstruction({
  programId: LEASH_PROGRAM,
  keys: [meta(wallet.publicKey, { signer: true, writable: true }), meta(leash, { writable: true }), meta(SystemProgram.programId)],
  data: Buffer.concat([
    Buffer.from([0, leashBump, 0, 1]),
    mint.publicKey.toBuffer(), agent.publicKey.toBuffer(), Buffer.alloc(64), Buffer.alloc(32),
    i64(CAP), i64(CAP / 2n), i64(CAP * 3n), u64(0), i64(0),
  ]),
});

const setup = new Transaction().add(initRules);
if (WITH_LEASH) setup.add(initLeash);
const rulesSig = await send(setup, [mint]);
say(
  WITH_LEASH
    ? `rules: the cap is read from leash ${leash} (1% now, agent may move it between 0.5% and 3%)`
    : `rules: max ${tokens(CAP)} per wallet (1%), fixed`,
  rulesSig,
);

const poolSig = await send(
  await client.creator.createPoolWithTransferHook({
    baseMint: mint.publicKey,
    config,
    name: "Lure Probe",
    symbol: "PROBE",
    uri: "https://example.com/probe.json",
    payer: wallet.publicKey,
    poolCreator: wallet.publicKey,
    transferHookProgram: HOOK,
  }),
  [mint],
);
const pool = deriveDbcPoolAddress(NATIVE_MINT, mint.publicKey, config);
say(`pool on the Meteora curve: ${pool}\n   mint ${mint.publicKey}`, poolSig);

/* ---------------- Trades through the curve ---------------- */

const myTokens = getAssociatedTokenAddressSync(mint.publicKey, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID);
const balance = async () => {
  const info = await connection.getAccountInfo(myTokens);
  return info ? info.data.readBigUInt64LE(64) : 0n;
};
const counted = async () => (await connection.getAccountInfo(rules)).data.readBigUInt64LE(112);

const swap = (amountIn, sell) =>
  client.pool.swap2WithTransferHook({
    owner: wallet.publicKey,
    payer: wallet.publicKey,
    pool,
    swapBaseForQuote: sell,
    referralTokenAccount: null,
    swapMode: SwapMode.ExactIn,
    amountIn,
    minimumAmountOut: new BN(1),
  });

const setCap = (value) =>
  new Transaction().add(
    new TransactionInstruction({
      programId: LEASH_PROGRAM,
      keys: [meta(agent.publicKey, { signer: true }), meta(leash, { writable: true })],
      data: Buffer.concat([Buffer.from([3, 0]), i64(value)]),
    }),
  );

// What the hook saw, read back from the transaction: its accounts, its one log line
// (extra accounts, amount, receiver's balance after, cap, transfers so far) and its compute.
async function report(signature) {
  let tx = null;
  for (let i = 0; i < 20 && !tx; i++) {
    tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!tx) await new Promise((r) => setTimeout(r, 500));
  }
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
  const hookIndex = [...Array(keys.length).keys()].find((i) => keys.get(i).equals(HOOK));
  const calls = tx.meta.innerInstructions.flatMap((inner) => inner.instructions).filter((ix) => ix.programIdIndex === hookIndex);
  const logs = tx.meta.logMessages;
  const at = logs.findIndex((line) => line.startsWith(`Program ${HOOK} invoke`));
  const numbers = logs.slice(at).find((line) => /^Program log: 0x/.test(line)).match(/0x[0-9a-f]+/g).map((hex) => BigInt(hex));
  const [, used, left] = logs.slice(at).find((line) => line.startsWith(`Program ${HOOK} consumed`)).match(/consumed (\d+) of (\d+)/);
  const names = {
    [pool]: "pool", [mint.publicKey]: "mint", [myTokens]: "trader's tokens", [wallet.publicKey]: "trader",
    [poolAuthority]: "pool authority", [rules]: "rules", [list]: "account list", [leash]: "leash",
  };
  const seen = calls[0].accounts.map((i) => names[keys.get(i)] ?? "curve vault");
  console.log(`   hook calls in this swap: ${calls.length}, accounts it was handed: ${seen.join(", ")}`);
  console.log(`   hook saw: moved ${tokens(numbers[1])}, receiver holds ${tokens(numbers[2])} after, cap ${tokens(numbers[3])}, transfer #${numbers[4]}`);
  console.log(`   compute: hook used ${used} with ${left} left when it started; whole transaction ${tx.meta.computeUnitsConsumed}`);
}

// Sends a transaction that a program must refuse with the given custom error.
async function refused(label, tx, signers, program, code) {
  let failure = null;
  try {
    await send(tx, signers);
  } catch (error) {
    failure = `${error.message}\n${(error.logs ?? []).join("\n")}`;
  }
  say(label);
  check("it was refused", failure !== null);
  check(`refused by ${program.equals(HOOK) ? "the hook" : "the leash"} itself, error ${code}`, failure.includes(`Program ${program} failed: custom program error: 0x${code.toString(16)}`));
}

// A small buy lands, and the hook counts it.
const buySig = await send(await swap(sol(0.003), false));
const first = await balance();
say(`buy 0.003 SOL -> ${tokens(first)} PROBE (${pct(first)} of supply)`, buySig);
await report(buySig);
check("the buy landed under the cap", first > 0n && first <= CAP);
check("the hook counted one transfer", (await counted()) === 1n);

let holding = first;
let transfers = 1n;
if (WITH_LEASH) {
  // 0.01 SOL more would take the wallet past 1%. The hook refuses it, inside the swap.
  await refused("buy 0.01 SOL more (would hold about 1.3% of supply)", await swap(sol(0.01), false), [], HOOK, OVER_CAP);
  check("nothing moved", (await balance()) === holding && (await counted()) === transfers);

  // The agent turns the knob it is allowed to turn. No other transaction touches the token.
  const raiseSig = await send(setCap(CAP * 3n), [agent]);
  say(`agent raises the cap to 3% through the leash`, raiseSig);

  // The very same buy now lands: the hook read the new cap from the leash.
  const againSig = await send(await swap(sol(0.01), false));
  holding = await balance();
  transfers += 1n;
  say(`buy 0.01 SOL more -> now holding ${tokens(holding)} PROBE (${pct(holding)} of supply)`, againSig);
  await report(againSig);
  check("the buy landed, above the old cap and under the new one", holding > CAP && holding <= CAP * 3n);
  check("the hook counted it", (await counted()) === transfers);

  // The leash still decides how far the agent can go.
  await refused("agent tries to raise the cap to 4%", setCap(CAP * 4n), [agent], LEASH_PROGRAM, PARAM_OUT_OF_BOUNDS);
} else {
  // A buy that would leave the wallet above 1% is refused by the hook, inside the swap.
  await refused("buy 0.02 SOL (about 2% of supply)", await swap(sol(0.02), false), [], HOOK, OVER_CAP);
  check("nothing moved", (await balance()) === holding && (await counted()) === transfers);
}

// Selling is never blocked: the curve's vault is exempt.
const selling = WITH_LEASH ? holding : holding / 2n;
const sellSig = await send(await swap(new BN(selling.toString()), true));
say(`sell ${tokens(selling)} PROBE back to the curve`, sellSig);
await report(sellSig);
check("the sell landed", (await balance()) === holding - selling);
check("the hook counted it", (await counted()) === transfers + 1n);

const spent = (startBalance - (await connection.getBalance(wallet.publicKey))) / LAMPORTS_PER_SOL;
console.log(`\nThe hook ran inside every Meteora swap. Cost of this run: ${spent.toFixed(4)} SOL`);
console.log(`config ${config}\nhttps://explorer.solana.com/address/${pool}?cluster=devnet`);
