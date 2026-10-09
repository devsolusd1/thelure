// Sending: simulate first, sign with the wallet, send through the site's own connection,
// wait for the cluster to confirm. And the programs' refusals, in plain words.

import { DynamicBondingCurveIdl } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { Transaction, VersionedTransaction } from "@solana/web3.js";
import { connection, DBC_PROGRAM, forget, LureError, net, sleep, TOKEN_2022 } from "./core.mjs";

/* ---------------- Refusals ---------------- */

/** The hook's own errors (programs/hook/src/state.rs, HookError). */
export const HOOK_ERRORS = {
  6000: ["OverMaxPerWallet", "this would leave the wallet above the token's cap"],
  6001: ["NotATransfer", "this was not a real transfer of the token"],
  6002: ["WrongAccount", "the rules or the leash passed are not this token's"],
  6003: ["BadConfig", "these rules contradict each other"],
  6004: ["TooMuchInOneBlock", "too much of the supply was bought in this block. Wait a block, or buy less"],
  6005: ["NotWritable", "an account it has to write to was passed read-only"],
  6006: ["RoundNotOver", "no round is over yet"],
  6007: ["NotTheWinner", "that wallet is not the round's last buyer"],
  6008: ["GameOff", "this token does not play Last Buyer Wins"],
};

/** The leash's errors, in the order of its enum: the code is the index (programs/leash/src/state.rs, LeashError). */
export const LEASH_ERRORS = [
  ["NotAgent", "that key is not this leash's agent"],
  ["NotCreator", "only the creator can name or remove the agent"],
  ["BadDestination", "that account is not a destination fixed at launch"],
  ["OverActionCap", "more than the cap per action"],
  ["OverDailyCap", "it would pass the cap per day"],
  ["OverBudget", "the leash does not hold that much"],
  ["BadParam", "the leash has no such dial"],
  ["ParamOutOfBounds", "outside the dial's range"],
  ["ParamStepTooBig", "further than one move may go"],
  ["ParamCooldown", "the dial was turned too recently"],
  ["AgentLocked", "the leash is locked: its agent can be removed, never replaced"],
  ["NotRevoked", "the budget can only be swept once the agent is revoked"],
  ["BadConfig", "the leash's limits contradict each other"],
  ["ZeroAmount", "there is nothing to move"],
];

const SYSTEM = "11111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const CURVE_WORDS = {
  ExceededSlippage: "The price moved further than your slippage allows. Nothing was traded.",
  PoolIsCompleted: "This curve is full: the token has graduated and no longer trades here.",
  SwapAmountIsOverAThreshold: "That buy is more than what is left on the curve.",
  InsufficientLiquidityForMigration: "The curve does not hold enough for that trade.",
};

/**
 * Why a transaction was refused, from its error and its logs. The log names the program that
 * said no, which matters: the hook and Meteora both number their errors from 6000.
 * Returns { by, program, code, name, text }: `by` is "hook", "leash", "curve", "token",
 * "wallet" (not enough SOL or tokens) or "network".
 */
