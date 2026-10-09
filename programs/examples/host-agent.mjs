// The reference host agent for a Lure "Last Buyer Wins" game.
//
// Each time it looks, it reads the game (the hook's rules account), the token's leash and the
// recent transactions, then takes at most one of each move, in this order:
//   1. PAY THE WINNER  if a round is over and nobody has settled it (hook `settle`);
//   2. FEED THE POT    if the game has gone quiet (leash `spend` to destination 0, the rules account);
//   3. TURN THE CLOCK  one step, shorter if the game is hot, longer if it is cold (leash `set_param`).
// Every transaction carries one line saying why, as an SPL Memo signed by the agent.
// What it decides, and every byte offset it relies on, is in host-policy.mjs.
//
// It does nothing at all when the game is not the one it knows (rules layout, game off, the
// leash's destination 0, the dial the hook reads), when its key is no longer the leash's agent,
// or once the hook has left the mint (a graduated curve: it pays the last winner, then stops).
//
//   npm install
//   MINT=<mint> CREATOR=<creator> AGENT=<agent address> node host-agent.mjs           # one look, dry run, no key
//   MINT=<mint> CREATOR=<creator> AGENT_KEYPAIR=~/agent.json node host-agent.mjs --send
//   MINT=<mint> CREATOR=<creator> AGENT_KEYPAIR=~/agent.json node host-agent.mjs --send --every 60
//
// DRY RUN IS THE DEFAULT: it simulates each transaction on the cluster and prints what it
// would send. It sends only with --send, and then only what has just simulated cleanly.
// It keeps nothing between looks, so one look per run from cron works as well as --every.
// Run one host per token: two with the same key would both feed the same quiet game.
//
// Environment:
//   MINT, CREATOR        the token and its creator (they give the rules and leash addresses)
//   AGENT_KEYPAIR        path to the agent's keypair file; needed with --send
//   AGENT                the agent's address, for a dry run without any key
//   FEE_PAYER_KEYPAIR    optional: another key pays the fees, so the agent's can hold no SOL
//   FEE_PAYER            its address, for a dry run without any key
//   RPC_URL              default https://api.devnet.solana.com
//   HOOK_PROGRAM, LEASH_PROGRAM   default: the devnet deployments
//   HOST_CONFIG          optional path to a JSON file overriding DEFAULT_CONFIG in host-policy.mjs,
//                        for example {"quietMinutes": 20, "feedSol": 0.01, "hotTrades": 12}
//   ANTHROPIC_API_KEY    optional: a model picks among the moves the rules allow and words the notes
//   ANTHROPIC_MODEL      default claude-haiku-5-5
//
// One line per event on stdout: START, LOOK (the game as read), then DRY / SENT / FAIL per move,
// SKIP and IDLE (why a move was not made), MODEL, REFUSE, ERROR.
// Exit codes: 0 looked, and anything it did went through; 1 could not look (network, bad input);
// 2 refused to act (wrong game, wrong leash, agent revoked, hook gone, no fees: needs a person);
// 3 a move was not sent or did not land (the next look decides again from the chain).

import { Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  ANSWER_SCHEMA, buildPrompt, checkOutcome, decide, decodeLeash, decodeRules, formatClock, formatElapsed, formatSol, LEASH, resolveConfig,
  ruleMoves, RULES, setParamData, settleData, shortKey, spendData, validateAnswer,
} from "./host-policy.mjs";

const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const CLOCK = "SysvarC1ock11111111111111111111111111111111";
const SYSTEM = "11111111111111111111111111111111";
const DEFAULTS = {
  RPC_URL: "https://api.devnet.solana.com",
  HOOK_PROGRAM: "4akkPWLw1imyEhcqAJaHgPPrbDZr6VPaHPifVUV7K5tS",
  LEASH_PROGRAM: "GrojbAndyBXQTo5GxgqXAmDDKjDWkPBPeGniBEQsa89p",
  ANTHROPIC_MODEL: "claude-haiku-5-5",
};
/** getSignaturesForAddress returns at most this many, newest first. */
const PAGE = 1000;
const COMMITMENT = "confirmed";
export const EXIT = Object.freeze({ ok: 0, error: 1, refused: 2, failed: 3 });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const oneLine = (text) => String(text).replace(/\s+/g, " ").trim();

/* ---------------- JSON-RPC: batched, and patient with a rate limit ---------------- */

