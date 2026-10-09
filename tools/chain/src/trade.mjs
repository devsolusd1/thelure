// Quotes, and the unsigned transactions of a buy, a sell and a settle.

import { AccountsType, getPriceFromSqrtPrice, swapQuoteExactIn, swapQuotePartialFill } from "@meteora-ag/dynamic-bonding-curve-sdk";
import {
  createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, createSyncNativeInstruction,
  getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { ComputeBudgetProgram, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import {
  connection, DECIMALS, hookProgram, key, listAddress, LureError, meteora, net, poolAuthority, rulesAddress, RULES, sol, SUPPLY_TOKENS,
  TOKEN_2022, tokens, toUnits,
} from "./core.mjs";
import { readTokenDeep, readWallet } from "./read.mjs";

const EXACT_IN = 0, PARTIAL_FILL = 1;
// What a wallet needs on top of a buy: the rent of a token account it may not have yet, and the fee.
const SOL_HEADROOM = 0.004;

const number = (n, digits = 2) => n.toLocaleString("en-US", { maximumFractionDigits: digits });
const pct = (fraction) => `${number(fraction * 100, fraction < 0.001 ? 4 : 2)}%`;
export function clockWords(seconds) {
  if (seconds % 3600 === 0 && seconds >= 3600) return `${seconds / 3600} h`;
  if (seconds % 60 === 0 && seconds >= 60) return `${seconds / 60} min`;
  return seconds >= 60 ? `${Math.floor(seconds / 60)} min ${seconds % 60} s` : `${seconds} s`;
}

/* ---------------- Quote ---------------- */

/**
 * What a trade would give, and what the hook would say to it.
 *   mint         the token
 *   side         "buy" (amount is SOL paid) or "sell" (amount is tokens sold)
 *   amount       number or decimal string, in SOL or in tokens
 *   slippageBps  how far the price may move before the trade is refused (100 = 1%)
 *   owner        optional wallet: with it the checks use what that wallet holds
 */
export async function quote({ mint, side, amount, slippageBps = 100, owner = null, maxAge } = {}) {
  if (side !== "buy" && side !== "sell") throw new LureError("bad-side", 'side is "buy" or "sell".');
  const sell = side === "sell";
  const amountIn = toUnits(amount, sell ? DECIMALS : 9);
  if (amountIn <= 0n) throw new LureError("bad-amount", "Enter an amount above zero.");
  const deep = await readTokenDeep(mint, maxAge === undefined ? undefined : { maxAge });
  const { token, pool, config, slot } = deep;
  if (token.graduated) throw new LureError("graduated", "This token left its curve: it no longer trades here.");

  const args = [pool, config.state, sell, new BN(amountIn.toString()), slippageBps, false, new BN(slot), false];
  let result, mode = EXACT_IN;
  try {
    result = swapQuoteExactIn(...args);
  } catch (error) {
    // A graduating curve near its end takes only what is left of it.
    if (sell || !/insufficient liquidity/i.test(String(error && error.message))) {
      throw new LureError("no-quote", sell ? "The curve does not hold enough SOL for that sell." : "The curve cannot fill that buy.", { cause: error });
    }
    mode = PARTIAL_FILL;
    result = swapQuotePartialFill(...args);
  }

  const paid = mode === PARTIAL_FILL ? BigInt(result.includedFeeInputAmount.toString()) : amountIn;
  const out = BigInt(result.outputAmount.toString());
  const minOut = BigInt(result.minimumAmountOut.toString());
  const fee = BigInt(result.tradingFee.add(result.protocolFee).add(result.referralFee).toString());
  const priceAfter = Number(getPriceFromSqrtPrice(result.nextSqrtPrice, DECIMALS, 9).toString());
  const wallet = owner ? await readWallet(owner, token.mint) : null;
  const symbol = token.symbol || "tokens";

  const checks = [];
  const rules = token.rules;
  if (sell) {
    if (wallet) {
      const enough = BigInt(wallet.tokensRaw) >= amountIn;
      checks.push({ id: "balance", by: "wallet", ok: enough, text: enough ? `You hold ${number(wallet.tokens)} ${symbol}.` : `You hold ${number(wallet.tokens)} ${symbol}: not enough for this sell.` });
    }
    if (rules) checks.push({ id: "sell", by: "hook", ok: true, text: "A sell always lands: the hook only counts it." });
  } else {
    const got = tokens(out);
    if (wallet) {
      const needed = sol(paid) + SOL_HEADROOM;
      const enough = wallet.sol >= needed;
      checks.push({ id: "balance", by: "wallet", ok: enough, text: enough ? `Your wallet holds ${number(wallet.sol, 4)} SOL.` : `Your wallet holds ${number(wallet.sol, 4)} SOL: this buy needs about ${number(needed, 4)}.` });
    }
    if (rules && rules.cap && rules.cap.tokens !== null) {
      const after = (wallet ? wallet.tokens : 0) + got;
      const ok = after <= rules.cap.tokens;
      checks.push({
        id: "cap", by: "hook", ok, code: ok ? null : 6000,
        text: ok ? `Wallet cap: ${wallet ? "you would hold" : "this buy is"} ${pct(after / SUPPLY_TOKENS)} of supply, the cap is ${pct(rules.cap.share)}.`
          : `Over the wallet cap: ${wallet ? "you would hold" : "this buy is"} ${pct(after / SUPPLY_TOKENS)} of supply, the cap is ${pct(rules.cap.share)}.`,
      });
    }
    if (rules && rules.blockLimit && rules.blockLimit.up) {
      const ok = got <= rules.blockLimit.tokens;
      checks.push({
        id: "block", by: "hook", ok, code: ok ? null : 6004,
        text: ok ? `Block limit: this buy is ${pct(got / SUPPLY_TOKENS)} of supply, at most ${pct(rules.blockLimit.share)} can be bought per block while the guard is up.`
          : `Over the block limit: this buy is ${pct(got / SUPPLY_TOKENS)} of supply, at most ${pct(rules.blockLimit.share)} can be bought per block while the guard is up.`,
      });
    }
    // A buy the hook refuses does not land, so it has no part in the game.
    if (rules && rules.game && !checks.some((check) => check.by === "hook" && !check.ok)) {
      const g = rules.game;
      const counts = got > 0 && got >= g.minBuy;
      const text = g.phase === "guard" ? "The guard is up: this buy does not play yet."
        : g.phase === "over" ? "The round is over: this buy lands, but nothing in the game moves until the winner is paid."
        : !counts ? `Too small to take the lead: the game counts buys of ${number(g.minBuy)} ${symbol} or more.`
        : `Takes the lead${g.clock ? ` and sets the clock to ${clockWords(g.clock)}` : " and restarts the clock"}.`;
      checks.push({ id: "game", by: "hook", ok: true, plays: counts && (g.phase === "waiting" || g.phase === "running"), text });
    }
  }

  return {
    side, mint: token.mint, symbol: token.symbol,
    amountIn: sell ? tokens(paid) : sol(paid), amountInRaw: paid.toString(),
    out: sell ? sol(out) : tokens(out), outRaw: out.toString(),
    minOut: sell ? sol(minOut) : tokens(minOut), minOutRaw: minOut.toString(),
    slippageBps,
    fee: sol(fee), feeRaw: fee.toString(), feePct: net().fees.total,
    price: token.price, priceAfter,
    partial: mode === PARTIAL_FILL,
    mode,
    checks,
    // The first thing that would stop it, if anything would.
    refusal: checks.find((check) => !check.ok) || null,
    slot, readAt: token.readAt,
  };
}

/* ---------------- Instructions ---------------- */

/** The accounts Token-2022 hands the hook, in the order it resolves them: the rules, the leash if any, the hook, its account list. */
export function hookAccounts(mint, leash) {
  const meta = (pubkey, isWritable = false) => ({ pubkey, isSigner: false, isWritable });
  return [
    meta(rulesAddress(mint)[0], true),
    ...(leash ? [meta(key(leash, "leash"))] : []),
    meta(hookProgram()),
    meta(listAddress(mint)[0]),
  ];
}

/**
 * One swap on a hook pool, with the token accounts it needs: Meteora's swap2WithTransferHook,
 * the same instruction for a buy, a sell and a launch's first buy. SOL is wrapped for a buy and
 * unwrapped again at the end, as Meteora's own client does.
 */
export async function swapInstructions({ owner, mint, pool, config, baseVault, quoteVault, sell, amountIn, minOut, mode = EXACT_IN, leash }) {
  const { program } = meteora();
  const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, owner, true, TOKEN_PROGRAM_ID);
  const held = getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022);
  const extra = hookAccounts(mint, leash);
  const swap = await program.methods
    .swap2WithTransferHook(
      { amount0: new BN(amountIn.toString()), amount1: new BN(minOut.toString()), swapMode: mode },
      { slices: [{ accountsType: AccountsType.TransferHookBase, length: extra.length }] },
    )
    .accountsPartial({
      baseMint: mint, quoteMint: NATIVE_MINT, pool, baseVault, quoteVault, config,
      poolAuthority: poolAuthority(), referralTokenAccount: null,
      inputTokenAccount: sell ? held : wsol, outputTokenAccount: sell ? wsol : held,
      payer: owner, tokenBaseProgram: TOKEN_2022, tokenQuoteProgram: TOKEN_PROGRAM_ID,
    })
    .remainingAccounts(extra)
    .instruction();
  return [
    createAssociatedTokenAccountIdempotentInstruction(owner, wsol, owner, NATIVE_MINT, TOKEN_PROGRAM_ID),
    ...(sell ? [] : [
      createAssociatedTokenAccountIdempotentInstruction(owner, held, owner, mint, TOKEN_2022),
      SystemProgram.transfer({ fromPubkey: owner, toPubkey: wsol, lamports: BigInt(amountIn.toString()) }),
      createSyncNativeInstruction(wsol, TOKEN_PROGRAM_ID),
    ]),
    swap,
    createCloseAccountInstruction(wsol, owner, owner, [], TOKEN_PROGRAM_ID),
  ];
}

