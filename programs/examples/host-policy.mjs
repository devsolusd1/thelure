// What the reference host of a Lure "Last Buyer Wins" game decides, and nothing else.
//
// Pure logic: no network, no key, no clock of its own. host-agent.mjs reads the chain and hands
// the numbers in; host-policy.test.mjs checks every rule here against made-up games.
//
// The host in three sentences:
//   1. When a round is over it pays the winner, and does nothing else until that has landed.
//   2. When nothing has happened in the game for `quietMinutes`, it adds `feedSol` to the pot,
//      as long as the pot is under `potCeilingSol`.
//   3. When `hotTrades` or more trades landed in the last `windowMinutes` it turns the clock one
//      step shorter; when `coldTrades` or fewer did, one step longer.
// Every move is first cut down to what the leash allows right now, so the leash never has to
// refuse one. Every move carries a one-line note whose numbers come from the same state.
// And it stops when the game can no longer be played: agent revoked, or the hook gone from the
// mint (a graduated curve), after which a fed pot could never be won.

/* ==========================================================================================
 * ON-CHAIN LAYOUTS. The only place in the host that knows a byte offset, a tag, a seed or an
 * error code. If a program changes, correct it here: host-policy.test.mjs compares these
 * tables with the Rust sources and fails, naming the field, when they drift apart.
 * Field names are the Rust field names. Types: u8, u64, i64 (little-endian), key (32 bytes).
 * ======================================================================================== */

/** The hook's rules account. Rust: programs/hook/src/state.rs `struct Rules`, layout 2. */
export const RULES = Object.freeze({
  LEN: 272, // RULES_LEN
  VERSION: 2, // VERSION
  FLAG_LAST_BUYER_WINS: 1, // FLAG_LAST_BUYER_WINS
  NO_PARAM: 0xff, // NO_PARAM: the number is fixed in this account, not read from a leash
  MAX_TIMER: 604_800n, // MAX_TIMER: a week; the hook reads a dial as clamp(value, 1, MAX_TIMER) seconds
  SEED: "rules", // processor.rs RULES_SEED: the account sits at ["rules", mint]
  SETTLE_TAG: 1, // processor.rs SETTLE: the whole instruction data; accounts [rules w, winner w]
  FIELDS: Object.freeze({
    version: [0, "u8"], // Rules.version
    bump: [1, "u8"], // Rules.bump
    flags: [2, "u8"], // Rules.flags, bit 0 = the token plays Last Buyer Wins
    cap_param: [3, "u8"], // Rules.cap_param
    timer_param: [4, "u8"], // Rules.timer_param: the leash dial read as the countdown
    mint: [8, "key"], // Rules.mint (after Rules._pad, 3 bytes)
    exempt_owner: [40, "key"], // Rules.exempt_owner
    leash: [72, "key"], // Rules.leash: the leash the dials are read from
    max_per_wallet: [104, "u64"], // Rules.max_per_wallet
    transfers: [112, "u64"], // Rules.transfers
    launch_slot: [120, "u64"], // Rules.launch_slot
    guard_slots: [128, "u64"], // Rules.guard_slots
    block_limit: [136, "u64"], // Rules.block_limit
    block_slot: [144, "u64"], // Rules.block_slot
    block_bought: [152, "u64"], // Rules.block_bought
    lbw_timer: [160, "i64"], // Rules.lbw_timer: the countdown in seconds when no dial holds it
    lbw_min_buy: [168, "u64"], // Rules.lbw_min_buy
    lbw_deadline: [176, "i64"], // Rules.lbw_deadline: unix time the round ends, 0 = waiting
    lbw_round: [184, "u64"], // Rules.lbw_round: rounds closed so far
    lbw_last_buyer: [192, "key"], // Rules.lbw_last_buyer: who wins if the clock runs out
    lbw_last_winner: [224, "key"], // Rules.lbw_last_winner
    lbw_last_prize: [256, "u64"], // Rules.lbw_last_prize
    lbw_total_paid: [264, "u64"], // Rules.lbw_total_paid
  }),
  // state.rs HookError, the codes `settle` can return.
  ERRORS: Object.freeze({ 6002: "WrongAccount", 6005: "NotWritable", 6006: "RoundNotOver", 6007: "NotTheWinner", 6008: "GameOff" }),
  // processor.rs SYSVAR_OWNER and RESERVED: a winner owned by the first, or at one of the
  // others, is "locked" and `settle` pays it nothing (the pot rolls over).
  SYSVAR_OWNER: "Sysvar1111111111111111111111111111111111111",
  RESERVED: Object.freeze([
    "AddressLookupTab1e1111111111111111111111111", "BPFLoader2111111111111111111111111111111111",
    "BPFLoader1111111111111111111111111111111111", "BPFLoaderUpgradeab1e11111111111111111111111",
    "ComputeBudget111111111111111111111111111111", "Config1111111111111111111111111111111111111",
    "Ed25519SigVerify111111111111111111111111111", "Feature111111111111111111111111111111111111",
    "LoaderV411111111111111111111111111111111111", "KeccakSecp256k11111111111111111111111111111",
    "Secp256r1SigVerify1111111111111111111111111", "StakeConfig11111111111111111111111111111111",
    "Stake11111111111111111111111111111111111111", "11111111111111111111111111111111",
    "Vote111111111111111111111111111111111111111", "ZkE1Gama1Proof11111111111111111111111111111",
    "ZkTokenProof1111111111111111111111111111111", "SysvarC1ock11111111111111111111111111111111",
    "SysvarEpochRewards1111111111111111111111111", "SysvarEpochSchedu1e111111111111111111111111",
    "SysvarFees111111111111111111111111111111111", "Sysvar1nstructions1111111111111111111111111",
    "SysvarLastRestartS1ot1111111111111111111111", "SysvarRecentB1ockHashes11111111111111111111",
    "SysvarRent111111111111111111111111111111111", "SysvarRewards111111111111111111111111111111",
    "SysvarS1otHashes111111111111111111111111111", "SysvarS1otHistory11111111111111111111111111",
    "SysvarStakeHistory1111111111111111111111111", "NativeLoader1111111111111111111111111111111",
    "Sysvar1111111111111111111111111111111111111",
  ]),
});

