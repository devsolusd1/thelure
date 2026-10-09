// The ground everything else stands on: the cluster (net.js), one connection that is polite to
// the RPC, a small cache, addresses, and the bytes of the two Lure programs.

// In Node this runs net.js, which sets globalThis.LURE_NET. In the browser bundle the import is
// replaced by nothing (see build.mjs): the page has already loaded net.js with a script tag,
// so the cluster can be changed there without rebuilding.
import "../../../net.js";
import { DynamicBondingCurveClient, deriveDbcPoolAuthority, DYNAMIC_BONDING_CURVE_PROGRAM_ID } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { Connection, PublicKey } from "@solana/web3.js";

/* ---------------- Errors ---------------- */

/** Every error this layer throws on purpose. `kind` is for code, `message` is for people. */
export class LureError extends Error {
  constructor(kind, message, extra) {
    super(message);
    this.name = "LureError";
    this.kind = kind;
    Object.assign(this, extra || {});
  }
}

/* ---------------- The cluster ---------------- */

/** The block of net.js that is in use. */
export function net() {
  const found = globalThis.LURE_NET;
  if (!found) throw new LureError("not-ready", "net.js is not loaded: it has to come before every other script.");
  return found;
}

/** Throws, in plain words, when a value of net.js that the caller needs is still empty. */
export function need(...paths) {
  const found = net();
  const problem = found.notReady(paths);
  if (problem) throw new LureError("not-ready", problem);
  return found;
}

/* ---------------- One connection, polite to the RPC ---------------- */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export { sleep };

// A public RPC counts calls per IP in ten-second windows. Few at a time, and after a
// "too many requests" a real wait, not a quick retry. web3.js is told not to retry by itself:
// its own retries are fast and log an error to the console each time.
const PARALLEL = 4;
const RATE_WAITS = [1500, 4000, 11000];
let running = 0;
const waiting = [];

async function politeFetch(input, init) {
  if (running >= PARALLEL) await new Promise((resolve) => waiting.push(resolve));
  running++;
  try {
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await fetch(input, init);
      } catch (error) {
        if (attempt >= 2) throw new LureError("network", "The RPC did not answer.", { cause: error });
        await sleep(700 * (attempt + 1));
        continue;
      }
      if (response.status !== 429) return response;
      if (attempt >= RATE_WAITS.length) throw new LureError("rate", "The RPC is asking this browser to slow down. Try again in a few seconds.");
      await sleep(RATE_WAITS[attempt]);
    }
  } finally {
    running--;
    const next = waiting.shift();
    if (next) next();
  }
}

let made = null;

/** The site's own connection to the cluster in net.js. Transactions are sent through it, never through the wallet. */
export function connection() {
  const { rpcUrl } = need("rpcUrl");
  if (!made || made.url !== rpcUrl) {
    const conn = new Connection(rpcUrl, { commitment: "confirmed", disableRetryOnRateLimit: true, fetch: politeFetch });
    const client = DynamicBondingCurveClient.create(conn, "confirmed");
    made = { url: rpcUrl, conn, client, program: client.state.getProgram() };
  }
  return made.conn;
}

/** Meteora's client and its Anchor program (the account coder and the instruction builders). */
export function meteora() {
  connection();
  return made;
}

/* ---------------- A small cache ---------------- */

const kept = new Map();

/** Runs `load` unless an answer for `key` younger than `maxAge` ms is at hand. Failures are not kept. */
export function cached(key, maxAge, load) {
  const hit = kept.get(key);
  if (hit && Date.now() - hit.at < maxAge) return hit.promise;
  const promise = Promise.resolve().then(load);
  kept.set(key, { at: Date.now(), promise });
  promise.catch(() => { if (kept.get(key)?.promise === promise) kept.delete(key); });
  return promise;
}

/** Forgets what was read, so the next read asks the chain. Called after a transaction lands. */
export function forget(prefix = "") {
  for (const key of [...kept.keys()]) if (key.startsWith(prefix)) kept.delete(key);
}

/* ---------------- Addresses ---------------- */

export const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const CLOCK_SYSVAR = new PublicKey("SysvarC1ock11111111111111111111111111111111");
export const DBC_PROGRAM = DYNAMIC_BONDING_CURVE_PROGRAM_ID;
export const NOBODY = PublicKey.default.toBase58(); // 32 zero bytes
/** Owner of every curve's vault. A token's rules must name it, or the hook cannot tell a buy from a transfer. */
export const poolAuthority = () => deriveDbcPoolAuthority();