/** The tip per compute unit of net.js, with a ceiling on units so the tip is bounded. Nothing when the tip is 0. */
export function budgetInstructions(units, priorityMicroLamports) {
  const price = priorityMicroLamports ?? net().priorityMicroLamports ?? 0;
  if (!(price > 0)) return [];
  return [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.round(price) })];
}

/** An unsigned transaction with its fee payer and a recent blockhash. */
export function transaction(feePayer, recent, instructions) {
  return new Transaction({ feePayer, blockhash: recent.blockhash, lastValidBlockHeight: recent.lastValidBlockHeight }).add(...instructions);
}

export const recentBlockhash = () => connection().getLatestBlockhash("confirmed");

/** What every builder returns: the transactions in the order to send them. */
export function built(kind, feePayer, recent, transactions, extra = {}) {
  return {
    kind,
    feePayer: feePayer.toBase58(),
    blockhash: recent.blockhash,
    lastValidBlockHeight: recent.lastValidBlockHeight,
    builtAt: Date.now(),
    transactions,
    tx: transactions[0].tx,
    ...extra,
  };
}

/* ---------------- Buy, sell, settle ---------------- */

async function buildSwap(side, { mint, owner, amount, slippageBps = 100, priorityMicroLamports }) {
  const ownerKey = key(owner, "wallet");
  const q = await quote({ mint, side, amount, slippageBps, owner: ownerKey });
  const { token, pool, poolAddress, config, rulesData } = await readTokenDeep(mint);
  const [instructions, recent] = await Promise.all([
    swapInstructions({
      owner: ownerKey, mint: key(token.mint), pool: poolAddress, config: config.address,
      baseVault: pool.poolState.baseVault, quoteVault: pool.poolState.quoteVault,
      sell: side === "sell", amountIn: q.amountInRaw, minOut: q.minOutRaw, mode: q.mode,
      leash: rulesData ? rulesData.leash : null,
    }),
    recentBlockhash(),
  ]);
  const tx = transaction(ownerKey, recent, [...budgetInstructions(300_000, priorityMicroLamports), ...instructions]);
  return built(side, ownerKey, recent, [{ label: side === "buy" ? "Buy" : "Sell", tx, signers: [] }], { mint: token.mint, quote: q });
}