/** The leash account. Rust: programs/leash/src/state.rs `struct Leash` and `struct Param`. */
export const LEASH = Object.freeze({
  LEN: 432, // LEASH_LEN
  VERSION: 1, // VERSION
  MAX_PARAMS: 4, // MAX_PARAMS
  DAY: 86_400n, // DAY: length of a spending window, in seconds
  SEED: "leash", // processor.rs SEED: the account sits at ["leash", mint, creator]
  SPEND_TAG: 1, // processor.rs tag::SPEND: data = index u8, amount u64; accounts [agent s, leash w, destination w]
  SET_PARAM_TAG: 3, // processor.rs tag::SET_PARAM: data = index u8, value i64; accounts [agent s, leash w]
  FIELDS: Object.freeze({
    version: [0, "u8"], // Leash.version
    bump: [1, "u8"], // Leash.bump
    flags: [2, "u8"], // Leash.flags
    param_count: [3, "u8"], // Leash.param_count
    mint: [8, "key"], // Leash.mint (after Leash._pad, 4 bytes)
    creator: [40, "key"], // Leash.creator
    agent: [72, "key"], // Leash.agent, all zeros once revoked
    dest0: [104, "key"], // Leash.dest[0]
    dest1: [136, "key"], // Leash.dest[1]
    max_per_spend: [168, "u64"], // Leash.max_per_spend
    max_per_day: [176, "u64"], // Leash.max_per_day
    max_per_reward: [184, "u64"], // Leash.max_per_reward
    max_reward_per_day: [192, "u64"], // Leash.max_reward_per_day
    day_start: [200, "i64"], // Leash.day_start
    spent_today: [208, "u64"], // Leash.spent_today
    rewarded_today: [216, "u64"], // Leash.rewarded_today
    total_spent: [224, "u64"], // Leash.total_spent
    total_rewarded: [232, "u64"], // Leash.total_rewarded
  }),
  PARAMS_AT: 240, // Leash.params
  PARAM_LEN: 48, // size_of::<Param>()
  PARAM_FIELDS: Object.freeze({
    value: [0, "i64"], // Param.value
    min: [8, "i64"], // Param.min
    max: [16, "i64"], // Param.max
    max_step: [24, "u64"], // Param.max_step, 0 = any distance inside the range
    cooldown: [32, "i64"], // Param.cooldown
    last_change: [40, "i64"], // Param.last_change, the launch until the agent changes it
  }),
  // state.rs LeashError, in order: the custom code is the index.
  ERRORS: Object.freeze(["NotAgent", "NotCreator", "BadDestination", "OverActionCap", "OverDailyCap", "OverBudget", "BadParam",
    "ParamOutOfBounds", "ParamStepTooBig", "ParamCooldown", "AgentLocked", "NotRevoked", "BadConfig", "ZeroAmount"]),
});

/**
 * The token's mint, as far as the host reads it: is the hook still attached? A curve that
 * graduates has its hook removed from the mint, and from then on no buy can move the game.
 * Layout of spl-token-2022 (not a Lure program): a mint is padded to 165 bytes, then one byte
 * of account type, then extensions as (type u16, length u16, value), type 0 ending the list.
 */
export const MINT_LAYOUT = Object.freeze({
  TOKEN_2022: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", // hook processor.rs TOKEN_2022
  TYPE_AT: 165, // hook state.rs BASE_LEN: where the account type byte sits
  TYPE_MINT: 1, // AccountType::Mint (a token account has 2, hook state.rs ACCOUNT_TYPE)
  TRANSFER_HOOK: 14, // ExtensionType::TransferHook; its value is authority (32 bytes), program id (32 bytes)
  HOOK_PROGRAM_AT: 32, // TransferHook.program_id inside the value; 32 zero bytes = no hook
});

/** "Nobody": 32 zero bytes. A revoked agent, an unset destination, no leash, no last buyer. */
export const NO_KEY = "11111111111111111111111111111111";

/* ---------------- Bytes ---------------- */

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let text = "";
  for (; n > 0n; n /= 58n) text = ALPHABET[Number(n % 58n)] + text;
  for (const b of bytes) {
    if (b !== 0) break;
    text = "1" + text;
  }
  return text;
}

export function unbase58(text) {
  let n = 0n;
  for (const c of text) {
    const digit = ALPHABET.indexOf(c);
    if (digit < 0) throw new Error(`not base58: ${text}`);
    n = n * 58n + BigInt(digit);
  }
  const out = [];
  for (; n > 0n; n >>= 8n) out.unshift(Number(n & 255n));
  for (const c of text) {
    if (c !== "1") break;
    out.unshift(0);
  }
  return Uint8Array.from(out);
}

function readFields(fields, data, base = 0) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out = {};
  for (const [name, [at, type]] of Object.entries(fields)) {
    const i = base + at;
    out[name] = type === "u8" ? data[i]
      : type === "u64" ? view.getBigUint64(i, true)
      : type === "i64" ? view.getBigInt64(i, true)
      : base58(data.subarray(i, i + 32));
  }
  return out;
}

function writeFields(fields, data, values, base = 0) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (const [name, [at, type]] of Object.entries(fields)) {
    if (values[name] === undefined) continue;
    const i = base + at;
    if (type === "u8") data[i] = values[name];
    else if (type === "u64") view.setBigUint64(i, BigInt(values[name]), true);
    else if (type === "i64") view.setBigInt64(i, BigInt(values[name]), true);
    else {
      const key = unbase58(values[name]);
      if (key.length !== 32) throw new Error(`${name} is not a 32-byte key`);
      data.set(key, i);
    }
  }
}

/** Reads a rules account, or says why it can't. Never guesses at a layout it wasn't written for. */
export function decodeRules(data) {
  if (data.length !== RULES.LEN || data[0] !== RULES.VERSION) {
    throw new Error(`the rules account is ${data.length} bytes with version byte ${data[0]}; this host reads layout ${RULES.VERSION} only (${RULES.LEN} bytes)`);
  }
  return readFields(RULES.FIELDS, data);
}

export function decodeLeash(data) {
  if (data.length !== LEASH.LEN || data[0] !== LEASH.VERSION) {
    throw new Error(`the leash account is ${data.length} bytes with version byte ${data[0]}; this host reads layout ${LEASH.VERSION} only (${LEASH.LEN} bytes)`);
  }
  const leash = readFields(LEASH.FIELDS, data);
  leash.params = [];
  for (let i = 0; i < LEASH.MAX_PARAMS; i++) leash.params.push(readFields(LEASH.PARAM_FIELDS, data, LEASH.PARAMS_AT + i * LEASH.PARAM_LEN));
  return leash;
}

/** The hook program a Token-2022 mint names, as base58 (NO_KEY once removed), or null if it names none. */
export function hookOnMint(data) {
  if (data[MINT_LAYOUT.TYPE_AT] !== MINT_LAYOUT.TYPE_MINT) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let at = MINT_LAYOUT.TYPE_AT + 1; at + 4 <= data.length;) {
    const [type, length] = [view.getUint16(at, true), view.getUint16(at + 2, true)];
    if (type === 0 || at + 4 + length > data.length) return null;
    if (type === MINT_LAYOUT.TRANSFER_HOOK) return length === 64 ? base58(data.subarray(at + 4 + MINT_LAYOUT.HOOK_PROGRAM_AT, at + 4 + 64)) : null;
    at += 4 + length;
  }
  return null;
}