export function explain(err, logs = []) {
  const n = net();
  const lines = logs || [];
  const failed = lines.map((line) => /^Program (\w+) failed: (.*)$/.exec(line)).find(Boolean);
  const program = failed ? failed[1] : null;
  const hex = failed && /custom program error: 0x([0-9a-f]+)/i.exec(failed[2]);
  const code = hex ? parseInt(hex[1], 16) : null;
  const say = (by, name, text) => ({ by, program, code, name, text });

  if (program === n.hookProgram && code !== null) {
    const [name, why] = HOOK_ERRORS[code] || [`error ${code}`, "it gave no reason this page knows"];
    return say("hook", name, `The hook refused it: ${why}.`);
  }
  if (program === n.leashProgram && code !== null) {
    const [name, why] = LEASH_ERRORS[code] || [`error ${code}`, "it gave no reason this page knows"];
    return say("leash", name, `The leash refused it: ${why}.`);
  }
  if (program === DBC_PROGRAM.toBase58()) {
    const known = code !== null && (DynamicBondingCurveIdl.errors || []).find((entry) => entry.code === code);
    const name = known ? known.name.charAt(0).toUpperCase() + known.name.slice(1) : code !== null ? `error ${code}` : "error";
    return say("curve", name, CURVE_WORDS[name] || `The curve refused it: ${known && known.msg ? known.msg : failed[2]}.`);
  }
  if (program === SYSTEM && code === 1) return say("wallet", "InsufficientFunds", "The wallet does not hold enough SOL for this.");
  if ((program === TOKEN || program === TOKEN_2022.toBase58()) && code === 1) return say("wallet", "InsufficientFunds", "The wallet does not hold enough for this.");
  if (program === SYSTEM && code === 0) return say("network", "AccountAlreadyInUse", "One of the accounts this would create already exists.");
  if (failed) return say("other", code !== null ? `error ${code}` : "error", `The program ${program.slice(0, 4)}…${program.slice(-4)} refused it: ${failed[2]}.`);

  const text = typeof err === "string" ? err : JSON.stringify(err ?? "unknown");
  if (/AccountNotFound/.test(text)) return say("wallet", "AccountNotFound", `This wallet holds no SOL on ${n.cluster}.`);
  if (/InsufficientFundsForFee|InsufficientFundsForRent/.test(text)) return say("wallet", "InsufficientFunds", "The wallet does not hold enough SOL for the network fee and rent.");
  if (/BlockhashNotFound/.test(text)) return say("network", "BlockhashNotFound", "The transaction was built too long ago. Try again.");
  return say("other", "error", `The network refused it: ${text}.`);
}

/** A refusal as one sentence with the program's own name and number, when it has them. */
export const refusalText = (refusal) => (refusal.code !== null && refusal.code !== undefined ? `${refusal.text} (${refusal.name}, ${refusal.code})` : refusal.text);

/* ---------------- Simulate ---------------- */

const entriesOf = (thing) => (thing && thing.transactions ? thing.transactions : [{ label: "Transaction", tx: thing, signers: [] }]);

async function simulateOne(tx) {
  const conn = connection();
  const payer = tx.feePayer;
  // Signatures are not checked and the blockhash is replaced: this asks what the programs
  // would answer right now, whoever ends up signing.
  const wire = new VersionedTransaction(tx.compileMessage());
  const { context, value } = await conn.simulateTransaction(wire, {
    sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed",
    accounts: { encoding: "base64", addresses: [payer.toBase58()] },
  });
  const after = value.accounts && value.accounts[0] ? value.accounts[0].lamports : null;
  return {
    ok: !value.err,
    err: value.err || null,
    refusal: value.err ? explain(value.err, value.logs) : null,
    units: value.unitsConsumed ?? null,
    logs: value.logs || [],
    payerAfter: after,
    slot: context.slot,
    bytes: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length,
  };
}

/**
 * Asks the cluster what it would answer, sending nothing. Takes a transaction or what a
 * builder returned. Of a list it simulates the first only, because the later ones need the
 * earlier ones to have landed; { all: true } simulates each on its own anyway.
 * Returns { ok, refusal, units, logs, payerAfter, slot, bytes, label }, or a list of them with `all`.
 */
export async function simulate(thing, { all = false } = {}) {
  const entries = entriesOf(thing);
  if (!all) return { label: entries[0].label, ...(await simulateOne(entries[0].tx)) };
  const out = [];
  for (const entry of entries) out.push({ label: entry.label, ...(await simulateOne(entry.tx)) });
  return out;
}

/* ---------------- Send ---------------- */

async function confirm(signature, raw, lastValidBlockHeight) {
  const conn = connection();
  for (let tick = 0; ; tick++) {
    await sleep(tick === 0 ? 800 : 1500);
    const { value } = await conn.getSignatureStatuses([signature]);
    const status = value[0];
    if (status && status.err) {
      let logs = [];
      try {
        const landed = await conn.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
        logs = (landed && landed.meta && landed.meta.logMessages) || [];
      } catch { /* the reason stays the bare error */ }
      const refusal = explain(status.err, logs);
      throw new LureError("refused", refusalText(refusal), { refusal, signature, landed: true });
    }
    if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) return status.slot;
    if (tick % 4 === 3) {
      if ((await conn.getBlockHeight("confirmed")) > lastValidBlockHeight) {
        throw new LureError("expired", "The network did not take it in time. Nothing was charged; try again.", { signature });
      }
      // Still valid and not seen yet: hand it to the cluster again.
      conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
    }
  }
}

