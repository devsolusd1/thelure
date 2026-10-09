// Two curves for a Lure token on Meteora's bonding curve (DBC): one that graduates and one
// that never does ("infinite bonding").
//
// When a curve graduates, Meteora moves the token to a normal pool and removes its hook, so
// the token's rules stop. A creator who wants the rules for the life of the token needs a
// curve that cannot graduate. DBC has no switch for that: a curve graduates when the SOL it
// holds reaches a threshold written in its config. The infinite curve below is the graduating
// one with that threshold set to more SOL than exists.
//
//   npm install
//   KEYPAIR=~/.config/solana/id.json node curve-check.mjs           # both curves side by side, then asks devnet if it accepts the infinite one. Free.
//   KEYPAIR=~/.config/solana/id.json SEND=1 node curve-check.mjs    # also creates it: config, a token with our hook, a buy, a sell, the fees claimed
//
// Set CONFIG to a config address printed by an earlier run to reuse it and save its rent. The
// run of 9 October 2026 left 6BDwLdwv8hdcvEVVvcxZjCzGFWYEB12BxRbNyWJPXTdG on devnet. That one
// has a 10 billion SOL threshold, from before the default below became 9 billion; it still
// works with CONFIG, the pool, the trades and the claims are the same on either.
// SEND=1 costs about 0.017 devnet SOL, 0.011 with CONFIG. Every transaction is simulated first,
// and the run stops before one that would take it past BUDGET (0.02 SOL unless you set it).