/** For tests and rehearsals: account bytes from field values. The same tables, written instead of read. */
export function encodeMint({ hookProgram, before = [] } = {}) {
  const extensions = [...before, ...(hookProgram ? [[MINT_LAYOUT.TRANSFER_HOOK, [...new Uint8Array(32), ...unbase58(hookProgram)]]] : [])];
  const bytes = [...new Uint8Array(MINT_LAYOUT.TYPE_AT), MINT_LAYOUT.TYPE_MINT];
  for (const [type, value] of extensions) bytes.push(type & 255, type >> 8, value.length & 255, value.length >> 8, ...value);
  return Uint8Array.from(bytes);
}

export function encodeRules(values) {
  const data = new Uint8Array(RULES.LEN);
  writeFields(RULES.FIELDS, data, { version: RULES.VERSION, ...values });
  return data;
}

export function encodeLeash(values) {
  const data = new Uint8Array(LEASH.LEN);
  writeFields(LEASH.FIELDS, data, { version: LEASH.VERSION, param_count: values.params?.length ?? 0, ...values });
  (values.params ?? []).forEach((param, i) => writeFields(LEASH.PARAM_FIELDS, data, param, LEASH.PARAMS_AT + i * LEASH.PARAM_LEN));
  return data;
}

/* ---------------- Instruction data (the runner adds the accounts) ---------------- */

function tagged(tag, index, value, signed) {
  const data = new Uint8Array(10);
  data[0] = tag;
  data[1] = index;
  const view = new DataView(data.buffer);
  if (signed) view.setBigInt64(2, BigInt(value), true);
  else view.setBigUint64(2, BigInt(value), true);
  return data;
}

/** leash `spend`: tag, destination index, amount in lamports. */
export const spendData = (index, amount) => tagged(LEASH.SPEND_TAG, index, amount, false);
/** leash `set_param`: tag, dial index, new value. */
export const setParamData = (index, value) => tagged(LEASH.SET_PARAM_TAG, index, value, true);
/** hook `settle`: the tag and nothing after it. */
export const settleData = () => Uint8Array.of(RULES.SETTLE_TAG);

/* ==========================================================================================
 * THE PROGRAMS' OWN CHECKS, mirrored. Same conditions, same order as the Rust, so that "would
 * the leash refuse this?" has one answer here and on-chain. Each returns the error's name, or
 * null when the program would let the instruction through.
 * ======================================================================================== */

const U64_MAX = (1n << 64n) - 1n;
const abs = (n) => (n < 0n ? -n : n);

/** What is left of today's spending cap. The leash's windows are fixed: 24 hours from `day_start`. */
export function leftToday(leash, now) {
  const spent = now - leash.day_start >= LEASH.DAY ? 0n : leash.spent_today;
  return leash.max_per_day > spent ? leash.max_per_day - spent : 0n;
}

/** leash processor `pay` + state `spend`. `budget` is the leash's lamports above its rent. */
export function spendRefusal(leash, { signer, leashAddress, index, destination, amount, now, budget }) {
  if (destination === leashAddress) return "BadDestination";
  if (leash.agent === NO_KEY || leash.agent !== signer) return "NotAgent";
  if (destination === NO_KEY || [leash.dest0, leash.dest1][index] !== destination) return "BadDestination";
  if (amount === 0n) return "ZeroAmount";
  if (amount > leash.max_per_spend) return "OverActionCap";
  const spent = now - leash.day_start >= LEASH.DAY ? 0n : leash.spent_today;
  if (spent + amount > U64_MAX || spent + amount > leash.max_per_day) return "OverDailyCap";
  if (amount > budget) return "OverBudget";
  return null;
}

/** leash processor `set_param` + state `set_param`. */
export function setParamRefusal(leash, { signer, index, value, now }) {
  if (leash.agent === NO_KEY || leash.agent !== signer) return "NotAgent";
  if (index >= leash.param_count || index >= LEASH.MAX_PARAMS) return "BadParam";
  const param = leash.params[index];
  if (value < param.min || value > param.max) return "ParamOutOfBounds";
  if (param.max_step !== 0n && abs(value - param.value) > param.max_step) return "ParamStepTooBig";
  if (now - param.last_change < param.cooldown) return "ParamCooldown";
  return null;
}

/**
 * hook state `settle` + the payee test in processor `settle`. `payee` is the winner's account:
 * { lamports, executable, owner, rentFloor }. Returns { refusal } or { prize }: the whole pot,
 * or 0 when the winner can't take it (the round closes either way).
 */
export function settleOutcome(rules, { now, winner, rulesAddress, pot, payee }) {
  if ((rules.flags & RULES.FLAG_LAST_BUYER_WINS) === 0) return { refusal: "GameOff" };
  if (rules.lbw_deadline === 0n || now < rules.lbw_deadline) return { refusal: "RoundNotOver" };
  if (winner !== rules.lbw_last_buyer) return { refusal: "NotTheWinner" };
  const locked = payee.executable || winner === rulesAddress || payee.owner === RULES.SYSVAR_OWNER || RULES.RESERVED.includes(winner);
  const after = payee.lamports + pot;
  return { prize: !locked && after <= U64_MAX && after >= payee.rentFloor ? pot : 0n };
}

/* ==========================================================================================
 * CONFIG: what "quiet", "hot" and "cold" mean, and how much to feed.
 * ======================================================================================== */

export const DEFAULT_CONFIG = Object.freeze({
  quietMinutes: 40, // no transaction at all on the game for this long = quiet: feed the pot
  feedSol: 0.005, // how much one feed adds (0 = never feed)
  potCeilingSol: 0.25, // never feed the pot up past this
  windowMinutes: 10, // trades are counted over the last this many minutes
  hotTrades: 8, // this many trades or more in the window = hot: clock one step shorter
  coldTrades: 0, // this many or fewer = cold: clock one step longer
  clockStepSeconds: 0, // size of a step; 0 = the biggest the leash allows (5 minutes if it allows any)
  clockFloorSeconds: 60, // never turn the clock below this, whatever the leash allows
  clockDial: null, // the dial this host expects the hook to read; null = whichever one it reads
});

const SOL = 1_000_000_000n;
/** A feed smaller than this (0.0001 SOL) isn't worth its fee and a line on the agent's page. */
export const DUST_LAMPORTS = 100_000n;
/** One signature on a transaction. */
export const FEE_LAMPORTS = 5_000n;
/** "Under 120 characters." */
export const MAX_NOTE = 119;
/** A step of five minutes when neither the config nor the leash names one. */
const DEFAULT_STEP = 300n;

