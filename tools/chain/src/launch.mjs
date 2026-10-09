// A whole launch as an ordered list of unsigned transactions: the rules (and the leash they
// read), the token on its curve with the creator's first buy, then the agent's money.

import { deriveDbcPoolAddress, deriveDbcTokenVaultAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { NATIVE_MINT } from "@solana/spl-token";
import { Keypair, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import {
  DECIMALS, hookProgram, isAddress, key, LEASH, leashAddress, leashProgram, listAddress, LureError, meteora, need, NOBODY, poolAuthority,
  rulesAddress, RULES, sol, SUPPLY, SUPPLY_TOKENS, tokens, toUnits,
} from "./core.mjs";
import { loadConfigs } from "./read.mjs";
import { budgetInstructions, built, recentBlockhash, swapInstructions, transaction } from "./trade.mjs";

const MAX_TX_BYTES = 1232;
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const i64 = (n) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
const meta = (pubkey, { signer = false, writable = false } = {}) => ({ pubkey, isSigner: signer, isWritable: writable });
const bytes = (text) => new TextEncoder().encode(text).length;
const refuse = (message) => { throw new LureError("bad-launch", message); };
const whole = (n) => Number.isInteger(n) && n >= 0;
/** Percent of supply -> base units. 0.0001% is one whole token's worth of precision. */
const ofSupply = (percent) => (SUPPLY * BigInt(Math.round((Number(percent) || 0) * 1e6))) / 100_000_000n;

/* ---------------- Metadata ---------------- */

/**
 * The token's metadata as a small JSON data: URI, for a site with no backend. Its bytes are
 * stored in the mint and paid as rent, and they share the pool transaction with everything
 * else, so it is kept under `maxBytes`: the description is cut first, then dropped, then the
 * image link. With nothing to say it is still a valid, empty JSON.
 */
export function metadataUri({ name = "", symbol = "", description = "", image = "" } = {}, maxBytes = 200) {
  const clean = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
  const link = /^https?:\/\/\S+$/i.test(clean(image)) ? clean(image) : "";
  const make = (fields) => {
    const json = JSON.stringify(Object.fromEntries(Object.entries(fields).filter(([, value]) => value)));
    // Percent-encoded, with JSON's own punctuation left readable: it is legal in a data: URI.
    return `data:application/json,${encodeURIComponent(json).replace(/%(7B|7D|22|3A|2C|2F)/g, (code) => decodeURIComponent(code))}`;
  };
  const base = { name: clean(name), symbol: clean(symbol) };
  // Cut the description, at a word where there is one, until everything fits.
  let text = clean(description);
  while (text && bytes(make({ ...base, description: text, image: link })) > maxBytes) {
    const cut = text.replace(/…$/, "");
    const shorter = cut.slice(0, Math.max(0, cut.length - 8)).replace(/\s+\S*$/, "").trim();
    text = shorter ? `${shorter}…` : "";
  }
  const tries = [{ ...base, description: text, image: link }, { ...base, image: link }, { image: link }, base, {}];
  return tries.map(make).find((uri) => bytes(uri) <= maxBytes) ?? make({});
}

/* ---------------- The rules, checked before the hook checks them ---------------- */

/**
 * Turns the form's choices into the numbers `init` takes, refusing in plain words what the
 * hook would refuse with BadConfig (programs/hook/src/state.rs: validate and check_leash) and
 * what the leash would (programs/leash/src/state.rs: validate).
 */
export function planRules({ rules = {}, agent = null } = {}) {
  const cap = ofSupply(rules.maxWalletPct);
  const blockLimit = ofSupply(rules.blockLimitPct);
  let guardSlots = blockLimit === 0n ? 0 : Math.round(Number(rules.guardSlots ?? 0));
  const game = rules.game || null;
  if ((rules.maxWalletPct ?? 0) < 0 || (rules.blockLimitPct ?? 0) < 0) refuse("A limit cannot be below zero.");
  if (cap > SUPPLY || blockLimit > SUPPLY) refuse("A limit cannot be more than the whole supply.");
  if (rules.maxWalletPct > 0 && cap === 0n) refuse("That wallet cap is smaller than one token.");
  if (rules.blockLimitPct > 0 && blockLimit === 0n) refuse("That block limit is smaller than one token.");
  if (blockLimit === 0n && Number(rules.guardSlots ?? 0) !== 0) refuse("A guard length needs a block limit.");
  if (!whole(guardSlots)) refuse("The guard length is a whole number of blocks.");

  let minBuy = 0n, timer = 0;
  if (game) {
    minBuy = ofSupply(game.minBuyPct);
    if ((game.minBuyPct ?? 0) < 0 || minBuy > SUPPLY) refuse("The smallest buy that counts is between 0 and the whole supply.");
    if (cap !== 0n && minBuy > cap) refuse("The smallest buy that counts is above the wallet cap: no round could ever start.");
    // The game waits for the guard to come down, so next to a block limit the guard has to end.
    if (blockLimit !== 0n && !(guardSlots >= 1 && guardSlots <= RULES.MAX_GUARD_WITH_GAME)) {
      refuse(`With the game on, the guard lasts between 1 and ${RULES.MAX_GUARD_WITH_GAME.toLocaleString("en-US")} blocks (about a day).`);
    }
    if (!agent) {
      timer = Math.round(Number(game.timerSeconds));
      if (!(timer >= 1 && timer <= RULES.MAX_TIMER)) refuse("The clock is between 1 second and one week.");
    }
  } else if (agent) {
    refuse("An agent hosts the game: turn Last Buyer Wins on, or leave the agent out.");
  }

  let leash = null;
  if (agent) {
    if (!isAddress(agent.key) || key(agent.key).toBase58() === NOBODY) refuse("The agent needs a Solana address of its own.");
    const clock = agent.clock || {};
    const c = { value: Math.round(Number(clock.value)), min: Math.round(Number(clock.min ?? clock.value)), max: Math.round(Number(clock.max ?? clock.value)), step: Math.round(Number(clock.step ?? 0)), cooldown: Math.round(Number(clock.cooldown ?? 0)) };
    if (![c.value, c.min, c.max, c.step, c.cooldown].every(Number.isFinite)) refuse("The agent's clock needs a value, a range, a step and a cooldown, in seconds.");
    if (!(c.min >= 1 && c.min <= c.value && c.value <= c.max)) refuse("The agent's clock must start inside its range, and the range starts at 1 second or more.");
    if (c.max > RULES.MAX_TIMER) refuse("The agent's clock can go to one week at most.");
    if (c.step < 0 || c.cooldown < 0) refuse("The agent's clock step and cooldown cannot be below zero.");
    const perSpend = toUnits(agent.maxPerSpend ?? 0, 9), perDay = toUnits(agent.maxPerDay ?? 0, 9);
    if (perSpend > perDay) refuse("The agent's cap per action cannot be above its cap per day.");
    leash = { agent: key(agent.key), clock: c, perSpend, perDay, locked: !!agent.locked, budget: toUnits(agent.budget ?? 0, 9), feeMoney: toUnits(agent.feeMoney ?? 0, 9) };
    // The timer lives in the leash: one number, one source.
    timer = 0;
  }
  return { cap, blockLimit, guardSlots, game: !!game, minBuy, timer, leash };
}

/* ---------------- The launch ---------------- */

/**
 * A whole launch, unsigned, in the order to send it. See the surface in index.mjs for the
 * parameters. Nothing here asks the wallet for anything: it only builds.
 */
export async function buildLaunch(params = {}) {
  const net = need("rpcUrl", "configs", "hookProgram", ...(params.agent ? ["leashProgram"] : []));
  const creator = key(params.creator, "creator");
  const name = String(params.name ?? "").trim(), symbol = String(params.symbol ?? "").trim();
  if (!name || bytes(name) > 32) refuse("The name is 1 to 32 characters.");
  if (!symbol || bytes(symbol) > 10 || /\s/.test(symbol)) refuse("The symbol is 1 to 10 characters, with no spaces.");
  const curve = params.curve === "graduating" ? "graduating" : params.curve === "infinite" ? "infinite" : refuse('The curve is "infinite" or "graduating".');
  const plan = planRules(params);
  const config = (await loadConfigs()).find((entry) => entry.curve === curve);
  const { client } = meteora();

  // The mint's key signs the rules and the pool, once each, and is then thrown away.
  const mintKeypair = params.mintKeypair || Keypair.generate();
  const mint = mintKeypair.publicKey;
  const [rules, rulesBump] = rulesAddress(mint);
  const [list, listBump] = listAddress(mint);
  const [leash, leashBump] = plan.leash ? leashAddress(mint, creator) : [null, 0];
  const pool = deriveDbcPoolAddress(NATIVE_MINT, mint, config.address);
  const words = { name, symbol, description: params.description, image: params.image };
  let uri = params.uri ? String(params.uri) : metadataUri(words);

  /* 1. The leash, then the rules that read it. `init` checks the leash it names, so the leash comes first. */
  const first = [];
  if (plan.leash) {
    // By default the agent's SOL can only go to the pot. Rewards are off. Its one dial is the game clock.
    const dest = (params.agent.destinations || [rules.toBase58(), null]).map((d) => (d ? key(d, "destination") : key(NOBODY)));
    const c = plan.leash.clock;
    first.push(new TransactionInstruction({
      programId: leashProgram(),
      keys: [meta(creator, { signer: true, writable: true }), meta(leash, { writable: true }), meta(SystemProgram.programId)],
      data: Buffer.concat([
        Buffer.from([LEASH.INIT, leashBump, plan.leash.locked ? LEASH.FLAG_LOCKED : 0, 1]),
        mint.toBuffer(), plan.leash.agent.toBuffer(), dest[0].toBuffer(), (dest[1] || key(NOBODY)).toBuffer(),
        u64(plan.leash.perSpend), u64(plan.leash.perDay), u64(0), u64(0),
        i64(c.value), i64(c.min), i64(c.max), u64(c.step), i64(c.cooldown),
      ]),
    }));
  }
  first.push(new TransactionInstruction({
    programId: hookProgram(),
    keys: [
      meta(creator, { signer: true, writable: true }), meta(mint, { signer: true }), meta(rules, { writable: true }), meta(list, { writable: true }),
      meta(SystemProgram.programId), ...(leash ? [meta(leash)] : []),
    ],
    data: Buffer.concat([
      // tag, the two canonical bumps, flags, cap fixed here, clock from dial 0 when there is an agent
      Buffer.from([RULES.INIT, rulesBump, listBump, plan.game ? RULES.FLAG_GAME : 0, RULES.NO_PARAM, leash ? 0 : RULES.NO_PARAM]),
      // Meteora's pool authority owns every curve's vault: without it the hook cannot tell a buy from a transfer.
      poolAuthority().toBuffer(),
      (leash || key(NOBODY)).toBuffer(),
      u64(plan.cap), u64(plan.guardSlots), u64(plan.blockLimit), i64(plan.timer), u64(plan.minBuy),
    ]),
  }));

  /* 2. The token on its curve, and the creator's first buy in the same transaction when it fits. */
  const poolWith = (link) => client.creator.createPoolWithTransferHook({
    baseMint: mint, config: config.address, name, symbol, uri: link, payer: creator, poolCreator: creator, transferHookProgram: hookProgram(),
  });
  let createPool = await poolWith(uri);
  let firstBuy = null, buyInstructions = [];
  const buySol = params.firstBuy && Number(params.firstBuy.sol) > 0 ? params.firstBuy : null;
  if (buySol) {
    const lamports = toUnits(buySol.sol, 9);
    const slippageBps = buySol.slippageBps ?? 100;
    // Nobody can trade before the pool exists, so the quote is on the curve's starting state.
    const q = client.pool.getQuoteFromInputAmount({ config: config.state, swapBaseForQuote: false, amountIn: new BN(lamports.toString()), slippageBps });
    const out = BigInt(q.outputAmount.toString());
    if (plan.cap !== 0n && out > plan.cap) refuse(`The first buy would be ${tokens(out).toLocaleString("en-US")} ${symbol}, over this token's own wallet cap.`);
    if (plan.blockLimit !== 0n && out > plan.blockLimit) refuse(`The first buy would be ${tokens(out).toLocaleString("en-US")} ${symbol}, over this token's own block limit.`);
    buyInstructions = await swapInstructions({
      owner: creator, mint, pool, config: config.address,
      baseVault: deriveDbcTokenVaultAddress(pool, mint), quoteVault: deriveDbcTokenVaultAddress(pool, NATIVE_MINT),
      sell: false, amountIn: lamports, minOut: q.minimumAmountOut.toString(), leash,
    });
    firstBuy = { sol: sol(lamports), tokens: tokens(out), minTokens: tokens(q.minimumAmountOut.toString()), share: tokens(out) / SUPPLY_TOKENS, slippageBps, ownTransaction: false };
  }

  /* 3. The agent's money, last: if anything above fails, none of it has moved. */
  const funding = [];
  if (plan.leash && plan.leash.budget > 0n) funding.push(SystemProgram.transfer({ fromPubkey: creator, toPubkey: leash, lamports: plan.leash.budget }));
  if (plan.leash && plan.leash.feeMoney > 0n) funding.push(SystemProgram.transfer({ fromPubkey: creator, toPubkey: plan.leash.agent, lamports: plan.leash.feeMoney }));

  const recent = await recentBlockhash();
  const priority = params.priorityMicroLamports;
  const signed = (label, units, instructions) => {
    const tx = transaction(creator, recent, [...budgetInstructions(units, priority), ...instructions]);
    return { label, tx, signers: [mintKeypair] };
  };
  // A transaction's size on the wire: its message, and 64 bytes for each signature.
  const size = (entry) => {
    try { const message = entry.tx.compileMessage(); return message.serialize().length + 1 + 64 * message.header.numRequiredSignatures; } catch { return MAX_TX_BYTES + 200; }
  };
  const fits = (entry) => size(entry) <= MAX_TX_BYTES;
  const poolAndBuy = () => signed(buySol ? "Token, curve and first buy" : "Token and curve", 600_000, [...createPool.instructions, ...buyInstructions]);

  const transactions = [signed(plan.leash ? "Leash and rules" : "Rules", 150_000, first)];
  let together = poolAndBuy();
  if (buySol && !fits(together) && !params.uri) {
    // The first buy belongs in the pool's own transaction, where nobody can get in before it.
    // When the two do not fit, the description gives way first.
    const shorter = metadataUri(words, Math.max(24, bytes(uri) - (size(together) - MAX_TX_BYTES)));
    if (bytes(shorter) < bytes(uri)) {
      uri = shorter;
      createPool = await poolWith(uri);
      together = poolAndBuy();
    }
  }
  if (!buySol || fits(together)) {
    transactions.push(together);
  } else {
    // Still too long for one transaction: the buy follows on its own, right after the pool.
    transactions.push(signed("Token and curve", 400_000, createPool.instructions));
    transactions.push({ label: "First buy", tx: transaction(creator, recent, [...budgetInstructions(300_000, priority), ...buyInstructions]), signers: [] });
    firstBuy.ownTransaction = true;
  }
  if (funding.length) transactions.push({ label: "Agent's budget", tx: transaction(creator, recent, [...budgetInstructions(20_000, priority), ...funding]), signers: [] });

  for (const entry of transactions) {
    if (!fits(entry)) refuse(`"${entry.label}" does not fit in one transaction. Use a shorter name, description or image link.`);
    // The mint's signature goes on now; the creator's wallet adds its own when it signs.
    if (entry.signers.length) entry.tx.partialSign(...entry.signers);
  }

  return built("launch", creator, recent, transactions, {
    mint: mint.toBase58(), pool: pool.toBase58(), rules: rules.toBase58(), list: list.toBase58(), leash: leash ? leash.toBase58() : null,
    config: config.address.toBase58(), curve, name, symbol, uri,
    agent: plan.leash ? plan.leash.agent.toBase58() : null,
    firstBuy,
    // What leaves the creator's wallet beyond rent and network fees.
    spends: { firstBuy: firstBuy ? firstBuy.sol : 0, budget: plan.leash ? sol(plan.leash.budget) : 0, feeMoney: plan.leash ? sol(plan.leash.feeMoney) : 0 },
    cluster: net.cluster,
  });
}
