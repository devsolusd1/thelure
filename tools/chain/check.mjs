// Checks the chain layer against the cluster in net.js, by SIMULATION ONLY: nothing is signed
// and nothing is sent. It imports the same entry module the browser bundle is built from.
//
//   npm run check                         (devnet today; the demo token of net.js)
//   OWNER=<address> npm run check         (simulate for another funded wallet)
//
// It simulates a buy and a sell on the demo token, a settle, and a whole launch (game on, an
// agent with a small budget, infinite bonding, a first buy), and says of each transaction
// whether it simulated cleanly or could only be built.

import { Keypair } from "@solana/web3.js";
import * as chain from "./src/index.mjs";

const net = chain.net();
if (process.env.RPC_URL) net.rpcUrl = process.env.RPC_URL;
const OWNER = process.env.OWNER ?? "7f2MiAuyJ1Aaiheo9ctLgJmzGDWoDceyHEEuVB2mhPAA";
const MINT = process.env.MINT ?? net.demo.mint;

let failed = 0;
const line = (ok, text) => { if (!ok) failed++; console.log(`${ok ? "  ok  " : "  FAIL"} ${text}`); };
const show = (label, r) => `${label}: ${r.ok ? "simulated cleanly" : `refused, ${chain.refusalText(r.refusal)}`} (${r.units ?? "?"} units, ${r.bytes} bytes, slot ${r.slot})`;
const tail = (r) => r.logs.slice(-6).map((l) => `         ${l}`).join("\n");

console.log(`cluster ${net.cluster}  rpc ${net.rpcUrl}\nowner   ${OWNER}\nmint    ${MINT}\n`);
if (!net.ready) { console.log(net.notReady()); process.exit(1); }

/* ---- reading ---- */
const token = await chain.readToken(MINT);
const g = token.rules && token.rules.game;
console.log(`1. read  ${token.name} ($${token.symbol})  curve ${token.curve}  pool ${token.pool}`);
console.log(`         price ${token.price.toExponential(4)} SOL  market cap ${token.marketCap.toFixed(4)} SOL  in curve ${token.solInCurve} SOL  supply left ${(token.supplyLeft * 100).toFixed(4)}%`);
console.log(`         cap ${token.rules.cap ? `${token.rules.cap.tokens} (${token.rules.cap.share * 100}%)` : "none"}  block limit ${token.rules.blockLimit ? `${token.rules.blockLimit.tokens}, guard ${token.rules.blockLimit.up ? "up" : "down"}` : "none"}`);
if (g) console.log(`         game: ${g.phase}, round ${g.round}, pot ${g.pot} SOL, clock ${g.clock}s${g.clockFromLeash ? " (leash)" : ""}, deadline ${g.deadline}, last buyer ${g.lastBuyer}, last winner ${g.lastWinner} (${g.lastPrize} SOL), min buy ${g.minBuy}`);
console.log(`         leash ${token.leash}  agent ${token.agent}  slot ${token.slot}  chain time ${token.chainTime} (skew ${token.clockSkew}s)`);
line(token.curve === "infinite" && !!g && token.rules.curveOk && token.hooked, "the demo token reads as a hooked token on the infinite curve, playing the game");
const wallet = await chain.readWallet(OWNER, MINT);
console.log(`         wallet holds ${wallet.sol} SOL and ${wallet.tokens} ${token.symbol}`);
const board = await chain.listTokens();
line(board.some((t) => t.mint === token.mint), `the board lists ${board.length} token(s) under the two configs, the demo among them`);

/* ---- buy ---- */
const buy = await chain.buildBuy({ mint: MINT, owner: OWNER, sol: 0.001 });
console.log(`\n2. buy 0.001 SOL -> ${buy.quote.out} ${token.symbol} (min ${buy.quote.minOut}), fee ${buy.quote.fee} SOL`);
for (const c of buy.quote.checks) console.log(`         ${c.ok ? "+" : "x"} ${c.text}`);
const buySim = await chain.simulate(buy);
line(buySim.ok, show("buy", buySim));
if (!buySim.ok) console.log(tail(buySim));

const tipped = await chain.buildBuy({ mint: MINT, owner: OWNER, sol: 0.001, priorityMicroLamports: 20000 });
const tippedSim = await chain.simulate(tipped);
line(tippedSim.ok, show("the same buy with a priority fee (as on mainnet)", tippedSim));

/* ---- sell ---- */
const amount = Math.min(wallet.tokens, 1000);
if (amount > 0) {
  const sell = await chain.buildSell({ mint: MINT, owner: OWNER, tokens: amount });
  console.log(`\n3. sell ${amount} ${token.symbol} -> ${sell.quote.out} SOL (min ${sell.quote.minOut}), fee ${sell.quote.fee} SOL`);
  const sellSim = await chain.simulate(sell);
  line(sellSim.ok, show("sell", sellSim));
  if (!sellSim.ok) console.log(tail(sellSim));
} else {
  line(false, "sell: the owner holds none of the token, so a sell could not be simulated");
}