/** A buy, unsigned: { mint, owner, sol, slippageBps?, priorityMicroLamports? }. `sol` is what the wallet pays, fee included. */
export const buildBuy = ({ sol: amount, ...rest }) => buildSwap("buy", { ...rest, amount });

/** A sell, unsigned: { mint, owner, tokens, slippageBps?, priorityMicroLamports? }. */
export const buildSell = ({ tokens: amount, ...rest }) => buildSwap("sell", { ...rest, amount });

/**
 * Pays the pot of a finished round to its last buyer: { mint, payer }. Anyone may send it;
 * the payer only pays the network fee. The hook answers RoundNotOver while the clock runs.
 */
export async function buildSettle({ mint, payer, priorityMicroLamports }) {
  const payerKey = key(payer, "wallet");
  const { token } = await readTokenDeep(mint);
  const game = token.rules && token.rules.game;
  if (!game) throw new LureError("game-off", "This token does not play Last Buyer Wins.");
  if (!game.lastBuyer) throw new LureError("round-not-over", "No round is waiting to be paid.");
  const settle = new TransactionInstruction({
    programId: hookProgram(),
    keys: [
      { pubkey: rulesAddress(token.mint)[0], isSigner: false, isWritable: true },
      { pubkey: key(game.lastBuyer), isSigner: false, isWritable: true },
    ],
    data: Uint8Array.of(RULES.SETTLE),
  });
  const recent = await recentBlockhash();
  const tx = transaction(payerKey, recent, [...budgetInstructions(40_000, priorityMicroLamports), settle]);
  return built("settle", payerKey, recent, [{ label: "Pay the winner", tx, signers: [] }], { mint: token.mint, winner: game.lastBuyer, pot: game.pot, round: game.round });
}