/** A PublicKey from an address or a PublicKey; a plain-word error for anything else. */
export function key(value, what = "address") {
  try {
    if (value instanceof PublicKey) return value;
    if (typeof value === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.trim())) return new PublicKey(value.trim());
    if (value && typeof value.toBase58 === "function") return new PublicKey(value.toBase58());
    if (value instanceof Uint8Array && value.length === 32) return new PublicKey(value);
  } catch { /* falls through */ }
  throw new LureError("bad-address", `That is not a Solana address (${what}).`);
}

export const isAddress = (value) => { try { key(value); return true; } catch { return false; } };

const seed = (text) => new TextEncoder().encode(text);
export const hookProgram = () => key(need("hookProgram").hookProgram, "hook program");
export const leashProgram = () => key(need("leashProgram").leashProgram, "leash program");
/** The token's rules account: ["rules", mint] under the hook. Returns [address, bump]. */
export const rulesAddress = (mint) => PublicKey.findProgramAddressSync([seed("rules"), key(mint).toBytes()], hookProgram());
/** The hook's account list, read by Token-2022: ["extra-account-metas", mint]. Returns [address, bump]. */
export const listAddress = (mint) => PublicKey.findProgramAddressSync([seed("extra-account-metas"), key(mint).toBytes()], hookProgram());
/** A token's leash: ["leash", mint, creator] under the leash program. Returns [address, bump]. */
export const leashAddress = (mint, creator) =>
  PublicKey.findProgramAddressSync([seed("leash"), key(mint).toBytes(), key(creator).toBytes()], leashProgram());

/* ---------------- Numbers ---------------- */

export const DECIMALS = 6;
export const SUPPLY_TOKENS = 1_000_000_000;
export const SUPPLY = BigInt(SUPPLY_TOKENS) * 10n ** BigInt(DECIMALS);
export const LAMPORTS = 1_000_000_000n;

/** "1.5" SOL or tokens -> base units, exactly (no floating point). Throws on anything that is not a positive amount. */
export function toUnits(value, decimals) {
  const text = typeof value === "number" ? value.toFixed(decimals) : String(value ?? "").trim().replace(",", ".");
  if (!/^\d*\.?\d*$/.test(text) || !/\d/.test(text)) throw new LureError("bad-amount", "That is not an amount.");
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0");
}

export const fromUnits = (units, decimals) => Number(units) / 10 ** decimals;
export const sol = (lamports) => Number(lamports) / 1e9;
export const tokens = (base) => Number(base) / 10 ** DECIMALS;

/* ---------------- Bytes: the hook's rules, the leash, the mint ----------------
 * Offsets are the ones in programs/README.md; the Rust in programs/hook/src/state.rs and
 * programs/leash/src/state.rs is the truth. */

export const RULES = { LEN: 272, V1_LEN: 120, VERSION: 2, FLAG_GAME: 1, NO_PARAM: 0xff, MAX_TIMER: 604_800, MAX_GUARD_WITH_GAME: 216_000, INIT: 0, SETTLE: 1 };
export const LEASH = { LEN: 432, VERSION: 1, MAX_PARAMS: 4, PARAMS_AT: 240, PARAM_LEN: 48, FLAG_LOCKED: 1, INIT: 0 };

const view = (data) => new DataView(data.buffer, data.byteOffset, data.byteLength);
const b58 = (data, at) => new PublicKey(data.subarray(at, at + 32)).toBase58();
const orNull = (address) => (address === NOBODY ? null : address);

/** A rules account, layout 2 (272 bytes) or the first layout (120 bytes, a wallet cap only). null for anything else. */
export function decodeRules(data) {
  const v = view(data);
  if (data.length === RULES.V1_LEN && data[0] === 1) {
    const leash = orNull(b58(data, 72));
    return {
      version: 1, gameOn: false, capParam: leash ? data[2] : RULES.NO_PARAM, timerParam: RULES.NO_PARAM,
      mint: b58(data, 8), exemptOwner: b58(data, 40), leash,
      maxPerWallet: v.getBigUint64(104, true), transfers: v.getBigUint64(112, true),
      launchSlot: 0n, guardSlots: 0n, blockLimit: 0n, blockSlot: 0n, blockBought: 0n,
      timer: 0n, minBuy: 0n, deadline: 0n, round: 0n, lastBuyer: null, lastWinner: null, lastPrize: 0n, totalPaid: 0n,
    };
  }
  if (data.length !== RULES.LEN || data[0] !== RULES.VERSION) return null;
  return {
    version: 2,
    gameOn: (data[2] & RULES.FLAG_GAME) !== 0,
    capParam: data[3],
    timerParam: data[4],
    mint: b58(data, 8),
    exemptOwner: b58(data, 40),
    leash: orNull(b58(data, 72)),
    maxPerWallet: v.getBigUint64(104, true),
    transfers: v.getBigUint64(112, true),
    launchSlot: v.getBigUint64(120, true),
    guardSlots: v.getBigUint64(128, true),
    blockLimit: v.getBigUint64(136, true),
    blockSlot: v.getBigUint64(144, true),
    blockBought: v.getBigUint64(152, true),
    timer: v.getBigInt64(160, true),
    minBuy: v.getBigUint64(168, true),
    deadline: v.getBigInt64(176, true),
    round: v.getBigUint64(184, true),
    lastBuyer: orNull(b58(data, 192)),
    lastWinner: orNull(b58(data, 224)),
    lastPrize: v.getBigUint64(256, true),
    totalPaid: v.getBigUint64(264, true),
  };
}