import {
  ActivationType, BaseFeeMode, buildCurveWithMarketCap, calculateQuoteToBaseFromAmountIn, CollectFeeMode, DAMM_V2_MIGRATION_FEE_ADDRESS,
  deriveDbcPoolAddress, deriveDbcPoolAuthority, DynamicBondingCurveClient, getBaseTokenForSwap, getInitialLiquidityFromDeltaBase,
  getMigrationBaseToken, getMigrationThresholdPrice, getPriceFromSqrtPrice, MAX_SQRT_PRICE, MigrationFeeOption, MigrationOption,
  SwapMode, TokenAuthorityOption, TokenDecimal, TokenType,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { createCloseAccountInstruction, getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, sendAndConfirmTransaction, SystemProgram, Transaction, TransactionInstruction,
} from "@solana/web3.js";
import BN from "bn.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

const HOOK = new PublicKey(process.env.HOOK_PROGRAM ?? "4akkPWLw1imyEhcqAJaHgPPrbDZr6VPaHPifVUV7K5tS");
const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const KEYPAIR = (process.env.KEYPAIR ?? "~/.config/solana/id.json").replace(/^~/, homedir());
const SEND = process.env.SEND === "1";
const BUDGET = Math.round(Number(process.env.BUDGET ?? 0.02) * LAMPORTS_PER_SOL);

const DECIMALS = 6;
const SUPPLY = 1_000_000_000;
const ONE_SOL = new BN(LAMPORTS_PER_SOL);
const U64_MAX = new BN("18446744073709551615");

/* ---------------- The two curves ---------------- */

// What both curves share: the token, a flat 1% fee paid in SOL and split evenly between us
// and the creator, and the settings for the pool a curve graduates into.
const shared = {
  token: {
    tokenType: TokenType.Token2022, // hook configs take nothing else
    tokenBaseDecimal: TokenDecimal.SIX,
    tokenQuoteDecimal: TokenDecimal.NINE,
    tokenAuthorityOption: TokenAuthorityOption.Immutable,
    totalTokenSupply: SUPPLY,
    // Leftover tokens are only handed out after graduation. On the infinite curve anything
    // put here would stay locked for good, so it has to be 0.
    leftover: 0,
  },
  fee: {
    baseFeeParams: {
      baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
      feeSchedulerParam: { startingFeeBps: 100, endingFeeBps: 100, numberOfPeriod: 0, totalDuration: 0 },
    },
    dynamicFeeEnabled: false,
    collectFeeMode: CollectFeeMode.QuoteToken, // fees build up in SOL, on buys and on sells
    creatorTradingFeePercentage: 50,
    poolCreationFee: 0,
    enableFirstSwapWithMinFee: false,
  },
  // The infinite curve never uses the rest, but the program checks all of it anyway: the pool
  // type must be DAMM v2, a migration fee of 0 needs a creator share of 0, and the four
  // liquidity shares must add up to 100 with at least 10 of it locked.
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
  // Vested tokens are also only released after graduation: 0 on the infinite curve.
  lockedVesting: {
    totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0,
    totalVestingDuration: 0, cliffDurationFromMigrationTime: 0,
  },
  activationType: ActivationType.Slot,
};

// Starts at 1 SOL of market cap and graduates at 20, as in meteora-probe.mjs. 81.7% of the
// supply is sold on the way; the other 18.3% goes into the pool it graduates to.
export const graduating = buildCurveWithMarketCap({ ...shared, initialMarketCap: 1, migrationMarketCap: 20 });

// The SOL the infinite curve would have to hold, all at once, before it graduated: 9 billion,
// 14 times all the SOL there is. The program keeps this number as a u64 of lamports and takes
// anything up to 18.4 billion SOL, but 9 billion is the largest round number that also fits a
// signed 64-bit integer (9.22 billion SOL), which is how many indexers and databases hold
// amounts. On mainnet on 9 October 2026 DexScreener listed none of the 101 hook pools whose
// threshold is above that limit (10 and 17.3 billion SOL), and did list pools with thresholds
// of 1, 5.2 and 9 billion. The cause is not proven; staying under the limit costs nothing.
export const NEVER = new BN(9_000_000_000).mul(ONE_SOL);
// All the SOL there is, locked and staked included (mainnet getSupply, 9 October 2026).
const SOL_THAT_EXISTS = 635_537_206;

// Meteora's builders cannot make this curve. buildCurveWithMarketCap stops with "Not enough
// liquidity" once the graduation market cap passes 1,000,000 SOL, which for this start is a
// threshold of only 999 SOL. buildCurveWithCustomSqrtPrices reaches 10 billion SOL with one
// flat stretch, but that curve is 5% shallower than the graduating one from the first buy.
// So the infinite curve is the graduating config with two fields replaced:
//   - the threshold becomes NEVER;
//   - the curve keeps its first stretch, up to 20 SOL of market cap, exactly as it is, so both
//     curves start the same. Then the tokens the graduating curve would have sent to its pool
//     are sold on a second stretch that runs to the highest price the program allows.
// A little is held back. The program still sets tokens aside for the pool that will never
// exist (0.07 of a token here) and checks that everything fits in the supply; with nothing
// held back it answers InvalidTokenSupply.
export const infinite = neverGraduating(graduating);

// Takes a config from buildCurveWithMarketCap, whose first stretch ends where it graduates.
export function neverGraduating(config) {
  const { amountPerPeriod, numberOfPeriod, cliffUnlockAmount } = config.lockedVesting;
  if (!amountPerPeriod.mul(numberOfPeriod).add(cliffUnlockAmount).isZero()) {
    throw new Error("neverGraduating: vested tokens are only released after graduation, so they would be locked for good");
  }
  const first = config.curve[0];
  const supply = config.tokenSupply.preMigrationTokenSupply;
  const soldOnFirst = getBaseTokenForSwap(config.sqrtStartPrice, first.sqrtPrice, [first]);
  const holdingBack = (heldBack) => {
    const rest = supply.sub(soldOnFirst).sub(heldBack);
    const second = { sqrtPrice: MAX_SQRT_PRICE, liquidity: getInitialLiquidityFromDeltaBase(rest, MAX_SQRT_PRICE, first.sqrtPrice) };
    return { ...config, migrationQuoteThreshold: NEVER, curve: [first, second] };
  };
  // What the program will set aside for the pool. It grows with the price the first stretch
  // ends at: 0.07 of a token for a 1 to 20 SOL curve, 3.1 tokens for 45 to 600 SOL.
  const forPool = (made) => getMigrationBaseToken(NEVER, getMigrationThresholdPrice(NEVER, made.sqrtStartPrice, made.curve), made.migrationOption);
  // Hold back one whole token, or twice what is set aside for the pool if that is more (the
  // amount set aside is at its largest with nothing held back). A fixed 10^6 base units only
  // worked for this one curve: the program refused the same recipe with 9 decimals, and with
  // a 30 SOL start.
  const oneToken = new BN(10).pow(new BN(config.tokenDecimal));
  const made = holdingBack(BN.max(oneToken, forPool(holdingBack(new BN(0))).muln(2)));
  // The program's own check: all the curve could ever sell, plus the pool's share, fits in the supply.
  if (getBaseTokenForSwap(made.sqrtStartPrice, MAX_SQRT_PRICE, made.curve).add(forPool(made)).gt(supply)) {
    throw new Error("neverGraduating: the curve does not fit in the supply, the program would answer InvalidTokenSupply");
  }
  return made;
}

/* ---------------- What trading on each looks like ---------------- */

const tokens = (base) => Number(base.toString()) / 10 ** DECIMALS;
const inSol = (lamports) => Number(lamports.toString()) / LAMPORTS_PER_SOL;
const count = (n) => n.toLocaleString("en-US", { maximumFractionDigits: n < 1000 ? 3 : 0 });
// Sizes a number for the table: 3.803, 14,972, 1.50e+20.
const size = (d) => (d.gte(1e15) ? d.toExponential(2) : d.gte(1000) ? count(Number(d.toFixed(0))) : d.toSignificantDigits(4).toString());
const marketCap = (sqrtPrice) => getPriceFromSqrtPrice(sqrtPrice, DECIMALS, 9).mul(SUPPLY); // in SOL
// The price at which a curve is full: buys stop here and the curve graduates.
const stopPrice = (config) => getMigrationThresholdPrice(config.migrationQuoteThreshold, config.sqrtStartPrice, config.curve);

// Where a curve stands once `lamports` of SOL have reached it, by Meteora's own curve walk.
// Fees are left out: with the 1% fee, buyers have paid 1/0.99 of this.
function after(config, lamports) {
  const stop = stopPrice(config);
  const walk = calculateQuoteToBaseFromAmountIn(config, config.sqrtStartPrice, lamports, stop);
  return {
    price: getPriceFromSqrtPrice(walk.nextSqrtPrice, DECIMALS, 9),
    cap: marketCap(walk.nextSqrtPrice),
    left: tokens(config.tokenSupply.preMigrationTokenSupply.sub(walk.outputAmount)),
    full: walk.nextSqrtPrice.gte(stop),
  };
}

function describe(name, config) {
  const stop = stopPrice(config);
  const forSale = getBaseTokenForSwap(config.sqrtStartPrice, stop, config.curve);
  const forPool = getMigrationBaseToken(config.migrationQuoteThreshold, stop, config.migrationOption);
  console.log(`${name}`);
  console.log(`  starts at              ${size(marketCap(config.sqrtStartPrice))} SOL of market cap`);
  console.log(`  graduates on holding   ${count(inSol(config.migrationQuoteThreshold))} SOL, at a market cap of ${size(marketCap(stop))} SOL`);
  console.log(`  for sale on the curve  ${count(tokens(forSale))} tokens (${((tokens(forSale) / SUPPLY) * 100).toFixed(7)}% of supply)`);
  console.log(`  set aside for a pool   ${count(tokens(forPool))} tokens`);
  config.curve.forEach((point, i) => console.log(`  stretch ${i + 1}              up to ${size(marketCap(point.sqrtPrice))} SOL of market cap, liquidity ${point.liquidity}`));
}

function table() {
  const rows = [
    ["0", new BN(0)],
    ["1", ONE_SOL],
    [inSol(graduating.migrationQuoteThreshold).toString(), graduating.migrationQuoteThreshold],
    ...[10, 100, 1_000, 10_000, 100_000].map((n) => [count(n), new BN(n).mul(ONE_SOL)]),
    [`${count(SOL_THAT_EXISTS)} (all SOL)`, new BN(SOL_THAT_EXISTS).mul(ONE_SOL)],
    [`${count(inSol(NEVER))} (threshold)`, NEVER],
  ];
  const columns = (cells, widths) => cells.map((cell, i) => cell.padEnd(widths[i])).join("");
  const [first, left, right] = [[29], [13, 16], [12, 17, 16, 0]];
  console.log(columns(["", "GRADUATING", "INFINITE"], [29, 29, 0]));
  console.log(columns(["SOL in the curve"], first) + columns(["market cap", "tokens left"], left) + columns(["price", "market cap", "tokens left", "of supply"], right));
  let graduated = false;
  for (const [label, lamports] of rows) {
    const g = after(graduating, lamports);
    const i = after(infinite, lamports);
    console.log(
      columns([label], first) +
        (graduated ? columns(["graduated, hook removed"], [29]) : columns([size(g.cap), count(g.left) + (g.full ? " *" : "")], left)) +
        columns([i.price.toExponential(3), size(i.cap), count(i.left), `${((i.left / SUPPLY) * 100).toPrecision(3)}%${i.full ? " *" : ""}`], right),
    );
    graduated ||= g.full;
  }
  console.log("* the curve is full here: it graduates and the hook is removed. Price is SOL per token, market cap is in SOL.");
}

/* ---------------- Devnet: does Meteora take the infinite curve, and does it trade? ---------------- */

async function main() {
  describe("GRADUATING", graduating);
  describe("\nINFINITE", infinite);
  console.log(`  ${count(SOL_THAT_EXISTS)} SOL exist. The threshold is ${(inSol(NEVER) / SOL_THAT_EXISTS).toFixed(1)} times that.\n`);
  table();

  const connection = new Connection(RPC_URL, "confirmed");
  const client = DynamicBondingCurveClient.create(connection, "confirmed");
  const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEYPAIR, "utf8"))));
  const me = wallet.publicKey;
  const startBalance = await connection.getBalance(me);
  const sol = (lamports) => (Number(lamports) / LAMPORTS_PER_SOL).toFixed(6);
  const meta = (pubkey, { signer = false, writable = false } = {}) => ({ pubkey, isSigner: signer, isWritable: writable });
  console.log(`\nhook     ${HOOK}\nwallet   ${me}  (${startBalance / LAMPORTS_PER_SOL} SOL)\nmode     ${SEND ? `sending, up to ${sol(BUDGET)} SOL` : "simulation only (SEND=1 to send)"}`);

  let step = 0;
  const say = (text, signature) => console.log(`\n${++step}. ${text}${signature ? `\n   ${signature}` : ""}`);
  const check = (label, ok) => {
    if (!ok) throw new Error(`FAILED: ${label}`);
    console.log(`   check: ${label}`);
  };

  // Runs a transaction on the cluster without sending it, with real signatures. Gives the
  // program's own reason if it is refused, and what the wallet would hold afterwards if not.
  async function simulate(tx, signers = []) {
    tx.feePayer = me;
    const { err, logs, unitsConsumed, accounts } = (await connection.simulateTransaction(tx, [wallet, ...signers], [me])).value;
    const text = (logs ?? []).join("\n");
    return { refused: err ? text.match(/Error Code: (\w+)/)?.[1] ?? JSON.stringify(err) : null, text, units: unitsConsumed, walletAfter: accounts?.[0]?.lamports };
  }

  // Simulates first, then sends, unless the simulation fails or the run would go over budget.
  async function send(label, tx, signers = []) {
    const trial = await simulate(tx, signers);
    if (trial.refused) throw new Error(`${label} would fail (${trial.refused}):\n${trial.text}`);
    const spent = startBalance - trial.walletAfter;
    if (!(spent <= BUDGET)) throw new Error(`stopped before "${label}": it would bring the run to ${sol(spent)} SOL, over the budget of ${sol(BUDGET)}`);
    return sendAndConfirmTransaction(connection, tx, [wallet, ...signers]);
  }

  // The config. This is where the program checks the curve.
  const configKey = Keypair.generate();
  const createConfig = await client.partner.createConfigWithTransferHook({
    ...infinite,
    config: configKey.publicKey,
    feeClaimer: me,
    leftoverReceiver: me,
    payer: me,
    quoteMint: NATIVE_MINT,
    transferHookProgram: HOOK,
  });
  const trial = await simulate(createConfig, [configKey]);
  say("simulated: create the infinite config with our hook");
  if (trial.refused) console.log(trial.text);
  check(`the program accepts it (${trial.units} compute units, ${sol(startBalance - trial.walletAfter)} SOL of rent and fee)`, trial.refused === null);
  if (!SEND) return console.log("\nNothing was sent. Run again with SEND=1 to create it and trade on it.");

  let config = configKey.publicKey;
  if (process.env.CONFIG) {
    config = new PublicKey(process.env.CONFIG);
    say(`reusing config ${config}`);
  } else {
    say(`infinite config: ${config}`, await send("config", createConfig, [configKey]));
  }
  const stored = await client.state.getPoolConfig(config);
  // A config from an earlier run may carry a higher threshold than today's; never a lower one.
  const threshold = stored.migrationQuoteThreshold;
  check(`the program stored a threshold of ${count(inSol(threshold))} SOL, ${(inSol(threshold) / SOL_THAT_EXISTS).toFixed(1)} times all the SOL that exists`, process.env.CONFIG ? threshold.gte(NEVER) : threshold.eq(NEVER));
  console.log(`   it worked out: graduation at ${size(marketCap(stored.migrationSqrtPrice))} SOL of market cap, ${count(tokens(stored.swapBaseAmount))} tokens for sale, ${count(tokens(stored.migrationBaseThreshold))} set aside`);

  // A token on it, with our hook. No wallet cap: this run is about the curve.
  // The rules data below is what the hook deployed on 9 October 2026 expects (tag, two bumps,
  // leash parameter, exempt owner, leash, cap). When a newer hook is deployed, take the data
  // from meteora-probe.mjs, and the offset of its transfer counter further down.
  const mint = Keypair.generate();
  const [rules, rulesBump] = PublicKey.findProgramAddressSync([Buffer.from("rules"), mint.publicKey.toBuffer()], HOOK);
  const [list, listBump] = PublicKey.findProgramAddressSync([Buffer.from("extra-account-metas"), mint.publicKey.toBuffer()], HOOK);
  const initRules = new TransactionInstruction({
    programId: HOOK,
    keys: [meta(me, { signer: true, writable: true }), meta(mint.publicKey, { signer: true }), meta(rules, { writable: true }), meta(list, { writable: true }), meta(SystemProgram.programId)],
    data: Buffer.concat([Buffer.from([0, rulesBump, listBump, 0]), deriveDbcPoolAuthority().toBuffer(), Buffer.alloc(32), Buffer.alloc(8)]),
  });
  const createPool = await client.creator.createPoolWithTransferHook({
    baseMint: mint.publicKey,
    config,
    name: "Lure Curve Check",
    symbol: "CURVE",
    uri: "https://example.com/curve.json",
    payer: me,
    poolCreator: me,
    transferHookProgram: HOOK,
  });
  const poolSig = await send("token and pool", new Transaction().add(initRules, ...createPool.instructions), [mint]);
  const pool = deriveDbcPoolAddress(NATIVE_MINT, mint.publicKey, config);
  say(`pool on the infinite curve: ${pool}\n   mint ${mint.publicKey}`, poolSig);

  const myTokens = getAssociatedTokenAddressSync(mint.publicKey, me, false, TOKEN_2022_PROGRAM_ID);
  const balance = async () => {
    const info = await connection.getAccountInfo(myTokens);
    return info ? info.data.readBigUInt64LE(64) : 0n;
  };
  const poolNow = async () => (await client.state.getPool(pool)).poolState;
  // The hook counts every transfer it lets through, in its own account.
  const counted = async () => (await connection.getAccountInfo(rules)).data.readBigUInt64LE(112);
  const swap = (amountIn, sell) =>
    client.pool.swap2WithTransferHook({
      owner: me,
      payer: me,
      pool,
      swapBaseForQuote: sell,
      referralTokenAccount: null,
      swapMode: SwapMode.ExactIn,
      amountIn,
      minimumAmountOut: new BN(1),
    });

  // A small buy. Both curves share their first stretch, so the graduating curve would have
  // paid out the very same tokens.
  const paid = new BN(1_000_000); // 0.001 SOL
  const onGraduating = client.pool.getQuoteFromInputAmount({ config: graduating, swapBaseForQuote: false, amountIn: paid });
  const buySig = await send("buy", await swap(paid, false));
  const bought = await balance();
  let state = await poolNow();
  say(`buy ${sol(paid)} SOL -> ${count(tokens(bought))} CURVE, market cap now ${size(marketCap(state.sqrtPrice))} SOL`, buySig);
  check("the buy landed, and the hook ran inside it", bought > 0n && (await counted()) === 1n);
  check("the graduating curve gives exactly as many for the same buy", bought === BigInt(onGraduating.outputAmount.toString()));
  console.log(`   the curve holds ${sol(state.quoteReserve)} SOL: ${((inSol(state.quoteReserve) / inSol(threshold)) * 100).toExponential(2)}% of the way to graduating`);

  // What only opens at graduation. Nobody can open it early: each is refused by the program.
  const migrate = await client.migration.migrateToDammV2({ payer: me, pool, dammConfig: DAMM_V2_MIGRATION_FEE_ADDRESS[MigrationFeeOption.FixedBps100] });
  const closed = [
    ["move the curve to a pool", migrate.transaction, [migrate.firstPositionNftKeypair, migrate.secondPositionNftKeypair]],
    ["partner takes surplus SOL", await client.partner.partnerWithdrawSurplus({ feeClaimer: me, pool }), []],
    ["creator takes surplus SOL", await client.creator.creatorWithdrawSurplus({ creator: me, pool }), []],
    ["partner takes a migration fee", await client.partner.partnerWithdrawMigrationFee({ sender: me, pool }), []],
    ["creator takes a migration fee", await client.creator.creatorWithdrawMigrationFee({ sender: me, pool }), []],
    ["take leftover tokens", await client.migration.withdrawLeftover({ payer: me, pool }), []],
  ];
  say("simulated: everything that waits for graduation");
  for (const [label, tx, signers] of closed) {
    const { refused } = await simulate(tx, signers);
    check(`${label}: refused (${refused})`, refused === "NotPermitToDoThisAction");
  }

  // Selling: the SOL comes straight back out of the curve.
  const sellSig = await send("sell", await swap(new BN(bought.toString()), true));
  state = await poolNow();
  say(`sell all ${count(tokens(bought))} CURVE back to the curve`, sellSig);
  check("the sell landed, and the hook ran inside it", (await balance()) === 0n && (await counted()) === 2n);
  console.log(`   the curve holds ${sol(state.quoteReserve)} SOL again, market cap ${size(marketCap(state.sqrtPrice))} SOL`);

  // Trading fees, in SOL, claimed while the token is still on its curve. This wallet is both
  // the partner (it made the config) and the creator (it made the pool).
  const claims = [
    ["partner", state.partnerQuoteFee, () => client.partner.claimPartnerTradingFee2({ feeClaimer: me, payer: me, pool, maxBaseAmount: U64_MAX, maxQuoteAmount: U64_MAX, receiver: me })],
    ["creator", state.creatorQuoteFee, () => client.creator.claimCreatorTradingFee2({ creator: me, payer: me, pool, maxBaseAmount: U64_MAX, maxQuoteAmount: U64_MAX, receiver: me })],
  ];
  for (const [who, owed, build] of claims) {
    const before = await connection.getBalance(me);
    const claimSig = await send(`${who} claim`, await build());
    const gained = (await connection.getBalance(me)) - before;
    say(`${who} claims its trading fees: ${owed} lamports`, claimSig);
    check("the wallet received them as SOL (less the 5,000 lamport network fee)", gained === Number(owed) - 5000);
  }
  state = await poolNow();
  check("nothing is left waiting for partner or creator", state.partnerQuoteFee.isZero() && state.creatorQuoteFee.isZero());
  console.log(`   Meteora's own cut, ${state.protocolQuoteFee} lamports, stays in the pool for Meteora to collect`);

  // The token account is empty: close it to get its rent back.
  await send("close", new Transaction().add(createCloseAccountInstruction(myTokens, me, me, [], TOKEN_2022_PROGRAM_ID)));

  const spent = (startBalance - (await connection.getBalance(me))) / LAMPORTS_PER_SOL;
  console.log(`\nThe infinite curve is live on devnet and trades through the hook. Cost of this run: ${spent.toFixed(6)} SOL`);
  console.log(`config ${config}\nhttps://explorer.solana.com/address/${pool}?cluster=devnet`);
}

// Importing this file only gives the two configs. Running it does the rest.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