export function resolveConfig(overrides = {}) {
  for (const key of Object.keys(overrides)) {
    if (!(key in DEFAULT_CONFIG)) throw new Error(`unknown config key "${key}" (known: ${Object.keys(DEFAULT_CONFIG).join(", ")})`);
  }
  const config = { ...DEFAULT_CONFIG, ...overrides };
  const number = (key, { min = 0, whole = false } = {}) => {
    const value = config[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || (whole && !Number.isInteger(value))) {
      throw new Error(`config ${key} must be a${whole ? " whole" : ""} number, ${min} or more (got ${JSON.stringify(value)})`);
    }
  };
  number("quietMinutes", { min: 1, whole: true });
  number("windowMinutes", { min: 1, whole: true });
  number("feedSol");
  number("potCeilingSol");
  number("hotTrades", { min: 1, whole: true });
  number("coldTrades", { whole: true });
  number("clockStepSeconds", { whole: true });
  number("clockFloorSeconds", { min: 1, whole: true });
  if (config.coldTrades >= config.hotTrades) throw new Error("config coldTrades must be below hotTrades, or one game would be hot and cold at once");
  if (config.feedSol !== 0 && lamports(config.feedSol) < DUST_LAMPORTS) throw new Error("config feedSol must be 0 (never feed) or at least 0.0001");
  if (config.clockDial !== null && !(Number.isInteger(config.clockDial) && config.clockDial >= 0 && config.clockDial < LEASH.MAX_PARAMS)) {
    throw new Error("config clockDial must be null or a dial index from 0 to 3");
  }
  return Object.freeze(config);
}

/* ---------------- Words and numbers for the notes ---------------- */

const lamports = (sol) => BigInt(Math.round(sol * 1e9));
const min = (...values) => values.reduce((a, b) => (b < a ? b : a));
const max = (...values) => values.reduce((a, b) => (b > a ? b : a));

/** Keeps the first three digits of an amount, so that the note can print it exactly. */
function roundDown(amount) {
  const digits = amount.toString().length;
  if (digits <= 3) return amount;
  const unit = 10n ** BigInt(digits - 3);
  return (amount / unit) * unit;
}

/** Lamports as SOL, cut (never rounded up) to three significant digits: 0.005, 0.123, 12.3. */
export function formatSol(amount) {
  const whole = amount / SOL;
  const fraction = (amount % SOL).toString().padStart(9, "0");
  const leadingZeros = fraction.length - fraction.replace(/^0+/, "").length;
  const decimals = whole >= 100n ? 0 : whole >= 10n ? 1 : whole >= 1n ? 2 : Math.min(9, leadingZeros + 3);
  const shown = fraction.slice(0, decimals).replace(/0+$/, "");
  return shown ? `${whole}.${shown}` : `${whole}`;
}

/** A clock setting, exactly: 15 min, 2 h, 90 s. */
export function formatClock(seconds) {
  if (seconds !== 0n && seconds % 3600n === 0n) return `${seconds / 3600n} h`;
  if (seconds !== 0n && seconds % 60n === 0n) return `${seconds / 60n} min`;
  return `${seconds} s`;
}

/** Time gone by, rounded down: 45 s, 40 min, 3 h, 2 days. */
export function formatElapsed(seconds) {
  if (seconds < 60n) return `${seconds} s`;
  if (seconds < 7_200n) return `${seconds / 60n} min`;
  if (seconds < 172_800n) return `${seconds / 3600n} h`;
  return `${seconds / 86_400n} days`;
}

export const shortKey = (key) => `${key.slice(0, 4)}..${key.slice(-4)}`;

/* ==========================================================================================
 * ACTIVITY, without a database. Every trade of the token runs the hook, and the hook writes to
 * the rules account, so the transactions that name that account are the game's pulse. The
 * host's own feeds and payouts name it too; they are told apart by also naming the agent key.
 * ======================================================================================== */

/**
 * `touches`: the newest transactions naming the rules account ({ signature, time, failed }),
 * `own`: signatures of transactions naming the agent key, `full`: the list hit the page limit.
 * Returns seconds since anything landed on the game, seconds since a trade did, and how many
 * trades landed in the window. `known` is false when the node returned no usable history.
 */
export function summarizeActivity({ touches = [], own = [], full = false } = {}, now, windowSeconds) {
  const mine = new Set(own);
  // A row with no time yet, ahead of every timed one, is a transaction too fresh for the node
  // to have dated: it counts as "just now". Undated rows further down are left out.
  let dated = false;
  const landed = [];
  for (const t of touches) {
    const timeless = t.time === null || t.time === undefined;
    dated ||= !timeless;
    if (!t.failed && !(timeless && dated)) landed.push({ ...t, time: timeless ? now : BigInt(t.time) });
  }
  if (landed.length === 0) return { known: false, sinceTouch: null, sinceTrade: null, trades: 0, atLeast: false };
  const trades = landed.filter((t) => !mine.has(t.signature));
  const since = (list) => (list.length ? max(0n, now - max(...list.map((t) => t.time))) : null);
  const oldest = min(...landed.map((t) => t.time));
  return {
    known: true,
    sinceTouch: since(landed),
    sinceTrade: since(trades),
    trades: trades.filter((t) => now - t.time <= windowSeconds).length,
    // The page ended inside the window: there were at least this many trades, maybe more.
    atLeast: full && now - oldest <= windowSeconds,
  };
}

/* ==========================================================================================
 * THE DECISION
 * ======================================================================================== */

/**
 * Everything the host needs from one look at the chain:
 *   now            unix seconds from the chain's clock (bigint)
 *   mint, agent    base58; `agent` is the key this host signs with
 *   hookProgram, leashProgram, rulesAddress, leashAddress   base58
 *   rules, leash   the accounts as read: { owner, lamports, data } or null if missing
 *   mintAccount    the token's mint as read: { owner, data } or null if missing
 *   rent           { rules, leash }: the rent-exempt minimum of each account, in lamports
 *   history        { touches, own, full }, see summarizeActivity
 *   winner         the last buyer's account, needed once a round is over:
 *                  { lamports, executable, owner, rentFloor }
 *   payerLamports  what the fee payer holds; signatures: how many each transaction carries
 *
 * Returns { refuse } when the host must not act at all, { needWinner } when it has to read the
 * winner's account first, otherwise { game, offered, chosen, idle }: the moves the leash allows
 * right now, the ones the rules pick, and one line for each move left out.
 */