/** A leash account (432 bytes, layout 1), or null. */
export function decodeLeash(data) {
  if (data.length !== LEASH.LEN || data[0] !== LEASH.VERSION) return null;
  const v = view(data);
  const count = Math.min(data[3], LEASH.MAX_PARAMS);
  const params = [];
  for (let i = 0; i < count; i++) {
    const at = LEASH.PARAMS_AT + i * LEASH.PARAM_LEN;
    params.push({
      value: v.getBigInt64(at, true), min: v.getBigInt64(at + 8, true), max: v.getBigInt64(at + 16, true),
      maxStep: v.getBigUint64(at + 24, true), cooldown: v.getBigInt64(at + 32, true), lastChange: v.getBigInt64(at + 40, true),
    });
  }
  return {
    locked: (data[2] & LEASH.FLAG_LOCKED) !== 0,
    mint: b58(data, 8), creator: b58(data, 40), agent: orNull(b58(data, 72)),
    dest: [orNull(b58(data, 104)), orNull(b58(data, 136))],
    maxPerSpend: v.getBigUint64(168, true), maxPerDay: v.getBigUint64(176, true),
    params,
  };
}

/**
 * What the site reads from a Token-2022 mint: supply, decimals, the hook it names (null once
 * removed, which is what graduation does), and the name, symbol and uri of its metadata.
 * Layout of spl-token-2022: 82 bytes of mint, padding to 165, one byte of account type (1 =
 * mint), then extensions as (type u16, length u16, value); 14 = TransferHook, 19 = TokenMetadata.
 */
export function decodeMint(data) {
  if (data.length < 82) return null;
  const v = view(data);
  const out = { supply: v.getBigUint64(36, true), decimals: data[44], hook: null, name: "", symbol: "", uri: "" };
  if (data.length <= 166 || data[165] !== 1) return out;
  const text = new TextDecoder();
  for (let at = 166; at + 4 <= data.length;) {
    const type = v.getUint16(at, true), length = v.getUint16(at + 2, true);
    const from = at + 4;
    if (type === 0 || from + length > data.length) break;
    if (type === 14 && length === 64) out.hook = orNull(b58(data, from + 32));
    if (type === 19 && length >= 64 + 12) {
      // update authority (32), mint (32), then three strings, each a u32 length and its bytes
      let p = from + 64;
      const read = () => {
        if (p + 4 > from + length) return "";
        const n = v.getUint32(p, true);
        const s = p + 4 + n <= from + length ? text.decode(data.subarray(p + 4, p + 4 + n)) : "";
        p += 4 + n;
        return s;
      };
      out.name = read();
      out.symbol = read();
      out.uri = read();
    }
    at = from + length;
  }
  return out;
}

/* ---------------- Reading accounts ---------------- */

/** Several accounts in as few calls as the RPC allows (100 an ask), with the slot they were read at. */
export async function readAccounts(keys) {
  const conn = connection();
  const out = [];
  let slot = 0;
  for (let i = 0; i < keys.length; i += 100) {
    const { context, value } = await conn.getMultipleAccountsInfoAndContext(keys.slice(i, i + 100));
    slot = Math.max(slot, context.slot);
    out.push(...value);
  }
  return { slot, accounts: out };
}

/** What an account of `bytes` bytes must hold to stay alive. Asked once in a while: the cluster can change it. */
export const rentFor = (bytes) => cached(`rent:${bytes}`, 600_000, () => connection().getMinimumBalanceForRentExemption(bytes));

/** The chain's own time, from the clock sysvar: unix seconds at the slot it was read. */
export const clockOf = (account) => (account ? Number(view(account.data).getBigInt64(32, true)) : Math.floor(Date.now() / 1000));