/** Returns `rpc(calls)`: one HTTP request for a list of [method, params], answers in the same order. */
export function createRpc(url, { fetch: fetchNow = fetch, retries = 4, pause = sleep } = {}) {
  let id = 0;
  return async function rpc(calls) {
    const requests = calls.map(([method, params]) => ({ jsonrpc: "2.0", id: ++id, method, params }));
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await fetchNow(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(requests.length === 1 ? requests[0] : requests),
          signal: AbortSignal.timeout(20_000),
        });
      } catch (error) {
        // The reason, never the URL: its path or query may carry an API key.
        const reason = oneLine(error.cause?.code ?? error.cause?.message ?? error.name).split(String(url)).join("the RPC URL");
        if (attempt >= retries) throw new Error(`the RPC node cannot be reached (${reason})`);
        await pause(500 * 2 ** attempt);
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        if (attempt >= retries) throw new Error(`the RPC node answered HTTP ${response.status} ${attempt + 1} times in a row`);
        const asked = Number(response.headers.get("retry-after")) * 1000;
        await pause(Math.min(asked > 0 ? asked : 500 * 2 ** attempt, 10_000));
        continue;
      }
      if (!response.ok) throw new Error(`the RPC node answered HTTP ${response.status}`);
      const answers = [].concat(await response.json());
      return requests.map((request) => {
        const answer = answers.find((candidate) => candidate?.id === request.id);
        if (!answer) throw new Error(`the RPC node gave no answer to ${request.method}`);
        if (answer.error) throw Object.assign(new Error(`${request.method}: ${oneLine(answer.error.message)}`), { rpcError: answer.error });
        return answer.result;
      });
    }
  };
}

/* ---------------- Reading the chain ---------------- */

const lamports = (value) => {
  if (!Number.isSafeInteger(value)) throw new Error(`a balance of ${value} lamports is too large to read exactly`);
  return BigInt(value);
};
const account = (value) => value && { owner: value.owner, lamports: lamports(value.lamports), executable: value.executable, data: Uint8Array.from(Buffer.from(value.data[0], "base64")), space: value.space };

/** One look at the chain: everything host-policy.mjs's `decide` needs, in one request. */
export async function readLook(context) {
  const { rpc } = context;
  const [rules, leash, agent, payer, mint] = [context.rulesAddress, context.leashAddress, context.agent, context.payer, context.mint].map(String);
  const [accounts, touches, own, rulesRent, leashRent] = await rpc([
    ["getMultipleAccounts", [[rules, leash, CLOCK, payer, mint], { encoding: "base64", commitment: COMMITMENT }]],
    ["getSignaturesForAddress", [rules, { limit: PAGE, commitment: COMMITMENT }]],
    ["getSignaturesForAddress", [agent, { limit: PAGE, commitment: COMMITMENT }]],
    ["getMinimumBalanceForRentExemption", [RULES.LEN]],
    ["getMinimumBalanceForRentExemption", [LEASH.LEN]],
  ]);
  const [rulesAccount, leashAccount, clock, payerAccount, mintAccount] = accounts.value.map(account);
  if (!clock || clock.data.length < 40) throw new Error("the cluster's clock could not be read");
  return {
    // The chain's own time, the one the programs compare against: never this machine's.
    now: new DataView(clock.data.buffer).getBigInt64(32, true),
    mint, agent,
    hookProgram: String(context.hookProgram), leashProgram: String(context.leashProgram),
    rulesAddress: rules, leashAddress: leash,
    rules: rulesAccount, leash: leashAccount, mintAccount,
    rent: { rules: lamports(rulesRent), leash: lamports(leashRent) },
    history: {
      touches: touches.map((row) => ({ signature: row.signature, time: row.blockTime, failed: row.err !== null })),
      own: own.map((row) => row.signature),
      full: touches.length >= PAGE,
    },
    payerLamports: payerAccount?.lamports ?? 0n,
    signatures: agent === payer ? 1 : 2,
  };
}