export function decide(look, overrides = {}) {
  const config = resolveConfig(overrides);
  const setup = checkSetup(look, config);
  if (setup.refuse) return { refuse: setup.refuse, offered: [], chosen: [], idle: [] };
  const { rules, leash } = setup;
  const { now } = look;

  const pot = max(0n, look.rules.lamports - look.rent.rules);
  const budget = max(0n, look.leash.lamports - look.rent.leash);
  const dial = rules.timer_param === RULES.NO_PARAM ? null : rules.timer_param;
  // The countdown a buy sets: fixed at launch, or the dial as the hook reads it.
  const clock = dial === null ? rules.lbw_timer : min(max(leash.params[dial].value, 1n), RULES.MAX_TIMER);
  const activity = summarizeActivity(look.history, now, BigInt(config.windowMinutes) * 60n);
  const over = rules.lbw_deadline !== 0n && now >= rules.lbw_deadline;
  const game = {
    round: rules.lbw_round + 1n,
    phase: over ? "over" : rules.lbw_deadline === 0n ? "waiting" : "running",
    pot,
    clock,
    dial,
    leader: rules.lbw_last_buyer === NO_KEY ? null : rules.lbw_last_buyer,
    endsIn: rules.lbw_deadline !== 0n && !over ? rules.lbw_deadline - now : null,
    budget,
    leftToday: leftToday(leash, now),
    windowSeconds: BigInt(config.windowMinutes) * 60n,
    ...activity,
  };
  game.facts = gameFacts(game, config);

  const offered = [];
  const chosen = [];
  const idle = [];

  // A curve that graduates has the hook taken off its mint. After that no buy can restart the
  // clock, and SOL fed to the pot could never be won: the host only pays a last winner, if a
  // round is still open, and then stands down.
  const hooked = look.mintAccount?.owner === MINT_LAYOUT.TOKEN_2022 && hookOnMint(look.mintAccount.data) === look.hookProgram;
  if (!hooked && game.phase === "waiting") {
    const left = pot > 0n ? `; ${formatSol(pot)} SOL stays in the pot` : "";
    return { refuse: { code: "hook-gone", message: `the hook is not on mint ${look.mint} (its curve has graduated, or MINT is not a token of this hook program): no buy can move the game, so there is nothing left to host${left}` }, game, offered, chosen, idle };
  }

  if (over) {
    // A finished round is frozen until it is settled, so nothing else is worth doing yet.
    if (!look.winner) return { needWinner: rules.lbw_last_buyer, game, offered, chosen, idle };
    offered.push(settleMove(look, rules, game));
    chosen.push("settle");
    idle.push("feed, clock: the round is over; they wait until the winner is paid");
  } else if (!hooked) {
    idle.push("feed, clock: the hook is no longer on the mint, so this is the last round; the host only waits for it to end, to pay its winner");
  } else {
    const feed = feedMove(look, leash, game, config, idle);
    if (feed) {
      offered.push(feed);
      chosen.push(feed.id);
    }
    const turns = clockMoves(look, leash, game, config, idle);
    offered.push(...turns.offered);
    if (turns.pick) chosen.push(turns.pick);
  }

  // Each move is a transaction of its own; at most two can go out in one look.
  const fees = FEE_LAMPORTS * BigInt(look.signatures ?? 1) * BigInt(Math.min(offered.length, 2));
  if (offered.length && look.payerLamports !== undefined && look.payerLamports < fees) {
    return { refuse: { code: "fees", message: `the fee payer holds ${formatSol(look.payerLamports)} SOL and cannot pay the fees (${formatSol(fees)} SOL): top it up` }, game, offered: [], chosen: [], idle };
  }
  return { refuse: null, game, offered, chosen, idle };
}

/** Is this the game, the leash and the agent the host thinks they are? If not, it does nothing. */
function checkSetup(look, config) {
  const refuse = (code, message) => ({ refuse: { code, message } });

  if (!look.rules) return refuse("rules-missing", `no rules account at ${look.rulesAddress}: check MINT and HOOK_PROGRAM, and that the token was launched with the hook`);
  if (look.rules.owner !== look.hookProgram) return refuse("rules-owner", `the rules account ${look.rulesAddress} belongs to ${look.rules.owner}, not to the hook program ${look.hookProgram}`);
  let rules;
  try {
    rules = decodeRules(look.rules.data);
  } catch (error) {
    return refuse("rules-version", error.message);
  }
  if (rules.mint !== look.mint) return refuse("rules-mint", `the rules account is for mint ${rules.mint}, not ${look.mint}`);
  if ((rules.flags & RULES.FLAG_LAST_BUYER_WINS) === 0) return refuse("game-off", "this token does not play Last Buyer Wins: there is no game to host");

  if (!look.leash) return refuse("leash-missing", `no leash at ${look.leashAddress}: check MINT, CREATOR and LEASH_PROGRAM`);
  if (look.leash.owner !== look.leashProgram) return refuse("leash-owner", `the leash ${look.leashAddress} belongs to ${look.leash.owner}, not to the leash program ${look.leashProgram}`);
  let leash;
  try {
    leash = decodeLeash(look.leash.data);
  } catch (error) {
    return refuse("leash-version", error.message);
  }
  if (leash.mint !== look.mint) return refuse("leash-mint", `the leash is for mint ${leash.mint}, not ${look.mint}`);
  if (leash.agent === NO_KEY) return refuse("agent-revoked", "the creator revoked this leash's agent: nothing for the host to do");
  if (leash.agent !== look.agent) return refuse("agent-replaced", `the leash's agent is ${leash.agent}, not this host's key ${look.agent}`);
  if (leash.dest0 !== look.rulesAddress) {
    return refuse("destination", `destination 0 of the leash is ${leash.dest0 === NO_KEY ? "not set" : leash.dest0}, not the game's rules account ${look.rulesAddress}: a feed would not reach the pot`);
  }

  // The clock. Either the hook reads it from a dial of this very leash, or it is fixed.
  const dial = rules.timer_param;
  if (dial === RULES.NO_PARAM) {
    if (config.clockDial !== null) return refuse("dial", `the hook's countdown is fixed at launch, but this host was told to turn dial ${config.clockDial}`);
  } else {
    if (rules.leash !== look.leashAddress) return refuse("dial", `the hook reads its countdown from leash ${rules.leash}, not from ${look.leashAddress}: turning a dial here would change nothing`);
    if (dial >= leash.param_count || dial >= LEASH.MAX_PARAMS) return refuse("dial", `the hook reads its countdown from dial ${dial}, but the leash has ${leash.param_count} dial(s)`);
    if (config.clockDial !== null && config.clockDial !== dial) return refuse("dial", `the hook reads its countdown from dial ${dial}, but this host was told to turn dial ${config.clockDial}`);
  }
  return { rules, leash };
}