/* ---- a buy the hook must refuse: over the wallet cap ---- */
if (token.rules.cap) {
  // Enough SOL to take the wallet past the cap, with half as much again for the price moving.
  const spend = Math.max(0.002, (token.rules.cap.tokens - wallet.tokens) * token.price * 1.5).toFixed(4);
  const big = await chain.buildBuy({ mint: MINT, owner: OWNER, sol: spend });
  console.log(`\n4. a ${spend} SOL buy would give ${big.quote.out} ${token.symbol}; predicted: ${big.quote.refusal ? big.quote.refusal.text : "no refusal"}`);
  const bigSim = await chain.simulate(big);
  console.log(`         ${show("over-cap buy", bigSim)}`);
  line(!!big.quote.refusal && big.quote.refusal.code === 6000 && !bigSim.ok && bigSim.refusal.by === "hook" && bigSim.refusal.code === 6000,
    "the hook itself refuses it with OverMaxPerWallet (6000), as the quote predicted");
}

/* ---- settle ---- */
console.log("\n5. settle");
try {
  const settle = await chain.buildSettle({ mint: MINT, payer: OWNER });
  const settleSim = await chain.simulate(settle);
  const expected = g.phase === "over" ? settleSim.ok : !settleSim.ok && settleSim.refusal.name === "RoundNotOver";
  line(expected, `${show("settle", settleSim)}  [the round is "${g.phase}"]`);
} catch (error) {
  line(error.kind === "round-not-over" && !g.lastBuyer, `settle was not built: ${error.message}  [the round is "${g.phase}"]`);
}

/* ---- a whole launch ---- */
console.log("\n6. launch: game on, an agent with a small budget, infinite bonding, a first buy");
const params = {
  creator: OWNER,
  name: "Check Bite", symbol: "CHK",
  description: "A launch built by tools/chain/check.mjs and only ever simulated.",
  image: "https://example.com/check.png",
  curve: "infinite",
  rules: { maxWalletPct: 2, blockLimitPct: 3, guardSlots: 100, game: { minBuyPct: 0.01 } },
  agent: { key: Keypair.generate().publicKey.toBase58(), clock: { value: 300, min: 120, max: 1800, step: 300, cooldown: 180 }, maxPerSpend: 0.005, maxPerDay: 0.02, budget: 0.03, feeMoney: 0.004 },
  firstBuy: { sol: 0.002 },
};
const launch = await chain.buildLaunch(params);
console.log(`         mint ${launch.mint}  pool ${launch.pool}\n         rules ${launch.rules}  leash ${launch.leash}\n         uri (${launch.uri.length} bytes) ${launch.uri}`);
console.log(`         first buy: ${launch.firstBuy.sol} SOL -> ${launch.firstBuy.tokens} CHK${launch.firstBuy.ownTransaction ? " (in its own transaction)" : ""}`);
console.log(`         transactions: ${launch.transactions.map((t) => `"${t.label}"`).join(", ")}`);
const sims = await chain.simulate(launch, { all: true });
for (const [i, sim] of sims.entries()) {
  const entry = launch.transactions[i];
  const mintSigned = entry.tx.signatures.some((s) => s.publicKey.toBase58() === launch.mint && s.signature);
  const needsEarlier = i > 0 && /first buy/i.test(entry.label);
  console.log(`      ${i + 1}. ${show(`"${sim.label}"`, sim)}${entry.signers.length ? `  [mint signature ${mintSigned ? "applied" : "MISSING"}]` : ""}`);
  if (needsEarlier) {
    // Its swap calls the hook, which reads rules that only exist once transaction 1 has landed.
    line(!sim.ok, `   as expected it cannot simulate before transaction 1 lands: it was checked for building only`);
    if (sim.ok) console.log(tail(sim));
  } else {
    line(sim.ok && (!entry.signers.length || mintSigned), `   "${sim.label}" simulates cleanly on its own`);
    if (!sim.ok) console.log(tail(sim));
  }
}
// The pool on its own (no first buy) does not call the hook, so it can be simulated today.
const bare = await chain.buildLaunch({ ...params, firstBuy: null, mintKeypair: Keypair.generate() });
const bareSim = (await chain.simulate(bare, { all: true }))[1];
line(bareSim.ok, show('the same launch without a first buy, "Token and curve"', bareSim));
if (!bareSim.ok) console.log(tail(bareSim));

/* ---- rules the hook would refuse are refused before anything is built ---- */
console.log("\n7. rules the hook would answer BadConfig to");
for (const [what, bad] of [
  ["the game next to a block limit that never ends", { rules: { blockLimitPct: 3, guardSlots: 0, game: { minBuyPct: 0.01, timerSeconds: 300 } } }],
  ["a smallest buy above the wallet cap", { rules: { maxWalletPct: 1, game: { minBuyPct: 2, timerSeconds: 300 } } }],
  ["an agent without a game", { rules: { maxWalletPct: 1 }, agent: params.agent }],
]) {
  try { chain.planRules(bad); line(false, `${what}: was not refused`); } catch (error) { line(error.kind === "bad-launch", `${what}: "${error.message}"`); }
}

console.log(failed ? `\n${failed} check(s) FAILED. Nothing was sent.` : "\nAll checks passed. Nothing was sent.");
process.exit(failed ? 1 : 0);