/** The last buyer's account, as the hook's `settle` will see it. */
export async function readWinner(context, address) {
  const [found] = await context.rpc([["getAccountInfo", [address, { encoding: "base64", dataSlice: { offset: 0, length: 0 }, commitment: COMMITMENT }]]]);
  const info = found.value;
  if (info && !Number.isInteger(info.space)) throw new Error("the RPC node does not report account sizes; the winner's rent can't be worked out");
  const [rentFloor] = await context.rpc([["getMinimumBalanceForRentExemption", [info?.space ?? 0]]]);
  return { lamports: info ? lamports(info.lamports) : 0n, executable: info?.executable ?? false, owner: info?.owner ?? SYSTEM, rentFloor: lamports(rentFloor) };
}

/* ---------------- Building, simulating and sending one move ---------------- */

const meta = (pubkey, { signer = false, writable = false } = {}) => ({ pubkey: new PublicKey(pubkey), isSigner: signer, isWritable: writable });

/** The move's instruction, then its note. Accounts and data as the Rust programs parse them. */
export function instructionsFor(move, context) {
  const { agent, leashAddress, rulesAddress } = context;
  const instruction = move.kind === "settle"
    ? new TransactionInstruction({ programId: context.hookProgram, keys: [meta(rulesAddress, { writable: true }), meta(move.winner, { writable: true })], data: Buffer.from(settleData()) })
    : move.kind === "feed"
      ? new TransactionInstruction({ programId: context.leashProgram, keys: [meta(agent, { signer: true }), meta(leashAddress, { writable: true }), meta(rulesAddress, { writable: true })], data: Buffer.from(spendData(move.index, move.amount)) })
      : new TransactionInstruction({ programId: context.leashProgram, keys: [meta(agent, { signer: true }), meta(leashAddress, { writable: true })], data: Buffer.from(setParamData(move.dial, move.to)) });
  // The agent signs the memo, so the note is provably its own even when another key pays the fee.
  const memo = new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [meta(agent, { signer: true })], data: Buffer.from(move.note, "utf8") });
  return [instruction, memo];
}

function explain(err, move) {
  const [index, detail] = err?.InstructionError ?? [];
  if (index === 0 && detail?.Custom !== undefined) {
    const name = move.kind === "settle" ? RULES.ERRORS[detail.Custom] : LEASH.ERRORS[detail.Custom];
    return name ?? `custom error ${detail.Custom}`;
  }
  if (err === "AccountNotFound") return "the fee payer's account does not exist (it holds no SOL)";
  if (err === "InsufficientFundsForFee") return "the fee payer cannot pay the fee: top it up";
  if (err?.InsufficientFundsForRent) return "paying the fee would leave the fee payer under its rent-exempt minimum: top it up";
  return oneLine(typeof err === "string" ? err : JSON.stringify(err));
}

/**
 * Simulates the move on the cluster and compares what would happen with what the note says.
 * Returns { ok, units, why }. With `wire` (a signed transaction) the signatures are checked too.
 */
export async function simulate(context, move, before, wire) {
  const { rpc, rulesAddress, leashAddress } = context;
  let transaction = wire;
  if (!transaction) {
    const draft = new Transaction({ feePayer: context.payer, recentBlockhash: SYSTEM }).add(...instructionsFor(move, context));
    transaction = draft.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  }
  const [{ value }] = await rpc([["simulateTransaction", [transaction, {
    encoding: "base64", commitment: COMMITMENT, sigVerify: Boolean(wire), replaceRecentBlockhash: !wire,
    accounts: { encoding: "base64", addresses: [String(rulesAddress), String(leashAddress)] },
  }]]]);
  if (value.err) return { ok: false, why: `the cluster would refuse it: ${explain(value.err, move)}` };
  const [rulesAfter, leashAfter] = (value.accounts ?? []).map(account);
  // The account the move writes to must come back, or there is nothing to check the note against.
  if (!(move.kind === "clock" ? leashAfter : rulesAfter)) return { ok: false, why: "the RPC node did not return the accounts after the simulation, so the outcome can't be checked" };
  const after = {
    rules: rulesAfter ? decodeRules(rulesAfter.data) : before.rules,
    rulesLamports: rulesAfter ? rulesAfter.lamports : before.rulesLamports,
    leash: leashAfter ? decodeLeash(leashAfter.data) : before.leash,
  };
  const differs = checkOutcome(move, before, after);
  if (differs) return { ok: false, why: `it would not do what its note says (${differs}): the game moved since the look` };
  return { ok: true, units: value.unitsConsumed };
}