/** PAY THE WINNER. Not optional: the round is over and the prize is owed. */
function settleMove(look, rules, game) {
  const winner = rules.lbw_last_buyer;
  const { prize } = settleOutcome(rules, { now: look.now, winner, rulesAddress: look.rulesAddress, pot: game.pot, payee: look.winner });
  const who = shortKey(winner);
  // The hook pays nothing to a winner that can't hold SOL (a program, or an empty wallet the
  // pot is too small to open). The round still closes and the pot waits for the next one.
  const note = prize > 0n ? `Round ${game.round} is over. ${who} bought last and wins the pot: ${formatSol(prize)} SOL.`
    : game.pot === 0n ? `Round ${game.round} is over. ${who} bought last, but the pot was empty.`
    : `Round ${game.round} is over. ${who} bought last but cannot be paid: the pot, ${formatSol(game.pot)} SOL, rolls over.`;
  return {
    id: "settle", kind: "settle", required: true, winner, round: game.round, pot: game.pot, prize, note,
    does: prize > 0n ? `closes round ${game.round} and pays the pot of ${formatSol(prize)} SOL to the last buyer ${who}`
      : `closes round ${game.round}; the last buyer ${who} cannot be paid, so the pot of ${formatSol(game.pot)} SOL stays for the next round`,
    names: [who, winner],
    facts: [...game.facts, fact("sol", prize, "prize paid")],
  };
}

/** FEED THE POT, when the game has gone quiet. */
function feedMove(look, leash, game, config, idle) {
  const quiet = BigInt(config.quietMinutes) * 60n;
  const feed = lamports(config.feedSol);
  const ceiling = lamports(config.potCeilingSol);
  if (feed === 0n) return void idle.push("feed: switched off (feedSol is 0)");
  if (!game.known) return void idle.push("feed: the node returned no history for the game, so quiet can't be told from busy");
  if (game.sinceTouch < quiet) return void idle.push(`feed: not quiet, the last transaction was ${formatElapsed(game.sinceTouch)} ago (quiet is ${config.quietMinutes} min)`);
  if (game.pot >= ceiling) return void idle.push(`feed: the pot is ${formatSol(game.pot)} SOL, at the ${formatSol(ceiling)} SOL ceiling`);

  // Never more than the cap per action, what is left of today's cap, or the budget above rent.
  const amount = roundDown(min(feed, ceiling - game.pot, leash.max_per_spend, game.leftToday, game.budget));
  if (amount < DUST_LAMPORTS) {
    const why = leash.max_per_spend < DUST_LAMPORTS ? "the leash's cap per action is too small (spending is off)"
      : game.leftToday < DUST_LAMPORTS ? `today's cap of ${formatSol(leash.max_per_day)} SOL is used up, it resets in ${formatElapsed(max(0n, leash.day_start + LEASH.DAY - look.now))}`
      : game.budget < DUST_LAMPORTS ? `the budget is down to ${formatSol(game.budget)} SOL: send SOL to the leash to refill it`
      : "the pot is a hair under its ceiling";
    return void idle.push(`feed: ${why}`);
  }
  const refusal = spendRefusal(leash, { signer: look.agent, leashAddress: look.leashAddress, index: 0, destination: look.rulesAddress, amount, now: look.now, budget: game.budget });
  if (refusal) return void idle.push(`feed: the leash would refuse it (${refusal})`);

  const potAfter = game.pot + amount;
  const silence = game.sinceTrade === null ? "No bite yet" : `No bite for ${formatElapsed(game.sinceTrade)}`;
  return {
    id: "feed", kind: "feed", index: 0, amount, potAfter,
    note: `${silence}. Added ${formatSol(amount)} SOL: the pot is ${formatSol(potAfter)} SOL.`,
    does: `adds ${formatSol(amount)} SOL from the budget to the pot, which becomes ${formatSol(potAfter)} SOL`,
    names: [],
    facts: [...game.facts, fact("sol", amount, "added to the pot"), fact("sol", potAfter, "pot after the feed"),
      fact("sol", game.budget - amount, "budget after the feed"), fact("sol", game.leftToday - amount, "left of today's cap after the feed")],
  };
}

/** TURN THE CLOCK one step: both directions the leash allows now, and the one the rules pick. */
function clockMoves(look, leash, game, config, idle) {
  const none = { offered: [], pick: null };
  if (game.dial === null) return idle.push("clock: fixed at launch, there is no dial to turn"), none;
  if (!game.known) return idle.push("clock: the node returned no history for the game, so hot can't be told from cold"), none;
  const param = leash.params[game.dial];
  if (param.value < 1n || param.value > RULES.MAX_TIMER) return idle.push(`clock: the dial reads ${param.value}, outside the 1 s to 7 days the hook takes as a countdown: this host leaves it alone`), none;
  const wait = param.last_change + param.cooldown - look.now;
  if (wait > 0n) return idle.push(`clock: cooling down, the leash allows the next change in ${formatElapsed(wait)}`), none;

  let step = config.clockStepSeconds ? BigInt(config.clockStepSeconds) : param.max_step || DEFAULT_STEP;
  if (param.max_step !== 0n) step = min(step, param.max_step);
  const floor = max(param.min, BigInt(config.clockFloorSeconds));
  const trades = game.trades === 0 ? "No trades" : `${game.atLeast ? "Over " : ""}${game.trades} trade${game.trades === 1 ? "" : "s"}`;
  const turn = (id, to) => {
    if (setParamRefusal(leash, { signer: look.agent, index: game.dial, value: to, now: look.now })) return null;
    const direction = to < param.value ? "down" : "up";
    return {
      id, kind: "clock", dial: game.dial, from: param.value, to,
      note: `${trades} in ${config.windowMinutes} min. Clock ${direction} from ${formatClock(param.value)} to ${formatClock(to)}.`,
      does: `turns the countdown ${direction} from ${formatClock(param.value)} to ${formatClock(to)} (it applies from the next buy)`,
      names: [],
      facts: [...game.facts, fact("time", to, "clock after the turn"), fact("time", abs(to - param.value), "size of the turn")],
    };
  };
  const shorter = max(param.value - step, floor);
  const longer = min(param.value + step, param.max, RULES.MAX_TIMER);
  const down = shorter < param.value ? turn("clock_down", shorter) : null;
  const up = longer > param.value ? turn("clock_up", longer) : null;

  const hot = game.trades >= config.hotTrades;
  const cold = !game.atLeast && game.trades <= config.coldTrades;
  const count = `${game.atLeast ? "over " : ""}${game.trades} trade${game.trades === 1 ? "" : "s"} in ${config.windowMinutes} min`;
  let pick = null;
  if (hot && down) pick = down.id;
  else if (hot) idle.push(`clock: hot (${count}), but it is already as short as it may go (${formatClock(param.value)})`);
  else if (cold && up) pick = up.id;
  else if (cold) idle.push(`clock: cold (${count}), but it is already as long as it may go (${formatClock(param.value)})`);
  else idle.push(`clock: ${count} is neither hot (${config.hotTrades} or more) nor cold (${config.coldTrades} or fewer)`);
  return { offered: [down, up].filter(Boolean), pick };
}