/**
 * Simulates, has the wallet sign, sends through the site's own connection and waits for
 * confirmation, one transaction after the other.
 *   thing    what a builder returned (or one Transaction)
 *   wallet   a connected wallet: { address, signTransaction, signAllTransactions } (wallets.current())
 *   onStep   optional, called as ({ index, count, label, phase, signature }) with phase
 *            "simulating" | "signing" | "sending" | "confirming" | "confirmed"
 * The wallet only signs. Whatever network it is set to, the transaction goes to the cluster in
 * net.js. Returns { signatures, signature (the last), slot }. Throws LureError: kind "refused"
 * (with .refusal, and .signatures of what had already landed), "rejected" (the user said no in
 * the wallet), "expired", "wallet" or "network".
 */
export async function send(thing, wallet, { onStep = () => {} } = {}) {
  const conn = connection();
  const entries = entriesOf(thing);
  if (!wallet || typeof wallet.signTransaction !== "function") throw new LureError("wallet", "No wallet is connected.");
  const payer = entries[0].tx.feePayer;
  if (wallet.address && payer && payer.toBase58() !== wallet.address) {
    throw new LureError("wallet", "This was built for another wallet. Build it again with the wallet that is connected now.");
  }
  const step = (index, phase, signature = null) => onStep({ index, count: entries.length, label: entries[index].label, phase, signature });

  // 1. Before the wallet is asked for anything: would the first one land?
  step(0, "simulating");
  const trial = await simulateOne(entries[0].tx);
  if (!trial.ok) throw new LureError("refused", refusalText(trial.refusal), { refusal: trial.refusal, logs: trial.logs, signatures: [] });

  // 2. A fresh blockhash, so the time spent reading the wallet's window is not taken from the
  //    transaction's own minute. Keys the builder holds (a new mint) sign again.
  const recent = await conn.getLatestBlockhash("confirmed");
  for (const entry of entries) {
    entry.tx.recentBlockhash = recent.blockhash;
    entry.tx.lastValidBlockHeight = recent.lastValidBlockHeight;
    entry.tx.signatures = [];
    if (entry.signers && entry.signers.length) entry.tx.partialSign(...entry.signers);
  }

  // 3. One request to the wallet, for all of them.
  step(0, "signing");
  let signed;
  try {
    signed = entries.length > 1 && typeof wallet.signAllTransactions === "function"
      ? await wallet.signAllTransactions(entries.map((entry) => entry.tx))
      : await entries.reduce(async (done, entry) => [...(await done), await wallet.signTransaction(entry.tx)], Promise.resolve([]));
  } catch (error) {
    const no = error && (error.code === 4001 || /reject|denied|cancel|declin/i.test(String(error.message)));
    throw new LureError(no ? "rejected" : "wallet", no ? "You said no in the wallet. Nothing was sent." : `The wallet could not sign: ${(error && error.message) || error}.`, { cause: error });
  }

  // 4. Send and confirm, in order. From the second on, each is simulated once the one before it has landed.
  const signatures = [];
  let slot = 0;
  for (let i = 0; i < entries.length; i++) {
    const tx = signed[i];
    const legacy = tx instanceof Transaction || typeof tx.compileMessage === "function";
    if (i > 0 && legacy) {
      step(i, "simulating");
      const check = await simulateOne(tx);
      if (!check.ok) throw new LureError("refused", refusalText(check.refusal), { refusal: check.refusal, logs: check.logs, signatures });
    }
    let raw;
    try {
      raw = tx.serialize();
    } catch (error) {
      throw new LureError("wallet", "The wallet did not sign every transaction.", { cause: error, signatures });
    }
    step(i, "sending");
    let signature;
    try {
      signature = await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
    } catch (error) {
      if (error instanceof LureError) throw Object.assign(error, { signatures });
      throw new LureError("network", `The network did not take it: ${(error && error.message) || error}.`, { cause: error, signatures });
    }
    step(i, "confirming", signature);
    try {
      slot = await confirm(signature, raw, recent.lastValidBlockHeight);
    } catch (error) {
      throw Object.assign(error, { signatures });
    }
    signatures.push(signature);
    step(i, "confirmed", signature);
  }
  // What was read before is stale now.
  forget("token:");
  forget("wallet:");
  forget("board");
  return { signatures, signature: signatures[signatures.length - 1], slot };
}