/** Signs, simulates the signed bytes, sends them, and waits until the cluster confirms or the blockhash dies. */
async function send(context, move, before) {
  const { rpc } = context;
  const [{ value: latest }] = await rpc([["getLatestBlockhash", [{ commitment: COMMITMENT }]]]);
  const transaction = new Transaction({ feePayer: context.payer, recentBlockhash: latest.blockhash }).add(...instructionsFor(move, context));
  transaction.sign(...context.signers);
  const wire = transaction.serialize().toString("base64");
  const checked = await simulate(context, move, before, wire);
  if (!checked.ok) return checked;

  let signature;
  try {
    [signature] = await rpc([["sendTransaction", [wire, { encoding: "base64", preflightCommitment: COMMITMENT, maxRetries: 5 }]]]);
  } catch (error) {
    return { ok: false, why: `the node did not take it (${error.message})` };
  }
  try {
    for (let waited = 0; waited < 90_000; waited += 1500) {
      await context.pause(1500);
      const [statuses, height] = await rpc([["getSignatureStatuses", [[signature]]], ["getBlockHeight", [{ commitment: COMMITMENT }]]]);
      const status = statuses.value[0];
      if (status?.err) return { ok: false, signature, why: `it landed as failed and its fee was paid: ${explain(status.err, move)}` };
      if (status && status.confirmationStatus !== "processed") return { ok: true, signature, units: checked.units };
      if (!status && height > latest.lastValidBlockHeight) return { ok: false, signature, why: "it did not land before its blockhash expired" };
    }
  } catch (error) {
    return { ok: false, signature, why: `it was sent, but the node stopped answering before it confirmed (${error.message}); the next look will see whether it landed` };
  }
  return { ok: false, signature, why: "it was sent, but there is no confirmation after 90 seconds; the next look will see whether it landed" };
}

/* ---------------- The optional model ---------------- */

/** Asks the model which offered moves to take and how to word them. Returns its raw text. */
async function askModel(context, decision) {
  const { system, user } = buildPrompt(decision, context.config);
  const response = await context.fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": context.ai.key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: context.ai.model,
      max_tokens: 400,
      // A pick from a short list and a line of text: no thinking needed, which keeps the cap small.
      thinking: { type: "disabled" },
      output_config: { effort: "low", format: { type: "json_schema", schema: ANSWER_SCHEMA } },
      system,
      messages: [{ role: "user", content: user }],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`HTTP ${response.status}${body?.error?.type ? ` ${body.error.type}` : ""}`);
  // A refusal or a cut-off answer is not an answer.
  if (body?.stop_reason !== "end_turn") throw new Error(`it stopped with "${body?.stop_reason}"`);
  return (body.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
}

async function chooseMoves(context, decision) {
  const byRule = ruleMoves(decision);
  if (!context.ai || decision.offered.length === 0) return byRule;
  try {
    const verdict = validateAnswer(await askModel(context, decision), decision);
    if (verdict.ok) {
      context.log("MODEL", `took ${verdict.moves.map((move) => move.id).join(", ") || "no move"} of ${decision.offered.map((move) => move.id).join(", ")}`);
      return verdict.moves;
    }
    context.log("MODEL", `answer thrown away (${verdict.reason}); the rules decide`);
  } catch (error) {
    context.log("MODEL", `no usable answer (${oneLine(error.message)}); the rules decide`);
  }
  return byRule;
}

/* ---------------- One look ---------------- */

function describe(game, config) {
  const leader = game.leader ? shortKey(game.leader) : "nobody";
  const round = game.phase === "over" ? `round ${game.round} over, ${leader} unpaid`
    : game.phase === "waiting" ? `round ${game.round} waiting for its first buy`
    : `round ${game.round} running, ${formatElapsed(game.endsIn)} left, ${leader} leads`;
  const trades = !game.known ? "no history"
    : `${game.atLeast ? "over " : ""}${game.trades} trade${game.trades === 1 ? "" : "s"} in ${config.windowMinutes} min, last ${game.sinceTrade === null ? "never" : `${formatElapsed(game.sinceTrade)} ago`}`;
  return `${round} | pot ${formatSol(game.pot)} SOL | clock ${formatClock(game.clock)}${game.dial === null ? " (fixed)" : ` (dial ${game.dial})`} | ${trades} | budget ${formatSol(game.budget)} SOL, ${formatSol(game.leftToday)} left today`;
}

/**
 * Looks once and acts. Returns an exit code. `context` holds the addresses, the config, `rpc`,
 * `log`, and, when it is allowed to send, `signers`.
 */