/* ---------------- The true numbers of a move ---------------- */

/** unit: "sol" (value in lamports), "time" (seconds; `loose` = time gone by, read off a clock), "count". */
const fact = (unit, value, what, loose = false) => ({ unit, value: BigInt(value), what, loose });

function gameFacts(game, config) {
  const facts = [
    fact("count", game.round, "round number"),
    fact("sol", game.pot, "pot now"),
    fact("time", game.clock, "clock now"),
    fact("time", game.windowSeconds, "window trades are counted in"),
    fact("count", game.trades, "trades in the window"),
    fact("sol", game.budget, "budget now"),
    fact("sol", game.leftToday, "left of today's cap now"),
    fact("time", BigInt(config.quietMinutes) * 60n, "silence that makes the game quiet"),
    fact("count", config.hotTrades, "trades in the window that make the game hot"),
    fact("sol", lamports(config.potCeilingSol), "pot ceiling for feeds"),
  ];
  if (game.sinceTrade !== null) facts.push(fact("time", game.sinceTrade, "since the last trade", true));
  if (game.sinceTouch !== null) facts.push(fact("time", game.sinceTouch, "since the last transaction on the game", true));
  if (game.endsIn !== null) facts.push(fact("time", game.endsIn, "left on the round's clock", true));
  return facts;
}

/* ==========================================================================================
 * NOTES. One line, under 120 characters, plain words, and no number that is not true.
 * The same check runs on the host's own templates (in the tests) and on anything a model writes.
 * ======================================================================================== */

const UNITS = new Map([
  ...["sol"].map((word) => [word, ["sol", 1_000_000_000n]]),
  ...["lamport", "lamports"].map((word) => [word, ["sol", 1n]]),
  ...["s", "sec", "secs", "second", "seconds"].map((word) => [word, ["time", 1n]]),
  ...["m", "min", "mins", "minute", "minutes"].map((word) => [word, ["time", 60n]]),
  ...["h", "hr", "hrs", "hour", "hours"].map((word) => [word, ["time", 3600n]]),
  ...["d", "day", "days"].map((word) => [word, ["time", 86_400n]]),
]);
const NUMBER_TOKEN = /^[("'#~]*((?:\d[\d,]*)(?:\.\d+)?|\.\d+)(?:-?([A-Za-z%]+))?[)"'.,;:!?]*$/;
const LINK = /https?:|www\.|[a-z0-9]\.[a-z]{2,}/i;

/** Does `number` (digits with `decimals` after the point) state `value / divisor` honestly? */
function states(number, decimals, significant, value, divisor, loose) {
  if (number === 0n) return value === 0n;
  const scaled = value * 10n ** BigInt(decimals);
  const cut = scaled / divisor;
  const rounded = (2n * scaled + divisor) / (2n * divisor);
  // Rounded to the digits shown is always fine. Cut short is fine for time gone by ("40 min"),
  // or when at least two digits are shown ("0.12 SOL" for 0.1234, but never "1 SOL" for 1.9).
  return number === rounded || (number === cut && (loose || significant >= 2));
}

/**
 * Checks a note for a move. Returns null when it may go on-chain, otherwise why not.
 * A number with a unit (SOL, lamports, s, min, h, days) must be one of the move's true numbers
 * in that unit; a number without one must be one of its counts (trades, the round number).
 * It reads digits only: a number spelled out in words is not checked.
 */
export function checkNote(note, move) {
  if (typeof note !== "string") return "the note is not text";
  if (note.length === 0 || note !== note.trim()) return "the note is empty or padded with spaces";
  if (note.length > MAX_NOTE) return `the note is ${note.length} characters, the limit is ${MAX_NOTE}`;
  if (!/^[\x20-\x7e]+$/.test(note)) return "the note has characters outside plain ASCII (or a line break)";
  if (/[<>`\\]/.test(note)) return "the note has markup characters";

  // The winner's address is the one thing that may mix letters and digits.
  let text = note;
  for (const name of [...(move.names ?? [])].sort((a, b) => b.length - a.length)) text = text.split(name).join(" ");
  if (LINK.test(text)) return "the note looks like it carries a link";

  const tokens = text.split(/\s+/).filter(Boolean);
  const bare = (token = "") => token.replace(/^[("']+|[)"'.,;:!?]+$/g, "").toLowerCase();
  // The unit of the number at `i`: glued to it ("45min"), the next word ("45 min"), or the
  // unit of the number it is paired with ("from 15 to 20 min"). None: it is a plain count.
  const unitAt = (i) => {
    const glued = NUMBER_TOKEN.exec(tokens[i])[2];
    if (glued) return glued.toLowerCase();
    const next = bare(tokens[i + 1]);
    if (UNITS.has(next)) return next;
    if (["to", "and", "or", "-"].includes(next) && NUMBER_TOKEN.test(tokens[i + 2] ?? "")) return unitAt(i + 2);
    return null;
  };
  for (let i = 0; i < tokens.length; i++) {
    if (!/\d/.test(tokens[i])) continue;
    const match = NUMBER_TOKEN.exec(tokens[i]);
    if (!match) return `"${tokens[i]}" mixes digits with other characters`;
    const digits = match[1].replaceAll(",", "");
    const [whole, fraction = ""] = digits.split(".");
    if (fraction.length > 9) return `"${tokens[i]}" has too many decimals`;
    const number = BigInt((whole || "0") + fraction);
    const significant = number.toString().length;
    const word = unitAt(i);
    const [unit, divisor] = UNITS.get(word) ?? ["count", 1n];
    const stated = move.facts.some((f) => f.unit === unit && f.value >= 0n && states(number, fraction.length, significant, f.value, divisor, f.loose));
    if (!stated) return `the number ${match[1]}${UNITS.has(word) ? ` ${word}` : ""} is not one of this move's true numbers`;
  }
  return null;
}

/* ==========================================================================================
 * THE OPTIONAL MODEL. It is shown the game and the offered moves, and answers with the ids it
 * would take and a note for each. It never sees a key and never builds a transaction. If its
 * answer is anything but perfect, all of it is thrown away and the rules decide.
 * ======================================================================================== */

/** The shape the model is asked for, as a JSON schema (structured output). */
export const ANSWER_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    moves: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string", enum: ["settle", "feed", "clock_down", "clock_up"] }, note: { type: "string" } },
        required: ["id", "note"],
        additionalProperties: false,
      },
    },
  },
  required: ["moves"],
  additionalProperties: false,
});