export async function lookOnce(context) {
  const { log, config } = context;
  const done = new Set();
  let worst = EXIT.ok;

  // A second pass only after a payout has landed: the round is new, so the host looks again.
  for (let pass = 0; pass < 2; pass++) {
    const look = await readLook(context);
    let decision = decide(look, config);
    if (decision.needWinner) decision = decide({ ...look, winner: await readWinner(context, decision.needWinner) }, config);
    if (decision.refuse) {
      log("REFUSE", `${decision.refuse.code}: ${decision.refuse.message}`);
      return EXIT.refused;
    }
    log("LOOK", describe(decision.game, config));

    const moves = (await chooseMoves(context, decision)).filter((move) => !done.has(move.kind));
    if (moves.length === 0) {
      if (pass === 0) log("IDLE", `nothing to do | ${decision.idle.join(" | ")}`);
      return worst;
    }
    // Why the other moves stay in the drawer this time.
    const skipped = decision.idle.filter((line) => !moves.some((move) => line.startsWith(move.kind)));
    if (skipped.length) log("SKIP", skipped.join(" | "));
    const before = { rules: decodeRules(look.rules.data), rulesLamports: look.rules.lamports, leash: decodeLeash(look.leash.data) };
    let paid = false;
    for (const move of moves) {
      const note = `note (${move.wroteNote}): "${move.note}"`;
      if (!context.send) {
        const result = await simulate(context, move, before);
        if (result.ok) log("DRY", `${move.id}: would send, simulation passed (${result.units} units) | ${move.does} | ${note}`);
        else log("FAIL", `${move.id}: ${result.why} | ${note}`);
        if (!result.ok) worst = EXIT.failed;
        continue;
      }
      const result = await send(context, move, before);
      done.add(move.kind);
      if (!result.ok) {
        log("FAIL", `${move.id}: ${result.why}${result.signature ? ` | ${result.signature}` : "; nothing was sent"} | ${note}`);
        // Stop here: whatever comes next was decided on a state that no longer holds.
        return EXIT.failed;
      }
      log("SENT", `${move.id}: ${move.does} | ${result.signature} | ${note}`);
      paid ||= move.kind === "settle";
    }
    if (!paid) return worst;
  }
  return worst;
}

/* ---------------- Command line ---------------- */

const USAGE = `Usage: MINT=<mint> CREATOR=<creator> AGENT=<address> node host-agent.mjs [--send] [--once | --every <seconds>]

  (no flag)        one look, dry run: simulate and print, send nothing
  --send           really send what simulates cleanly (needs AGENT_KEYPAIR)
  --every <n>      keep looking every n seconds instead of once
  --once           one look and exit (the default)

Environment: MINT, CREATOR, AGENT_KEYPAIR or AGENT, FEE_PAYER_KEYPAIR or FEE_PAYER, RPC_URL,
HOOK_PROGRAM, LEASH_PROGRAM, HOST_CONFIG, ANTHROPIC_API_KEY, ANTHROPIC_MODEL. See the top of this file.`;

class InputError extends Error {}

function publicKey(name, text) {
  try {
    return new PublicKey(text);
  } catch {
    throw new InputError(`${name} is not a Solana address`);
  }
}

/** Loads a keypair file. Nothing from the file is ever printed, not even in an error. */
function keypair(name, path) {
  let bytes;
  try {
    bytes = JSON.parse(readFileSync(path.replace(/^~/, homedir()), "utf8"));
  } catch (error) {
    throw new InputError(error.code === "ENOENT" ? `${name}: no file at ${path}` : `${name}: ${path} could not be read as a keypair file (a JSON list of 64 numbers)`);
  }
  try {
    return Keypair.fromSecretKey(Uint8Array.from(bytes));
  } catch {
    throw new InputError(`${name}: ${path} is not a Solana keypair file (a JSON list of 64 numbers)`);
  }
}