const ORDER = ["settle", "feed", "clock_down", "clock_up"];
const showFact = (f) => (f.unit === "sol" ? `${formatSol(f.value)} SOL` : f.unit === "time" ? (f.loose ? formatElapsed(f.value) : formatClock(f.value)) : `${f.value}`);

/** What the model is told. Only numbers and addresses read from the chain: no text a stranger wrote. */
export function buildPrompt(decision, overrides = {}) {
  const config = resolveConfig(overrides);
  const { game } = decision;
  const system = [
    "You host a Last Buyer Wins game for a token on Solana. Every buy restarts a countdown; when it runs out, the last buyer wins the pot.",
    "You are given the state of the game and a short list of moves, each already checked against your on-chain limits. Decide which to take now, and write the public one-line note that goes on-chain with each.",
    "Rules:",
    "- Take only moves from the offered list, by id. Never invent a move and never change one.",
    "- A move marked required must be taken.",
    "- Take at most one of clock_down and clock_up.",
    `- Feed the pot when the game has gone quiet. Turn the clock down when trading is busy (around ${config.hotTrades} trades or more in ${config.windowMinutes} min), up when it is slow. Taking no move is a fine answer.`,
    `- Each note: one line, at most ${MAX_NOTE} characters, plain English in plain ASCII. No links, no emoji, no markup, nothing about price or profit. Say what you did and why.`,
    "- A note may only use the numbers listed for its move, each with the unit shown. Use no other figure.",
    'Answer with JSON only: {"moves":[{"id":"...","note":"..."}]}. An empty list means do nothing.',
  ].join("\n");
  const user = JSON.stringify({
    game: {
      round: `${game.round}`,
      phase: game.phase === "over" ? "over: the clock ran out and the winner has not been paid yet"
        : game.phase === "waiting" ? "waiting for its first buy" : `running, ${formatElapsed(game.endsIn)} left on the clock`,
      pot: `${formatSol(game.pot)} SOL`,
      clock: formatClock(game.clock),
      last_buyer: game.leader ? shortKey(game.leader) : "nobody yet",
      trades_in_window: game.known ? `${game.atLeast ? "over " : ""}${game.trades} in ${config.windowMinutes} min` : "unknown",
      last_trade: game.sinceTrade === null ? "none seen" : `${formatElapsed(game.sinceTrade)} ago`,
      budget: `${formatSol(game.budget)} SOL`,
      left_of_todays_cap: `${formatSol(game.leftToday)} SOL`,
    },
    offered: decision.offered.map((move) => ({
      id: move.id,
      does: move.does,
      required: move.required === true,
      the_rules_would_take_it: decision.chosen.includes(move.id),
      numbers_you_may_use: [...new Set(move.facts.map((f) => `${showFact(f)} (${f.what})`))],
      names_you_may_use: move.names.slice(0, 1),
      example_note: move.note,
    })),
  }, null, 1);
  return { system, user };
}

/**
 * Checks a model's answer against the offered moves. Returns { ok: true, moves } with the
 * offered moves it picked, each carrying the model's note, in the order the host sends them;
 * or { ok: false, reason }, and then the caller uses the rules' choice and template notes.
 */
export function validateAnswer(text, decision) {
  const bad = (reason) => ({ ok: false, reason });
  let answer;
  try {
    answer = JSON.parse(text);
  } catch {
    return bad("the answer is not JSON");
  }
  if (answer === null || typeof answer !== "object" || Array.isArray(answer)) return bad("the answer is not an object");
  if (Object.keys(answer).join() !== "moves" || !Array.isArray(answer.moves)) return bad('the answer must have exactly one field, "moves", holding a list');
  if (answer.moves.length > decision.offered.length) return bad("the answer takes more moves than were offered");

  const picked = new Map();
  for (const item of answer.moves) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return bad("a move in the answer is not an object");
    if (Object.keys(item).sort().join() !== "id,note") return bad('each move must have exactly "id" and "note": anything else would be changing the move');
    const move = decision.offered.find((offer) => offer.id === item.id);
    if (!move) return bad(`"${String(item.id).slice(0, 40)}" is not one of the offered moves`);
    if (picked.has(move.id)) return bad(`"${move.id}" is taken twice`);
    const flaw = checkNote(item.note, move);
    if (flaw) return bad(`note for "${move.id}": ${flaw}`);
    picked.set(move.id, { ...move, note: item.note, wroteNote: "model" });
  }
  if (picked.has("clock_down") && picked.has("clock_up")) return bad("the answer turns the clock both ways");
  for (const move of decision.offered) {
    if (move.required && !picked.has(move.id)) return bad(`"${move.id}" is owed and the answer leaves it out`);
  }
  return { ok: true, moves: ORDER.filter((id) => picked.has(id)).map((id) => picked.get(id)) };
}

/** The moves the rules pick, with their template notes, in the order the host sends them. */
export function ruleMoves(decision) {
  return ORDER.filter((id) => decision.chosen.includes(id)).map((id) => ({ ...decision.offered.find((move) => move.id === id), wroteNote: "template" }));
}

/* ==========================================================================================
 * AFTER THE SIMULATION: did the transaction do what its note says?
 * `before` and `after` are { rules, rulesLamports, leash } (decoded accounts). Returns null when
 * the outcome matches the move, otherwise what differs; the runner then sends nothing.
 * ======================================================================================== */

export function checkOutcome(move, before, after) {
  if (move.kind === "feed") {
    const added = after.rulesLamports - before.rulesLamports;
    if (added !== move.amount) return `the pot would grow by ${added} lamports, the note says ${move.amount}`;
    if (after.leash.total_spent - before.leash.total_spent !== move.amount) return "the leash would not count the amount the note says";
    return null;
  }
  if (move.kind === "clock") {
    const value = after.leash.params[move.dial].value;
    return value === move.to ? null : `the dial would read ${value}, the note says ${move.to}`;
  }
  if (move.kind === "settle") {
    if (after.rules.lbw_round !== before.rules.lbw_round + 1n) return "the round would not close";
    if (after.rules.lbw_last_winner !== move.winner) return `the winner on record would be ${after.rules.lbw_last_winner}, not ${move.winner}`;
    if (after.rules.lbw_last_prize !== move.prize) return `the prize would be ${after.rules.lbw_last_prize} lamports, the note says ${move.prize}`;
    return null;
  }
  return `unknown kind of move: ${move.kind}`;
}