/** Turns the environment and the flags into what `lookOnce` needs. */
export function configure(env, args) {
  const flags = { send: false, every: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--send") flags.send = true;
    else if (args[i] === "--once") flags.every = null;
    else if (args[i] === "--every") {
      flags.every = Number(args[++i]);
      if (!Number.isFinite(flags.every) || flags.every < 5) throw new InputError("--every needs a number of seconds, 5 or more");
    } else throw new InputError(`unknown argument ${args[i]}`);
  }
  for (const name of ["MINT", "CREATOR"]) if (!env[name]) throw new InputError(`${name} is not set`);
  const mint = publicKey("MINT", env.MINT);
  const creator = publicKey("CREATOR", env.CREATOR);
  const hookProgram = publicKey("HOOK_PROGRAM", env.HOOK_PROGRAM ?? DEFAULTS.HOOK_PROGRAM);
  const leashProgram = publicKey("LEASH_PROGRAM", env.LEASH_PROGRAM ?? DEFAULTS.LEASH_PROGRAM);

  const party = (label) => {
    const pair = env[`${label}_KEYPAIR`] ? keypair(`${label}_KEYPAIR`, env[`${label}_KEYPAIR`]) : null;
    const address = env[label] ? publicKey(label, env[label]) : null;
    if (pair && address && !pair.publicKey.equals(address)) throw new InputError(`${label} and ${label}_KEYPAIR are different keys`);
    return { pair, address: pair?.publicKey ?? address };
  };
  const agent = party("AGENT");
  if (!agent.address) throw new InputError("set AGENT_KEYPAIR (a keypair file), or AGENT (an address) for a dry run without a key");
  const payer = party("FEE_PAYER");
  if (!payer.address) Object.assign(payer, agent);
  if (flags.send && !(agent.pair && payer.pair)) throw new InputError("--send needs AGENT_KEYPAIR (and FEE_PAYER_KEYPAIR if another key pays the fees)");

  let overrides = {};
  if (env.HOST_CONFIG) {
    try {
      overrides = JSON.parse(readFileSync(env.HOST_CONFIG.replace(/^~/, homedir()), "utf8"));
    } catch (error) {
      throw new InputError(`HOST_CONFIG: ${env.HOST_CONFIG} could not be read as JSON (${oneLine(error.message)})`);
    }
  }
  let config;
  try {
    config = resolveConfig(overrides);
  } catch (error) {
    throw new InputError(`HOST_CONFIG: ${error.message}`);
  }
  let rpcUrl;
  try {
    rpcUrl = new URL(env.RPC_URL ?? DEFAULTS.RPC_URL);
  } catch {
    throw new InputError("RPC_URL is not a URL");
  }

  return {
    mint, creator, hookProgram, leashProgram, config,
    agent: agent.address, payer: payer.address,
    rulesAddress: PublicKey.findProgramAddressSync([Buffer.from(RULES.SEED), mint.toBuffer()], hookProgram)[0],
    leashAddress: PublicKey.findProgramAddressSync([Buffer.from(LEASH.SEED), mint.toBuffer(), creator.toBuffer()], leashProgram)[0],
    send: flags.send, every: flags.every,
    signers: flags.send ? (payer.pair.publicKey.equals(agent.pair.publicKey) ? [agent.pair] : [payer.pair, agent.pair]) : [],
    ai: env.ANTHROPIC_API_KEY ? { key: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL ?? DEFAULTS.ANTHROPIC_MODEL } : null,
    rpcUrl,
  };
}

async function main() {
  const log = (tag, text) => console.log(`${new Date().toISOString().replace(/\.\d+Z$/, "Z")} host ${tag.padEnd(6)} ${oneLine(text)}`);
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return EXIT.ok;
  }
  let context;
  try {
    context = configure(process.env, args);
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    log("ERROR", error.message);
    console.error(`\n${USAGE}`);
    return EXIT.error;
  }
  Object.assign(context, { log, fetch, pause: sleep, rpc: createRpc(context.rpcUrl.href) });
  // The host of the RPC only: its path or query may carry an API key.
  log("START", `${context.send ? "SENDING" : "dry run"} | rpc ${context.rpcUrl.host} | mint ${context.mint} | agent ${context.agent}${context.payer.equals(context.agent) ? "" : ` | fees paid by ${context.payer}`} | rules ${context.rulesAddress} | leash ${context.leashAddress} | model ${context.ai ? context.ai.model : "off"}`);

  for (;;) {
    let code;
    try {
      code = await lookOnce(context);
    } catch (error) {
      log("ERROR", error.message);
      code = EXIT.error;
    }
    // A refusal will not fix itself: stop, so that whoever runs this notices.
    if (context.every === null || code === EXIT.refused) return code;
    await sleep(context.every * 1000);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
