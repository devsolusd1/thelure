// Tests for the host: first what it decides (host-policy.mjs), then how the runner conducts
// itself (host-agent.mjs). No network: every game here is made up.
//
//   node --test host-policy.test.mjs      (or: npm run test:host)

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ANSWER_SCHEMA, base58, buildPrompt, checkNote, checkOutcome, decide, decodeLeash, decodeRules, DEFAULT_CONFIG, DUST_LAMPORTS,
  encodeLeash, encodeMint, encodeRules, formatClock, formatElapsed, formatSol, hookOnMint, LEASH, leftToday, MAX_NOTE, MINT_LAYOUT, NO_KEY,
  resolveConfig, ruleMoves, RULES, setParamData, setParamRefusal, settleData, settleOutcome, spendData, spendRefusal, summarizeActivity,
  unbase58, validateAnswer,
} from "./host-policy.mjs";

/* ---------------- A made-up game ---------------- */

const key = (n) => base58(new Uint8Array(32).fill(n));
const [MINT, CREATOR, CURVE, AGENT, HOOK, LEASH_PROGRAM, RULES_AT, LEASH_AT, BUYER, STRANGER] = [1, 2, 3, 7, 20, 21, 30, 31, 40, 99].map(key);
const SYSTEM = NO_KEY;
const T0 = 1_800_000_000n;
const RENT = { rules: 2_032_000n, leash: 2_844_800n };
const WALLET_RENT = 650_240n;
const U64_MAX = (1n << 64n) - 1n;
const I64_MAX = (1n << 63n) - 1n;
const sol = (n) => BigInt(Math.round(n * 1e9));
const minutes = (n) => n * 60;
const WALLET = { lamports: sol(1), executable: false, owner: SYSTEM, rentFloor: WALLET_RENT };
/** The token's mint with the hook attached, and the same mint after its curve has graduated. */
const HOOKED_MINT = { owner: MINT_LAYOUT.TOKEN_2022, lamports: 3_000_000n, data: encodeMint({ hookProgram: HOOK }) };
const GRADUATED = { mintAccount: { ...HOOKED_MINT, data: encodeMint({ hookProgram: NO_KEY }) } };

/**
 * One look at a game. By default: round 4 is running with 400 s left, the pot holds 0.12 SOL,
 * the clock is dial 0 of the leash at 15 minutes (5 to 60, steps of 5, cooldown long past),
 * the agent may spend 0.01 SOL a time and 0.03 a day from a 0.05 SOL budget, the hook is on
 * the mint, and the last trade was three minutes ago. `trades`, `ours` and `failed` are lists
 * of "seconds ago".
 */
function game({
  now = T0, rules = {}, leash = {}, param = {}, params, pot = sol(0.12), budget = sol(0.05),
  trades = [180], ours = [], failed = [], full = false, history, ...rest
} = {}) {
  const rulesData = encodeRules({
    flags: RULES.FLAG_LAST_BUYER_WINS, cap_param: RULES.NO_PARAM, timer_param: 0, mint: MINT, exempt_owner: CURVE, leash: LEASH_AT,
    lbw_min_buy: 100n, lbw_deadline: now + 400n, lbw_round: 3n, lbw_last_buyer: BUYER, ...rules,
  });
  const leashData = encodeLeash({
    mint: MINT, creator: CREATOR, agent: AGENT, dest0: RULES_AT, max_per_spend: sol(0.01), max_per_day: sol(0.03),
    day_start: now - 3600n, spent_today: 0n,
    params: params ?? [{ value: 900n, min: 300n, max: 3600n, max_step: 300n, cooldown: 600n, last_change: now - 7200n, ...param }],
    ...leash,
  });
  const touch = (name, failed) => (ago, i) => ({ signature: `${name}${i}`, time: now - BigInt(ago), failed });
  return {
    now, mint: MINT, agent: AGENT, hookProgram: HOOK, leashProgram: LEASH_PROGRAM, rulesAddress: RULES_AT, leashAddress: LEASH_AT,
    rules: { owner: HOOK, lamports: RENT.rules + pot, data: rulesData },
    leash: { owner: LEASH_PROGRAM, lamports: RENT.leash + budget, data: leashData },
    mintAccount: HOOKED_MINT,
    rent: RENT,
    history: history ?? {
      touches: [...trades.map(touch("trade", false)), ...ours.map(touch("ours", false)), ...failed.map(touch("failed", true))],
      own: ours.map((_, i) => `ours${i}`),
      full,
    },
    payerLamports: sol(1), signatures: 1,
    ...rest,
  };
}

const QUIET = { trades: [minutes(45)] };
const HOT = { trades: [10, 40, 90, 150, 200, 300, 420, 590] };
const OVER = { rules: { lbw_deadline: T0 - 1n }, winner: WALLET };
const offer = (decision, id) => decision.offered.find((move) => move.id === id);
const ids = (decision) => decision.offered.map((move) => move.id);
const idleLine = (decision, start) => decision.idle.find((line) => line.startsWith(start)) ?? "";

/** Whatever the host offers must be something the leash would let through, with an honest note. */
function assertSound(look, decision) {
  const leash = decodeLeash(look.leash.data);
  const budget = look.leash.lamports - look.rent.leash;
  for (const move of decision.offered) {
    assert.equal(checkNote(move.note, move), null, `note "${move.note}"`);
    assert.ok(move.note.length <= MAX_NOTE, `note is ${move.note.length} characters: ${move.note}`);
    if (move.kind === "feed") {
      assert.equal(spendRefusal(leash, { signer: look.agent, leashAddress: look.leashAddress, index: move.index, destination: look.rulesAddress, amount: move.amount, now: look.now, budget }), null);
      assert.ok(move.amount >= DUST_LAMPORTS && move.amount <= leash.max_per_spend && move.amount <= leftToday(leash, look.now) && move.amount <= budget);
    }
    if (move.kind === "clock") {
      assert.equal(setParamRefusal(leash, { signer: look.agent, index: move.dial, value: move.to, now: look.now }), null);
      assert.notEqual(move.to, move.from);
    }
  }
  for (const id of decision.chosen) assert.ok(offer(decision, id), `chosen move ${id} was not offered`);
  assert.ok(!(decision.chosen.includes("clock_down") && decision.chosen.includes("clock_up")));
}

/* ---------------- The layouts still match the Rust ---------------- */

const programs = process.env.LURE_PROGRAMS ?? fileURLToPath(new URL("..", import.meta.url));
const source = (path) => (existsSync(`${programs}/${path}`) ? readFileSync(`${programs}/${path}`, "utf8") : null);
const rust = { hookState: source("hook/src/state.rs"), hookProcessor: source("hook/src/processor.rs"), leashState: source("leash/src/state.rs"), leashProcessor: source("leash/src/processor.rs") };
const noSources = Object.values(rust).some((text) => text === null) && "the Rust sources are not next to this file (set LURE_PROGRAMS to the programs folder)";

const constant = (text, name) => {
  const match = new RegExp(`pub const ${name}: [^=]+= ([^;]+);`).exec(text);
  assert.ok(match, `constant ${name} not found in the Rust source`);
  return match[1].trim();
};
const number = (text) => text.replaceAll("_", "").split("*").reduce((product, factor) => product * Number(factor), 1);

/** Offsets of a `#[repr(C)]` struct made of u8, u64, i64, keys and arrays of them. */
function rustLayout(text, name, known = {}) {
  const body = new RegExp(`pub struct ${name} \\{([\\s\\S]*?)\\n\\}`).exec(text);
  assert.ok(body, `struct ${name} not found in the Rust source`);
  const sizeOf = (type) => {
    const array = /^\[(.+); (\w+)\]$/.exec(type);
    if (array) {
      const [size, align] = sizeOf(array[1]);
      const count = /^\d+$/.test(array[2]) ? Number(array[2]) : known[array[2]];
      assert.ok(Number.isInteger(count), `array length ${array[2]} in ${name}`);
      return [size * count, align];
    }
    const simple = { u8: [1, 1], u64: [8, 8], i64: [8, 8], Key: [32, 1], ...known }[type];
    assert.ok(Array.isArray(simple), `type ${type} in ${name} is new to this test`);
    return simple;
  };
  const fields = {};
  let at = 0;
  let widest = 1;
  for (const [, field, type] of body[1].matchAll(/^\s*pub (\w+): ([^,]+),/gm)) {
    const [size, align] = sizeOf(type.trim());
    at = Math.ceil(at / align) * align;
    fields[field] = { at, type: type.trim() };
    at += size;
    widest = Math.max(widest, align);
  }
  return { fields, size: Math.ceil(at / widest) * widest, align: widest };
}

const sameType = (ours, theirs) => ({ u8: "u8", u64: "u64", i64: "i64", key: "Key" })[ours] === theirs;

test("the rules layout is the one in programs/hook/src/state.rs", { skip: noSources }, () => {
  const layout = rustLayout(rust.hookState, "Rules");
  assert.equal(number(constant(rust.hookState, "VERSION")), RULES.VERSION, "the hook writes a layout version this host does not read: update RULES in host-policy.mjs");
  assert.equal(layout.size, RULES.LEN, "the rules account changed size: update RULES in host-policy.mjs");
  assert.match(rust.hookState, new RegExp(`assert!\\(RULES_LEN == ${RULES.LEN}\\)`));
  for (const [name, [at, type]] of Object.entries(RULES.FIELDS)) {
    assert.ok(layout.fields[name], `Rules.${name} is gone from the Rust`);
    assert.equal(at, layout.fields[name].at, `offset of Rules.${name}`);
    assert.ok(sameType(type, layout.fields[name].type), `type of Rules.${name}: ${layout.fields[name].type}`);
  }
  const unread = Object.keys(layout.fields).filter((name) => !(name in RULES.FIELDS) && name !== "_pad");
  assert.deepEqual(unread, [], "the Rust has fields this host does not know");
  assert.equal(number(constant(rust.hookState, "FLAG_LAST_BUYER_WINS")), RULES.FLAG_LAST_BUYER_WINS);
  assert.equal(number(constant(rust.hookState, "NO_PARAM")), RULES.NO_PARAM);
  assert.equal(BigInt(number(constant(rust.hookState, "MAX_TIMER"))), RULES.MAX_TIMER);
  assert.ok(rust.hookState.includes("knobs.timer = value.clamp(1, MAX_TIMER);"), "the hook no longer reads the dial as clamp(value, 1, MAX_TIMER)");
  for (const [code, name] of Object.entries(RULES.ERRORS)) assert.match(rust.hookState, new RegExp(`\\b${name} = ${code},`), `HookError::${name}`);
});

test("settle, the seed and the unpayable addresses are the ones in programs/hook/src/processor.rs", { skip: noSources }, () => {
  assert.equal(number(constant(rust.hookProcessor, "SETTLE")), RULES.SETTLE_TAG);
  assert.equal(constant(rust.hookProcessor, "RULES_SEED"), `b"${RULES.SEED}"`);
  assert.equal(constant(rust.hookProcessor, "TOKEN_2022"), `address!("${MINT_LAYOUT.TOKEN_2022}")`);
  assert.equal(number(constant(rust.hookState.replace("const BASE_LEN", "pub const BASE_LEN"), "BASE_LEN")), MINT_LAYOUT.TYPE_AT);
  assert.match(rust.hookProcessor, /Some\(\(&SETTLE, \[\]\)\) => settle/, "settle no longer takes exactly its tag as data");
  assert.match(rust.hookProcessor, /let \[rules, winner, \.\.\] = accounts else/, "settle's accounts are no longer [rules, winner]");
  assert.equal(constant(rust.hookProcessor.replace("const SYSVAR_OWNER", "pub const SYSVAR_OWNER"), "SYSVAR_OWNER"), `address!("${RULES.SYSVAR_OWNER}")`);
  const reserved = /const RESERVED: \[Address; (\d+)\] = \[([\s\S]*?)\];/.exec(rust.hookProcessor);
  assert.ok(reserved, "the RESERVED list is gone from the Rust");
  const listed = [...reserved[2].matchAll(/address!\("(\w+)"\)/g)].map((match) => match[1]);
  if (/\bSYSVAR_OWNER,/.test(reserved[2])) listed.push(RULES.SYSVAR_OWNER);
  assert.equal(listed.length, Number(reserved[1]));
  assert.deepEqual([...RULES.RESERVED].sort(), listed.sort());
});

test("the leash layout, tags and errors are the ones in programs/leash/src", { skip: noSources }, () => {
  const param = rustLayout(rust.leashState, "Param");
  const maxParams = number(constant(rust.leashState, "MAX_PARAMS"));
  const layout = rustLayout(rust.leashState, "Leash", { Param: [param.size, param.align], MAX_PARAMS: maxParams });
  assert.equal(number(constant(rust.leashState, "VERSION")), LEASH.VERSION);
  assert.equal(maxParams, LEASH.MAX_PARAMS);
  assert.equal(BigInt(number(constant(rust.leashState, "DAY"))), LEASH.DAY);
  assert.equal(layout.size, LEASH.LEN);
  assert.equal(param.size, LEASH.PARAM_LEN);
  assert.equal(layout.fields.params.at, LEASH.PARAMS_AT);
  const theirs = { ...layout.fields, dest0: { at: layout.fields.dest.at, type: "Key" }, dest1: { at: layout.fields.dest.at + 32, type: "Key" } };
  assert.equal(layout.fields.dest.type, "[Key; 2]");
  for (const [name, [at, type]] of Object.entries(LEASH.FIELDS)) {
    assert.equal(at, theirs[name]?.at, `offset of Leash.${name}`);
    assert.ok(sameType(type, theirs[name].type), `type of Leash.${name}`);
  }
  for (const [name, [at, type]] of Object.entries(LEASH.PARAM_FIELDS)) {
    assert.equal(at, param.fields[name]?.at, `offset of Param.${name}`);
    assert.ok(sameType(type, param.fields[name].type), `type of Param.${name}`);
  }
  assert.deepEqual(Object.keys(param.fields), Object.keys(LEASH.PARAM_FIELDS));
  const errors = [...rust.leashState.split("pub enum LeashError {")[1].split("}")[0].matchAll(/^\s*(\w+) = (\d+),/gm)];
  assert.deepEqual(errors.map((match) => match[1]), LEASH.ERRORS);
  errors.forEach((match, index) => assert.equal(Number(match[2]), index));
  assert.equal(number(constant(rust.leashProcessor, "SPEND")), LEASH.SPEND_TAG);
  assert.equal(number(constant(rust.leashProcessor, "SET_PARAM")), LEASH.SET_PARAM_TAG);
  assert.equal(constant(rust.leashProcessor, "SEED"), `b"${LEASH.SEED}"`);
});

test("a rules account of another length or version is refused, loudly", () => {
  assert.equal(RULES.LEN, 272);
  assert.equal(RULES.VERSION, 2);
  const good = encodeRules({ flags: 1, mint: MINT });
  assert.equal(decodeRules(good).mint, MINT);

  const layout1 = new Uint8Array(120);
  layout1[0] = 1;
  assert.throws(() => decodeRules(layout1), /120 bytes with version byte 1; this host reads layout 2 only \(272 bytes\)/);
  for (const length of [0, 271, 273, 432]) assert.throws(() => decodeRules(new Uint8Array(length).fill(2)), /this host reads layout 2 only/);
  for (const version of [0, 1, 3, 255]) {
    const other = encodeRules({ flags: 1, mint: MINT });
    other[0] = version;
    assert.throws(() => decodeRules(other), new RegExp(`version byte ${version}`));
  }
  assert.throws(() => decodeLeash(new Uint8Array(431)), /this host reads layout 1 only \(432 bytes\)/);
  assert.throws(() => decodeLeash(new Uint8Array(432).fill(2)), /version byte 2/);

  // And the host does nothing with such an account.
  const old = decide({ ...game(), rules: { owner: HOOK, lamports: 1_259_840n, data: layout1 } });
  assert.equal(old.refuse.code, "rules-version");
  assert.deepEqual(old.offered, []);
});

test("accounts read back the way they were written", () => {
  const rules = decodeRules(game({ rules: { lbw_timer: -5n, lbw_last_prize: U64_MAX, bump: 254 } }).rules.data);
  assert.deepEqual([rules.version, rules.bump, rules.flags, rules.cap_param, rules.timer_param], [2, 254, 1, 255, 0]);
  assert.deepEqual([rules.mint, rules.exempt_owner, rules.leash, rules.lbw_last_buyer, rules.lbw_last_winner], [MINT, CURVE, LEASH_AT, BUYER, NO_KEY]);
  assert.deepEqual([rules.lbw_timer, rules.lbw_deadline, rules.lbw_round, rules.lbw_last_prize], [-5n, T0 + 400n, 3n, U64_MAX]);
  const leash = decodeLeash(game().leash.data);
  assert.deepEqual([leash.param_count, leash.agent, leash.dest0, leash.dest1, leash.max_per_spend, leash.max_per_day], [1, AGENT, RULES_AT, NO_KEY, sol(0.01), sol(0.03)]);
  assert.deepEqual(leash.params[0], { value: 900n, min: 300n, max: 3600n, max_step: 300n, cooldown: 600n, last_change: T0 - 7200n });
  // A key at its documented offset, byte for byte.
  assert.deepEqual([...game().leash.data.subarray(72, 104)], new Array(32).fill(7));
  assert.deepEqual([...game().rules.data.subarray(192, 224)], new Array(32).fill(40));
  assert.equal(base58(new Uint8Array(32)), NO_KEY);
  const program = "GrojbAndyBXQTo5GxgqXAmDDKjDWkPBPeGniBEQsa89p";
  assert.equal(unbase58(program).length, 32);
  assert.equal(base58(unbase58(program)), program);
});

test("instruction data is byte for byte what the programs parse", () => {
  // spend: tag 1, destination index, amount u64 little-endian. 5,000,000 = 0x4c4b40.
  assert.deepEqual([...spendData(0, 5_000_000n)], [1, 0, 0x40, 0x4b, 0x4c, 0, 0, 0, 0, 0]);
  assert.deepEqual([...spendData(1, U64_MAX)], [1, 1, 255, 255, 255, 255, 255, 255, 255, 255]);
  // set_param: tag 3, dial index, value i64 little-endian. 600 = 0x258.
  assert.deepEqual([...setParamData(0, 600n)], [3, 0, 0x58, 0x02, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...setParamData(3, -1n)], [3, 3, 255, 255, 255, 255, 255, 255, 255, 255]);
  // settle: the tag alone.
  assert.deepEqual([...settleData()], [1]);
});

/* ---------------- The programs' checks, mirrored ---------------- */

test("the spend check refuses what the leash refuses, in the leash's order", () => {
  const leash = decodeLeash(game({ leash: { dest1: STRANGER, spent_today: sol(0.025) } }).leash.data);
  const ask = (changes = {}) => spendRefusal(leash, { signer: AGENT, leashAddress: LEASH_AT, index: 0, destination: RULES_AT, amount: sol(0.005), now: T0, budget: sol(0.05), ...changes });
  assert.equal(ask(), null);
  assert.equal(ask({ destination: LEASH_AT }), "BadDestination");
  assert.equal(ask({ signer: STRANGER }), "NotAgent");
  assert.equal(ask({ destination: STRANGER }), "BadDestination");
  assert.equal(ask({ index: 1 }), "BadDestination");
  assert.equal(ask({ index: 1, destination: STRANGER }), null);
  assert.equal(ask({ index: 2 }), "BadDestination");
  assert.equal(ask({ amount: 0n }), "ZeroAmount");
  assert.equal(ask({ amount: sol(0.01) + 1n }), "OverActionCap");
  assert.equal(ask({ amount: sol(0.005) + 1n }), "OverDailyCap", "0.025 already spent of 0.03");
  assert.equal(ask({ amount: sol(0.005), budget: sol(0.005) - 1n }), "OverBudget");
  assert.equal(ask({ amount: sol(0.005), budget: sol(0.005) }), null, "exactly the budget is allowed");
  // Order: the cap per action is checked before the day's, the day's before the budget.
  assert.equal(ask({ amount: sol(1), budget: 0n }), "OverActionCap");
  assert.equal(ask({ amount: sol(0.01), budget: 0n }), "OverDailyCap");
  // A new window starts once 24 hours have passed since day_start, not a second sooner.
  assert.equal(ask({ amount: sol(0.01), now: T0 - 3600n + 86_399n }), "OverDailyCap");
  assert.equal(ask({ amount: sol(0.01), now: T0 - 3600n + 86_400n }), null);

  const revoked = decodeLeash(game({ leash: { agent: NO_KEY } }).leash.data);
  assert.equal(spendRefusal(revoked, { signer: NO_KEY, leashAddress: LEASH_AT, index: 0, destination: RULES_AT, amount: 1n, now: T0, budget: 1n }), "NotAgent");
  const unset = decodeLeash(game({ leash: { dest0: NO_KEY } }).leash.data);
  assert.equal(spendRefusal(unset, { signer: AGENT, leashAddress: LEASH_AT, index: 0, destination: NO_KEY, amount: 1n, now: T0, budget: 1n }), "BadDestination");
  const huge = decodeLeash(game({ leash: { max_per_spend: U64_MAX, max_per_day: U64_MAX, spent_today: U64_MAX - 5n } }).leash.data);
  assert.equal(spendRefusal(huge, { signer: AGENT, leashAddress: LEASH_AT, index: 0, destination: RULES_AT, amount: 6n, now: T0, budget: U64_MAX }), "OverDailyCap", "the day's total can't overflow");
});

test("the dial check refuses what the leash refuses, in the leash's order", () => {
  const leash = decodeLeash(game({ param: { cooldown: 600n, last_change: T0 - 600n } }).leash.data);
  const ask = (changes = {}) => setParamRefusal(leash, { signer: AGENT, index: 0, value: 600n, now: T0, ...changes });
  assert.equal(ask(), null);
  assert.equal(ask({ signer: STRANGER }), "NotAgent");
  assert.equal(ask({ index: 1 }), "BadParam");
  assert.equal(ask({ index: 4 }), "BadParam");
  assert.equal(ask({ value: 299n }), "ParamOutOfBounds");
  assert.equal(ask({ value: 3601n }), "ParamOutOfBounds");
  assert.equal(ask({ value: 1201n }), "ParamStepTooBig");
  assert.equal(ask({ value: 599n }), "ParamStepTooBig");
  assert.equal(ask({ value: 1200n }), null);
  assert.equal(ask({ now: T0 - 1n }), "ParamCooldown");
  assert.equal(ask({ value: 900n }), null, "the same value is not refused (the host just never proposes it)");
  // Out of range is reported before too big a step, and both before the cooldown.
  assert.equal(ask({ value: 9999n, now: T0 - 1n }), "ParamOutOfBounds");
  assert.equal(ask({ value: 1500n, now: T0 - 1n }), "ParamStepTooBig");
  const free = decodeLeash(game({ param: { max_step: 0n, cooldown: 0n } }).leash.data);
  assert.equal(setParamRefusal(free, { signer: AGENT, index: 0, value: 3600n, now: T0 }), null, "a step of 0 means anywhere in the range");
});

test("the settle check pays the pot, pays nothing, or refuses, as the hook does", () => {
  const rules = decodeRules(game({ rules: { lbw_deadline: T0 } }).rules.data);
  const ask = (changes = {}, payee = {}) => settleOutcome(rules, { now: T0, winner: BUYER, rulesAddress: RULES_AT, pot: sol(0.12), payee: { ...WALLET, ...payee }, ...changes });
  assert.deepEqual(ask(), { prize: sol(0.12) });
  assert.deepEqual(ask({ now: T0 - 1n }), { refusal: "RoundNotOver" });
  assert.deepEqual(ask({ winner: STRANGER }), { refusal: "NotTheWinner" });
  assert.deepEqual(settleOutcome({ ...rules, lbw_deadline: 0n }, { now: I64_MAX, winner: BUYER, rulesAddress: RULES_AT, pot: 1n, payee: WALLET }), { refusal: "RoundNotOver" });
  assert.deepEqual(settleOutcome({ ...rules, flags: 0 }, { now: T0, winner: BUYER, rulesAddress: RULES_AT, pot: 1n, payee: WALLET }), { refusal: "GameOff" });
  // Winners that can't hold SOL get nothing; the round closes all the same.
  assert.deepEqual(ask({}, { executable: true }), { prize: 0n });
  assert.deepEqual(ask({}, { owner: RULES.SYSVAR_OWNER }), { prize: 0n });
  assert.deepEqual(ask({ rulesAddress: BUYER }), { prize: 0n });
  assert.deepEqual(ask({}, { lamports: U64_MAX }), { prize: 0n }, "never overflows");
  const empty = { lamports: 0n, rentFloor: WALLET_RENT };
  assert.deepEqual(ask({ pot: WALLET_RENT - 1n }, empty), { prize: 0n });
  assert.deepEqual(ask({ pot: WALLET_RENT }, empty), { prize: WALLET_RENT });
  assert.deepEqual(ask({ pot: 0n }), { prize: 0n });
  const toSystem = { ...rules, lbw_last_buyer: NO_KEY };
  assert.deepEqual(settleOutcome(toSystem, { now: T0, winner: NO_KEY, rulesAddress: RULES_AT, pot: 5n, payee: WALLET }), { prize: 0n }, "a reserved address");
});

/* ---------------- Reading the game's pulse ---------------- */

test("activity counts landed trades, and tells the host's own transactions apart", () => {
  const at = (ago, signature, failed = false) => ({ signature, time: T0 - BigInt(ago), failed });
  const history = { touches: [at(30, "a"), at(100, "mine"), at(500, "b"), at(599, "boom", true), at(600, "c"), at(601, "d"), at(9000, "e")], own: ["mine", "elsewhere"] };
  assert.deepEqual(summarizeActivity(history, T0, 600n), { known: true, sinceTouch: 30n, sinceTrade: 30n, trades: 3, atLeast: false });
  // The newest transaction is the host's own: the game was touched 100 s ago, traded 500 s ago.
  const fed = { touches: history.touches.slice(1), own: ["mine"] };
  assert.deepEqual(summarizeActivity(fed, T0, 600n), { known: true, sinceTouch: 100n, sinceTrade: 500n, trades: 2, atLeast: false });
  // Nothing but the host's own transactions: no trade to speak of.
  assert.deepEqual(summarizeActivity({ touches: [at(100, "mine")], own: ["mine"] }, T0, 600n), { known: true, sinceTouch: 100n, sinceTrade: null, trades: 0, atLeast: false });
  // No history, or only failures: the host knows nothing and says so.
  for (const touches of [[], [at(5, "x", true)]]) assert.equal(summarizeActivity({ touches }, T0, 600n).known, false);
  assert.equal(summarizeActivity(undefined, T0, 600n).known, false);
  // A row the node has not dated yet, at the head of the list, is a trade that just landed;
  // an undated row further down is old data and is left out.
  const undated = (signature) => ({ signature, time: null, failed: false });
  assert.deepEqual(summarizeActivity({ touches: [undated("new"), at(3000, "old")] }, T0, 600n), { known: true, sinceTouch: 0n, sinceTrade: 0n, trades: 1, atLeast: false });
  assert.deepEqual(summarizeActivity({ touches: [at(3000, "old"), undated("older")] }, T0, 600n), { known: true, sinceTouch: 3000n, sinceTrade: 3000n, trades: 0, atLeast: false });
  assert.equal(offer(decide(game({ history: { touches: [undated("new"), at(3000, "old")], own: [] } })), "feed"), undefined, "so a quiet-looking game with a fresh trade is not fed");
  // A full page that ends inside the window is a floor, not a count.
  const busy = { touches: Array.from({ length: 1000 }, (_, i) => at(i % 500, `s${i}`)), full: true };
  assert.deepEqual(summarizeActivity(busy, T0, 600n), { known: true, sinceTouch: 0n, sinceTrade: 0n, trades: 1000, atLeast: true });
  assert.equal(summarizeActivity({ ...busy, touches: [...busy.touches, at(601, "old")] }, T0, 600n).atLeast, false);
  // A block time a second ahead of the clock is "just now", not negative.
  assert.equal(summarizeActivity({ touches: [at(-2, "z")] }, T0, 600n).sinceTouch, 0n);
});

/* ---------------- The three moves ---------------- */

test("a game that is neither quiet, hot nor cold is left alone", () => {
  const look = game();
  const decision = decide(look);
  assert.equal(decision.refuse, null);
  assert.deepEqual(decision.chosen, []);
  assert.deepEqual(ruleMoves(decision), []);
  // Both turns of the clock are within the leash, so they are on the table; the rules take neither.
  assert.deepEqual(ids(decision), ["clock_down", "clock_up"]);
  assert.match(idleLine(decision, "feed"), /not quiet, the last transaction was 3 min ago \(quiet is 40 min\)/);
  assert.match(idleLine(decision, "clock"), /1 trade in 10 min is neither hot \(8 or more\) nor cold \(0 or fewer\)/);
  assert.deepEqual([decision.game.phase, decision.game.round, decision.game.pot, decision.game.clock, decision.game.endsIn], ["running", 4n, sol(0.12), 900n, 400n]);
  assertSound(look, decision);
});

test("a quiet game is fed", () => {
  const look = game(QUIET);
  const decision = decide(look);
  const feed = offer(decision, "feed");
  assert.equal(feed.amount, sol(0.005));
  assert.equal(feed.potAfter, sol(0.125));
  assert.equal(feed.note, "No bite for 45 min. Added 0.005 SOL: the pot is 0.125 SOL.");
  assert.ok(decision.chosen.includes("feed"));
  assertSound(look, decision);

  // Quiet starts at exactly quietMinutes, and is about the game as a whole.
  assert.ok(offer(decide(game({ trades: [minutes(40)] })), "feed"));
  assert.equal(offer(decide(game({ trades: [minutes(40) - 1] })), "feed"), undefined);
  assert.equal(offer(decide(game({ trades: [minutes(45), 60] })), "feed"), undefined);
  assert.ok(offer(decide(game({ trades: [minutes(10)] }), { quietMinutes: 10 }), "feed"));
  // A waiting round (no first buy yet) is fed the same way.
  assert.ok(offer(decide(game({ ...QUIET, rules: { lbw_deadline: 0n, lbw_last_buyer: NO_KEY } })), "feed"));
});

test("a feed never goes past the cap per action", () => {
  const look = game({ ...QUIET, leash: { max_per_spend: sol(0.003) } });
  const decision = decide(look);
  assert.equal(offer(decision, "feed").amount, sol(0.003));
  assert.equal(offer(decision, "feed").note, "No bite for 45 min. Added 0.003 SOL: the pot is 0.123 SOL.");
  assertSound(look, decision);
  // A cap of 0 switches spending off altogether.
  const off = decide(game({ ...QUIET, leash: { max_per_spend: 0n, max_per_day: 0n } }));
  assert.equal(offer(off, "feed"), undefined);
  assert.match(idleLine(off, "feed"), /cap per action is too small/);
});

test("a feed never goes past what is left of today's cap", () => {
  const spent = (amount, dayStartAgo = 3600n) => game({ ...QUIET, leash: { spent_today: amount, day_start: T0 - dayStartAgo } });
  const some = decide(spent(sol(0.028)));
  assert.equal(offer(some, "feed").amount, sol(0.002));
  assertSound(spent(sol(0.028)), some);

  const none = decide(spent(sol(0.03)));
  assert.equal(offer(none, "feed"), undefined);
  assert.match(idleLine(none, "feed"), /today's cap of 0.03 SOL is used up, it resets in 23 h/);
  assert.equal(offer(decide(spent(sol(0.03) - 99_999n)), "feed"), undefined, "what is left is dust");

  // The window is fixed: 24 hours from day_start. One second before it ends nothing is left;
  // at 24 hours the leash starts a new day and the whole cap is back.
  assert.equal(offer(decide(spent(sol(0.03), 86_399n)), "feed"), undefined);
  assert.equal(offer(decide(spent(sol(0.03), 86_400n)), "feed").amount, sol(0.005));
  assertSound(spent(sol(0.03), 86_400n), decide(spent(sol(0.03), 86_400n)));
});

test("a feed never goes past the budget above rent", () => {
  const thin = game({ ...QUIET, budget: 1_234_567n });
  const decision = decide(thin);
  // Cut to three digits so the note can state it exactly.
  assert.equal(offer(decision, "feed").amount, 1_230_000n);
  assert.equal(offer(decision, "feed").note, "No bite for 45 min. Added 0.00123 SOL: the pot is 0.121 SOL.");
  assertSound(thin, decision);

  const empty = decide(game({ ...QUIET, budget: 0n }));
  assert.equal(offer(empty, "feed"), undefined);
  assert.match(idleLine(empty, "feed"), /the budget is down to 0 SOL/);
  // The rent reserve is not budget: an account holding exactly its rent has nothing to give.
  const atRent = { ...game(QUIET), leash: { ...game(QUIET).leash, lamports: RENT.leash } };
  assert.equal(offer(decide(atRent), "feed"), undefined);
  const underRent = { ...atRent, leash: { ...atRent.leash, lamports: RENT.leash - 5n } };
  assert.equal(offer(decide(underRent), "feed"), undefined);
  assert.equal(decide(underRent).game.budget, 0n);
});

test("a feed stops at the pot's ceiling", () => {
  const near = game({ ...QUIET, pot: sol(0.248) });
  assert.equal(offer(decide(near), "feed").amount, sol(0.002));
  assert.equal(offer(decide(near), "feed").potAfter, sol(0.25));
  assertSound(near, decide(near));
  const full = decide(game({ ...QUIET, pot: sol(0.25) }));
  assert.equal(offer(full, "feed"), undefined);
  assert.match(idleLine(full, "feed"), /the pot is 0.25 SOL, at the 0.25 SOL ceiling/);
  assert.equal(offer(decide(game({ ...QUIET, pot: sol(3) })), "feed"), undefined);
  assert.equal(offer(decide(game({ ...QUIET, pot: sol(3) }), { potCeilingSol: 5, feedSol: 1 }), "feed").amount, sol(0.01), "still the leash's cap");
  assert.equal(offer(decide(game(QUIET), { feedSol: 0 }), "feed"), undefined);
});

test("the host's own feed restarts the quiet timer, so feeds are spaced", () => {
  // Last trade 50 minutes ago, own feed 10 minutes ago: not yet.
  const justFed = decide(game({ trades: [minutes(50)], ours: [minutes(10)] }));
  assert.equal(offer(justFed, "feed"), undefined);
  assert.match(idleLine(justFed, "feed"), /the last transaction was 10 min ago/);
  // Forty minutes after that feed, and still no trade: feed again, and say how long it has really been.
  const again = decide(game({ trades: [minutes(80)], ours: [minutes(40)] }));
  assert.equal(offer(again, "feed").note, "No bite for 80 min. Added 0.005 SOL: the pot is 0.125 SOL.");
  // No trade on record at all, only the host's own transactions.
  const never = decide(game({ trades: [], ours: [minutes(41)] }));
  assert.equal(offer(never, "feed").note, "No bite yet. Added 0.005 SOL: the pot is 0.125 SOL.");
});

test("a hot game gets a shorter clock, one step", () => {
  const look = game(HOT);
  const decision = decide(look);
  const down = offer(decision, "clock_down");
  assert.deepEqual([down.dial, down.from, down.to], [0, 900n, 600n]);
  assert.equal(down.note, "8 trades in 10 min. Clock down from 15 min to 10 min.");
  assert.deepEqual(decision.chosen, ["clock_down"]);
  assertSound(look, decision);

  // Seven trades is not hot. Neither are eight when one is older than the window.
  assert.deepEqual(decide(game({ trades: HOT.trades.slice(1) })).chosen, []);
  assert.deepEqual(decide(game({ trades: [...HOT.trades.slice(1), 601] })).chosen, []);
  assert.deepEqual(decide(game({ trades: [...HOT.trades.slice(1), 600] })).chosen, ["clock_down"]);
  // The host's own transactions and failed ones are not trades.
  assert.deepEqual(decide(game({ trades: HOT.trades.slice(1), ours: [5, 15], failed: [7, 8, 9] })).chosen, []);
  assert.deepEqual(decide(game({ trades: HOT.trades.slice(3) }), { hotTrades: 5 }).chosen, ["clock_down"]);
});

test("a cold game gets a longer clock, one step", () => {
  const look = game({ trades: [minutes(11)] });
  const decision = decide(look);
  const up = offer(decision, "clock_up");
  assert.deepEqual([up.from, up.to], [900n, 1200n]);
  assert.equal(up.note, "No trades in 10 min. Clock up from 15 min to 20 min.");
  assert.deepEqual(decision.chosen, ["clock_up"]);
  assertSound(look, decision);
  assert.equal(offer(decide(game({ trades: [30, minutes(11)] }), { coldTrades: 1 }), "clock_up").note, "1 trade in 10 min. Clock up from 15 min to 20 min.");
  // Quiet and cold at once: feed, then turn.
  assert.deepEqual(ruleMoves(decide(game(QUIET))).map((move) => move.id), ["feed", "clock_up"]);
});

test("the clock never leaves the leash's range, and a step is never bigger than the leash's", () => {
  const turn = (param, config, activity = HOT) => {
    const look = game({ ...activity, param });
    const decision = decide(look, config);
    assertSound(look, decision);
    return decision;
  };
  // Less than a step from the edge: go to the edge.
  assert.equal(offer(turn({ value: 400n }), "clock_down").to, 300n);
  assert.equal(offer(turn({ value: 3500n }), "clock_up").to, 3600n);
  // At the edge: no move that way, and the host says why.
  const shortest = turn({ value: 300n });
  assert.equal(offer(shortest, "clock_down"), undefined);
  assert.deepEqual(shortest.chosen, []);
  assert.match(idleLine(shortest, "clock"), /hot \(8 trades in 10 min\), but it is already as short as it may go \(5 min\)/);
  const longest = turn({ value: 3600n }, {}, { trades: [minutes(11)] });
  assert.equal(offer(longest, "clock_up"), undefined);
  assert.match(idleLine(longest, "clock"), /cold \(0 trades in 10 min\), but it is already as long as it may go \(1 h\)/);
  // The host's own floor holds where the leash would go lower.
  assert.equal(offer(turn({ value: 90n, min: 10n, max_step: 60n }), "clock_down").to, 60n);
  assert.equal(offer(turn({ value: 60n, min: 10n, max_step: 60n }), "clock_down"), undefined);
  assert.equal(offer(turn({ value: 60n, min: 10n, max_step: 60n }, { clockFloorSeconds: 20 }), "clock_down").to, 20n);
  // Step: the leash's own, a smaller one from the config, never a bigger one, 5 minutes if the leash names none.
  assert.equal(offer(turn({ value: 900n }, { clockStepSeconds: 120 }), "clock_down").to, 780n);
  assert.equal(offer(turn({ value: 900n }, { clockStepSeconds: 900 }), "clock_down").to, 600n);
  assert.equal(offer(turn({ value: 900n, max_step: 0n }), "clock_down").to, 600n);
  assert.equal(offer(turn({ value: 900n, max_step: 0n }, { clockStepSeconds: 450 }), "clock_down").to, 450n);
  assert.equal(offer(turn({ value: 905n, max_step: 7n }), "clock_down").note, "8 trades in 10 min. Clock down from 905 s to 898 s.");
  // The hook never counts more than a week, so the host never turns the dial past it.
  const week = 604_800n;
  assert.equal(offer(turn({ value: week - 100n, max: 10n ** 13n }, {}, { trades: [minutes(11)] }), "clock_up").to, week);
  assert.equal(offer(turn({ value: week, max: 10n ** 13n }, {}, { trades: [minutes(11)] }), "clock_up"), undefined);
  assert.equal(offer(turn({ value: week, max: 10n ** 13n }), "clock_down").note, "8 trades in 10 min. Clock down from 168 h to 10075 min.");
  // A dial that is not a countdown the hook would take as it is, is left alone.
  assert.deepEqual(ids(turn({ value: 0n, min: -5n })), []);
  assert.deepEqual(ids(turn({ value: -5n, min: -5n })), []);
  const absurd = turn({ value: 10n ** 13n, min: 5n * 10n ** 12n, max: 3n * 10n ** 13n, max_step: 0n });
  assert.deepEqual(ids(absurd), []);
  assert.match(idleLine(absurd, "clock"), /the dial reads 10000000000000, outside the 1 s to 7 days the hook takes as a countdown/);
  assert.equal(absurd.game.clock, week, "what the hook would really count");
});

test("no clock move before the cooldown is over, and the first one counts from launch", () => {
  // `last_change` is the launch time until the agent's first change.
  const launchedAgo = (seconds, activity = HOT) => decide(game({ ...activity, param: { cooldown: 600n, last_change: T0 - BigInt(seconds) } }));
  const early = launchedAgo(599);
  assert.deepEqual(ids(early), []);
  assert.deepEqual(early.chosen, []);
  assert.match(idleLine(early, "clock"), /cooling down, the leash allows the next change in 1 s/);
  assert.deepEqual(launchedAgo(600).chosen, ["clock_down"]);
  assert.deepEqual(ids(launchedAgo(0, { trades: [minutes(11)] })), []);
  assert.deepEqual(launchedAgo(600, { trades: [minutes(11)] }).chosen, ["clock_up"]);
  // A cooldown that never ends is a dial the creator froze.
  assert.deepEqual(ids(decide(game({ ...HOT, param: { cooldown: I64_MAX } }))), []);
  // The cooldown does not hold a feed back.
  assert.deepEqual(ids(decide(game({ ...QUIET, param: { cooldown: 600n, last_change: T0 - 5n } }))), ["feed"]);
});

test("a round that is over is settled first, and nothing else is done", () => {
  // Quiet and cold as well, so a feed and a turn would otherwise be due.
  const look = game({ ...QUIET, ...OVER });
  const decision = decide(look);
  assert.deepEqual(ids(decision), ["settle"]);
  assert.deepEqual(decision.chosen, ["settle"]);
  const settle = offer(decision, "settle");
  assert.deepEqual([settle.winner, settle.round, settle.pot, settle.prize, settle.required], [BUYER, 4n, sol(0.12), sol(0.12), true]);
  assert.equal(settle.note, `Round 4 is over. ${BUYER.slice(0, 4)}..${BUYER.slice(-4)} bought last and wins the pot: 0.12 SOL.`);
  assert.equal(decision.game.phase, "over");
  assertSound(look, decision);

  // The round ends at the deadline second itself, as in the hook (`now < deadline` is still open).
  assert.deepEqual(decide(game({ rules: { lbw_deadline: T0 }, winner: WALLET })).chosen, ["settle"]);
  assert.deepEqual(ids(decide(game({ ...QUIET, rules: { lbw_deadline: T0 + 1n }, winner: WALLET }))), ["feed", "clock_down", "clock_up"]);
  // A round waiting for its first buy has nobody to pay.
  assert.equal(offer(decide(game({ rules: { lbw_deadline: 0n, lbw_last_buyer: NO_KEY }, winner: WALLET })), "settle"), undefined);
  // Before paying, the host has to look at the winner's account.
  const blind = decide(game({ rules: { lbw_deadline: T0 - 1n } }));
  assert.equal(blind.needWinner, BUYER);
  assert.deepEqual(blind.offered, []);
});

test("the settle note says what the winner will really get", () => {
  const who = `${BUYER.slice(0, 4)}..${BUYER.slice(-4)}`;
  const settle = (extra, winner = WALLET) => {
    const look = game({ ...OVER, ...extra, winner });
    const decision = decide(look);
    assertSound(look, decision);
    return offer(decision, "settle");
  };
  const program = settle({}, { ...WALLET, executable: true });
  assert.equal(program.prize, 0n);
  assert.equal(program.note, `Round 4 is over. ${who} bought last but cannot be paid: the pot, 0.12 SOL, rolls over.`);
  const tooSmall = settle({ pot: 500_000n }, { ...WALLET, lamports: 0n });
  assert.equal(tooSmall.prize, 0n);
  assert.equal(tooSmall.note, `Round 4 is over. ${who} bought last but cannot be paid: the pot, 0.0005 SOL, rolls over.`);
  assert.equal(settle({ pot: WALLET_RENT }, { ...WALLET, lamports: 0n }).prize, WALLET_RENT);
  const nothing = settle({ pot: 0n });
  assert.equal(nothing.note, `Round 4 is over. ${who} bought last, but the pot was empty.`);
  // The longest it can get still fits.
  const longest = settle({ pot: U64_MAX - RENT.rules, rules: { lbw_deadline: T0 - 1n, lbw_round: U64_MAX } }, { ...WALLET, executable: true });
  assert.ok(longest.note.length <= MAX_NOTE, `${longest.note.length}`);
  assert.match(longest.note, /^Round 18446744073709551616 is over/);
});

test("a revoked or replaced agent does nothing", () => {
  for (const activity of [QUIET, HOT, { ...QUIET, ...OVER }]) {
    const revoked = decide(game({ ...activity, leash: { agent: NO_KEY } }));
    assert.equal(revoked.refuse.code, "agent-revoked");
    assert.deepEqual([revoked.offered, revoked.chosen], [[], []]);
    assert.deepEqual(ruleMoves(revoked), []);
    const replaced = decide(game({ ...activity, leash: { agent: STRANGER } }));
    assert.equal(replaced.refuse.code, "agent-replaced");
    assert.match(replaced.refuse.message, new RegExp(`the leash's agent is ${STRANGER}, not this host's key ${AGENT}`));
    assert.deepEqual([replaced.offered, replaced.chosen], [[], []]);
  }
  // The key the host was started with is what counts, not what it would like to be.
  assert.equal(decide({ ...game(QUIET), agent: STRANGER }).refuse.code, "agent-replaced");
});

test("a token whose game is off gets nothing", () => {
  for (const activity of [QUIET, HOT, { ...QUIET, ...OVER }]) {
    const decision = decide(game({ ...activity, rules: { ...activity.rules, flags: 0 } }));
    assert.equal(decision.refuse.code, "game-off");
    assert.deepEqual([decision.offered, decision.chosen], [[], []]);
  }
});

test("the host refuses to act on a setup it does not recognise", () => {
  const refusal = (look, config) => {
    const decision = decide(look, config);
    if (decision.refuse) assert.deepEqual([decision.offered, decision.chosen], [[], []]);
    return decision.refuse?.code;
  };
  const base = game(QUIET);
  assert.equal(refusal({ ...base, rules: null }), "rules-missing");
  assert.equal(refusal({ ...base, rules: { ...base.rules, owner: STRANGER } }), "rules-owner");
  assert.equal(refusal({ ...base, rules: { ...base.rules, data: base.rules.data.subarray(0, 120) } }), "rules-version");
  assert.equal(refusal(game({ ...QUIET, rules: { version: 3 } })), "rules-version");
  assert.equal(refusal(game({ ...QUIET, rules: { mint: STRANGER } })), "rules-mint");
  assert.equal(refusal({ ...base, leash: null }), "leash-missing");
  assert.equal(refusal({ ...base, leash: { ...base.leash, owner: SYSTEM } }), "leash-owner");
  assert.equal(refusal(game({ ...QUIET, leash: { version: 2 } })), "leash-version");
  assert.equal(refusal(game({ ...QUIET, leash: { mint: STRANGER } })), "leash-mint");

  // Destination 0 must be the game's rules account, or a feed would go somewhere else.
  assert.equal(refusal(game({ ...QUIET, leash: { dest0: STRANGER } })), "destination");
  assert.equal(refusal(game({ ...QUIET, leash: { dest0: NO_KEY } })), "destination");
  assert.equal(refusal(game({ ...QUIET, leash: { dest0: STRANGER, dest1: RULES_AT } })), "destination", "destination 1 does not count");
  assert.match(decide(game({ leash: { dest0: NO_KEY } })).refuse.message, /destination 0 of the leash is not set/);

  // The dial the hook reads must be the one the host would turn.
  assert.equal(refusal(game({ ...HOT, rules: { leash: STRANGER } })), "dial");
  assert.equal(refusal(game({ ...HOT, rules: { timer_param: 1 } })), "dial", "the leash has one dial");
  assert.equal(refusal(game({ ...HOT, rules: { timer_param: 4 } })), "dial");
  assert.equal(refusal(game(HOT), { clockDial: 1 }), "dial");
  assert.equal(refusal(game(HOT), { clockDial: 0 }), undefined);
  const fixed = { rules: { timer_param: RULES.NO_PARAM, lbw_timer: 600n, leash: NO_KEY } };
  assert.equal(refusal(game({ ...HOT, ...fixed }), { clockDial: 0 }), "dial");
});

test("the hook a mint names is read from its Token-2022 extensions", () => {
  assert.equal(hookOnMint(encodeMint({ hookProgram: HOOK })), HOOK);
  // After other extensions (a 4-byte one of type 3, an empty one of type 7), as on a real mint.
  assert.equal(hookOnMint(encodeMint({ hookProgram: HOOK, before: [[3, [9, 9, 9, 9]], [7, []]] })), HOOK);
  assert.equal(hookOnMint(encodeMint({ hookProgram: NO_KEY })), NO_KEY, "removed: the extension stays, its program id is zeroed");
  assert.equal(hookOnMint(encodeMint({})), null, "no extensions");
  assert.equal(hookOnMint(encodeMint({ before: [[3, [1, 2]]] })), null, "no hook extension");
  assert.equal(hookOnMint(new Uint8Array(82)), null, "a plain SPL mint");
  assert.equal(hookOnMint(new Uint8Array(0)), null);
  const account = encodeMint({ hookProgram: HOOK });
  account[MINT_LAYOUT.TYPE_AT] = 2;
  assert.equal(hookOnMint(account), null, "a token account, not a mint");
  const whole = encodeMint({ hookProgram: HOOK });
  assert.equal(hookOnMint(whole.subarray(0, whole.length - 1)), null, "cut short");
  // Type 0 ends the list: nothing after it counts.
  assert.equal(hookOnMint(encodeMint({ hookProgram: HOOK, before: [[0, []]] })), null);
  // The extension sits where the layout says: type 14, 64 bytes, program id in the second half.
  assert.deepEqual([...whole.subarray(165, 170)], [1, 14, 0, 64, 0]);
  assert.deepEqual([...whole.subarray(202, 234)], new Array(32).fill(20));
});

test("once the hook is off the mint, the host feeds nothing, pays the last winner and stands down", () => {
  // A round is still running: nothing to do but wait for it, however quiet or hot the game looks.
  for (const activity of [QUIET, HOT]) {
    const running = decide(game({ ...activity, ...GRADUATED }));
    assert.equal(running.refuse, null);
    assert.deepEqual([running.offered, running.chosen], [[], []]);
    assert.match(idleLine(running, "feed, clock"), /the hook is no longer on the mint, so this is the last round/);
  }
  // That round ends: its winner is paid like any other.
  const look = game({ ...QUIET, ...OVER, ...GRADUATED });
  const last = decide(look);
  assert.deepEqual(last.chosen, ["settle"]);
  assert.equal(offer(last, "settle").prize, sol(0.12));
  assertSound(look, last);
  // No round open: the game can never move again. The host says so and stops (exit 2 in the runner).
  const waiting = { rules: { lbw_deadline: 0n, lbw_last_buyer: NO_KEY } };
  const done = decide(game({ ...QUIET, ...waiting, ...GRADUATED }));
  assert.equal(done.refuse.code, "hook-gone");
  assert.match(done.refuse.message, /no buy can move the game, so there is nothing left to host; 0.12 SOL stays in the pot/);
  assert.deepEqual([done.offered, done.chosen], [[], []]);
  assert.doesNotMatch(decide(game({ ...QUIET, ...waiting, ...GRADUATED, pot: 0n })).refuse.message, /stays in the pot/);
  // The same for a mint that is missing, is not a Token-2022 mint, or names another hook.
  for (const mintAccount of [null, undefined, { ...HOOKED_MINT, owner: SYSTEM }, { ...HOOKED_MINT, data: encodeMint({ hookProgram: STRANGER }) }, { ...HOOKED_MINT, data: new Uint8Array(82) }]) {
    assert.equal(decide(game({ ...QUIET, ...waiting, mintAccount })).refuse.code, "hook-gone");
    assert.deepEqual(decide(game({ ...QUIET, mintAccount })).offered, []);
  }
  // With the hook in place the same quiet, waiting game is fed.
  assert.ok(offer(decide(game({ ...QUIET, ...waiting })), "feed"));
});

test("a clock fixed at launch is not turned, and the rest of the job goes on", () => {
  const look = game({ ...QUIET, rules: { timer_param: RULES.NO_PARAM, lbw_timer: 600n, leash: NO_KEY } });
  const decision = decide(look);
  assert.equal(decision.refuse, null);
  assert.deepEqual(ids(decision), ["feed"]);
  assert.equal(decision.game.clock, 600n);
  assert.match(idleLine(decision, "clock"), /fixed at launch, there is no dial to turn/);
  assertSound(look, decision);
});

test("without history the host does not guess", () => {
  for (const history of [{ touches: [] }, { touches: [{ signature: "x", time: T0 - 5n, failed: true }] }]) {
    const decision = decide(game({ history }));
    assert.equal(decision.refuse, null);
    assert.deepEqual([decision.offered, decision.chosen], [[], []]);
    assert.match(idleLine(decision, "feed"), /no history/);
    assert.match(idleLine(decision, "clock"), /no history/);
  }
  // A page of 1000 that ends inside the window: at least that many trades. Hot, and said as a floor.
  const touches = Array.from({ length: 1000 }, (_, i) => ({ signature: `s${i}`, time: T0 - BigInt(i % 500), failed: false }));
  const look = game({ history: { touches, own: [], full: true } });
  const busy = decide(look);
  assert.equal(offer(busy, "clock_down").note, "Over 1000 trades in 10 min. Clock down from 15 min to 10 min.");
  assert.deepEqual(busy.chosen, ["clock_down"]);
  assertSound(look, busy);
});

test("a fee payer that cannot pay stops the host before it tries", () => {
  const broke = decide({ ...game(QUIET), payerLamports: 9_999n });
  assert.equal(broke.refuse.code, "fees");
  assert.deepEqual(broke.offered, []);
  assert.equal(decide({ ...game(QUIET), payerLamports: 10_000n }).refuse, null);
  assert.equal(decide({ ...game(QUIET), payerLamports: 19_999n, signatures: 2 }).refuse.code, "fees");
  // With nothing to send there is nothing to pay.
  assert.equal(decide({ ...game({ history: { touches: [] } }), payerLamports: 0n }).refuse, null);
});

test("the config is checked before it is used", () => {
  assert.deepEqual(resolveConfig(), DEFAULT_CONFIG);
  assert.equal(resolveConfig({ quietMinutes: 5 }).quietMinutes, 5);
  assert.throws(() => resolveConfig({ quietMinutess: 5 }), /unknown config key "quietMinutess"/);
  assert.throws(() => resolveConfig({ quietMinutes: 0 }), /quietMinutes/);
  assert.throws(() => resolveConfig({ quietMinutes: "40" }), /quietMinutes/);
  assert.throws(() => resolveConfig({ windowMinutes: 2.5 }), /windowMinutes/);
  assert.throws(() => resolveConfig({ feedSol: -1 }), /feedSol/);
  assert.throws(() => resolveConfig({ feedSol: 0.00001 }), /feedSol must be 0 \(never feed\) or at least 0.0001/);
  assert.throws(() => resolveConfig({ feedSol: NaN }), /feedSol/);
  assert.throws(() => resolveConfig({ hotTrades: 3, coldTrades: 3 }), /coldTrades must be below hotTrades/);
  assert.throws(() => resolveConfig({ clockFloorSeconds: 0 }), /clockFloorSeconds/);
  assert.throws(() => resolveConfig({ clockDial: 4 }), /clockDial/);
  assert.throws(() => decide(game(), { hotTrades: 0 }), /hotTrades/);
});

/* ---------------- Notes ---------------- */

test("numbers and words for the notes", () => {
  const shown = [[0n, "0"], [1n, "0.000000001"], [5_000_000n, "0.005"], [123_456_789n, "0.123"], [129_999_999n, "0.129"], [100_999_999n, "0.1"],
    [1_230_000n, "0.00123"], [999_999_999n, "0.999"], [sol(1), "1"], [sol(1.239), "1.23"], [sol(12.39), "12.3"], [sol(123.9), "123"], [U64_MAX, "18446744073"]];
  for (const [amount, text] of shown) assert.equal(formatSol(amount), text);
  for (const [seconds, text] of [[0n, "0 s"], [59n, "59 s"], [60n, "1 min"], [90n, "90 s"], [900n, "15 min"], [3600n, "1 h"], [5400n, "90 min"], [86_400n, "24 h"]]) assert.equal(formatClock(seconds), text);
  for (const [seconds, text] of [[0n, "0 s"], [59n, "59 s"], [60n, "1 min"], [2759n, "45 min"], [7199n, "119 min"], [7200n, "2 h"], [172_799n, "47 h"], [172_800n, "2 days"]]) assert.equal(formatElapsed(seconds), text);
});

test("a note may only state the move's true numbers", () => {
  const feed = offer(decide(game({ ...QUIET, pot: 123_456_789n, budget: sol(1.9) })), "feed");
  const fine = (note) => assert.equal(checkNote(note, feed), null, note);
  const wrong = (note, why) => assert.match(checkNote(note, feed) ?? "accepted", why, note);
  // The pot goes from 0.123456789 to 0.128456789; 0.005 is added; the last trade was 45 minutes ago.
  fine("Added 0.005 SOL. Pot: 0.128 SOL.");
  fine("Added 0.005 SOL; the pot was 0.123 SOL and is now 0.1285 SOL (round 4).");
  fine("Pot is about 0.13 SOL after 45 minutes of silence.");
  fine("Quiet for 45 min, so 5000000 lamports go in.");
  fine("45min without a bite. 0.005SOL added.");
  fine("Nothing for 2700 seconds. A little bait goes in.");
  fine("The pond is still. Dropping in some bait.");
  wrong("Added 0.006 SOL. Pot: 0.128 SOL.", /the number 0.006 sol is not one of this move's true numbers/);
  wrong("Added 0.005 SOL. Pot: 0.2 SOL.", /0.2 sol/);
  wrong("Added 0.005 SOL. Pot: 0.13 min.", /0.13 min/);
  wrong("Added 45 SOL after a long silence.", /45 sol/);
  wrong("Quiet for 45 h. Added 0.005 SOL.", /45 h/);
  wrong("Quiet for 46 min. Added 0.005 SOL.", /46 min/);
  wrong("Pot up 50% to 0.128 SOL.", /the number 50 is not/);
  wrong("Added 0.005 SOL, 3x the usual.", /the number 3 is not/);
  wrong("Added .5 SOL.", /\.5 sol/);
  wrong("Added 0.0050000000001 SOL.", /too many decimals/);
  wrong("Round 4: pot 0.128/0.25 SOL.", /mixes digits with other characters/);
  wrong("Pot 1e9 lamports.", /mixes digits/);
  wrong("Winner 9xYz..1234 takes it.", /mixes digits/);
  // Cutting a number short is honest with two digits or more, never with one; zero means zero.
  wrong("Budget left: 1 SOL.", /the number 1 sol is not/);
  fine("Budget left: 1.8 SOL."); // 1.895 after the feed
  fine("Budget left: 1.9 SOL.");
  wrong("Pot: 0 SOL.", /the number 0 sol is not/);
  fine("0 trades in 10 min."); // the last trade was 45 minutes ago
  // Shape.
  wrong(42, /not text/);
  wrong("", /empty/);
  wrong(" Added 0.005 SOL.", /padded/);
  wrong("Added 0.005 SOL.\n", /padded/);
  wrong("Added 0.005 SOL.\nPot: 0.128 SOL.", /plain ASCII/);
  wrong(`Added 0.005 SOL ${String.fromCharCode(0x2014)} enjoy.`, /plain ASCII/);
  wrong("Added 0.005 SOL \u{1F3A3}", /plain ASCII/);
  wrong("Added <b>0.005</b> SOL.", /markup/);
  wrong("Added 0.005 SOL. Claim at lure-prizes.com", /link/);
  wrong("Added 0.005 SOL. https://t.me/x", /link/);
  wrong("Added 0.005 SOL. See www.example", /link/);
  wrong("x".repeat(MAX_NOTE + 1), /120 characters, the limit is 119/);
  fine("x".repeat(MAX_NOTE));

  // The winner's address is the one token that may mix letters and digits, short or whole.
  const settle = offer(decide(game(OVER)), "settle");
  const who = `${BUYER.slice(0, 4)}..${BUYER.slice(-4)}`;
  assert.equal(checkNote(`Round 4 goes to ${who}: 0.12 SOL.`, settle), null);
  assert.equal(checkNote(`${BUYER} wins 0.12 SOL.`, settle), null);
  assert.match(checkNote(`Round 4 goes to ${STRANGER.slice(0, 4)}..${STRANGER.slice(-4)}: 0.12 SOL.`, settle), /mixes digits|link/);
  assert.match(checkNote(`Round 5 goes to ${who}.`, settle), /the number 5 is not/);
});

/** A small seeded generator, so a failure can be replayed. */
function random(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.pick = (list) => list[Math.floor(next() * list.length)];
  return next;
}

test("in 4000 random games, every move offered is one the leash allows, with a note that is true and fits", () => {
  const r = random(20261009);
  const amounts = [0n, 1n, 99_999n, 100_000n, 123_456n, 1_000_000n, 4_999_999n, 5_000_000n, 12_345_678n, sol(0.03), sol(0.249), sol(0.25), sol(1), sol(123.456), U64_MAX - RENT.leash];
  const dials = [-600n, 0n, 1n, 30n, 59n, 60n, 61n, 90n, 300n, 600n, 900n, 905n, 3600n, 86_400n, 10n ** 13n, I64_MAX];
  const ages = [0, 5, 60, 300, 599, 600, 601, 2399, 2400, 2401, 5000, 100_000, 1_000_000_000];
  const seen = { feed: 0, clock_down: 0, clock_up: 0, settle: 0, refused: 0, paid: 0, unpaid: 0 };

  for (let i = 0; i < 4000; i++) {
    const [low, value, high] = [r.pick(dials), r.pick(dials), r.pick(dials)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const fixedClock = r() < 0.1;
    const deadline = r.pick([0n, T0 + 1n, T0 + 300n, T0, T0 - 1n, T0 - 5000n]);
    const look = game({
      pot: r.pick(amounts), budget: r.pick(amounts),
      trades: Array.from({ length: Math.floor(r() * 12) }, () => r.pick(ages)),
      ours: Array.from({ length: Math.floor(r() * 3) }, () => r.pick(ages)),
      failed: r() < 0.3 ? [r.pick(ages)] : [],
      full: r() < 0.05,
      rules: {
        lbw_deadline: deadline, lbw_last_buyer: deadline === 0n ? NO_KEY : r.pick([BUYER, STRANGER, NO_KEY, RULES_AT, RULES.SYSVAR_OWNER]),
        lbw_round: r.pick([0n, 3n, 999_999n, U64_MAX]),
        ...(fixedClock ? { timer_param: RULES.NO_PARAM, lbw_timer: 600n, leash: NO_KEY } : {}),
      },
      leash: {
        max_per_spend: r.pick(amounts), max_per_day: r.pick(amounts), spent_today: r.pick(amounts),
        day_start: T0 - r.pick([0n, 3600n, 86_399n, 86_400n, 1_000_000n]),
        ...(r() < 0.03 ? { agent: r.pick([NO_KEY, STRANGER]) } : {}),
      },
      param: { value, min: low, max: high, max_step: r.pick([0n, 1n, 7n, 60n, 300n, 10n ** 12n, U64_MAX]), cooldown: r.pick([0n, 60n, 600n, I64_MAX]), last_change: T0 - r.pick([0n, 59n, 60n, 600n, 10_000n]) },
      winner: { lamports: r.pick([0n, 1n, WALLET_RENT - 1n, WALLET_RENT, sol(1)]), executable: r() < 0.1, owner: r.pick([SYSTEM, SYSTEM, RULES.SYSVAR_OWNER]), rentFloor: WALLET_RENT },
    });
    const config = {
      quietMinutes: r.pick([1, 40]), feedSol: r.pick([0, 0.0001, 0.005, 1.2345]), potCeilingSol: r.pick([0, 0.25, 5]), windowMinutes: r.pick([1, 10, 60]),
      hotTrades: r.pick([1, 8]), coldTrades: 0, clockStepSeconds: r.pick([0, 45, 300]), clockFloorSeconds: r.pick([1, 60, 600]),
    };
    const decision = decide(look, config);
    if (decision.refuse) {
      seen.refused++;
      assert.deepEqual([decision.offered, decision.chosen], [[], []]);
      continue;
    }
    try {
      assertSound(look, decision);
      const kinds = decision.offered.map((move) => move.kind);
      if (decision.game.phase === "over") assert.deepEqual(ids(decision), ["settle"]);
      else assert.ok(!kinds.includes("settle"));
      const leash = decodeLeash(look.leash.data);
      for (const move of decision.offered) {
        seen[move.id]++;
        if (move.kind === "feed") {
          assert.ok(move.amount <= sol(config.feedSol) && move.potAfter <= sol(config.potCeilingSol));
          assert.ok(decision.game.sinceTouch >= BigInt(config.quietMinutes) * 60n);
        }
        if (move.kind === "clock") {
          const param = leash.params[0];
          assert.ok(move.to >= param.min && move.to <= param.max && move.to >= 1n && move.to <= RULES.MAX_TIMER && move.from <= RULES.MAX_TIMER);
          if (move.to < move.from) assert.ok(move.to >= BigInt(config.clockFloorSeconds));
          if (param.max_step !== 0n) assert.ok((move.to > move.from ? move.to - move.from : move.from - move.to) <= param.max_step);
          assert.ok(look.now - param.last_change >= param.cooldown);
        }
        if (move.kind === "settle") {
          assert.ok(move.prize === 0n || move.prize === move.pot);
          seen[move.prize > 0n ? "paid" : "unpaid"]++;
        }
      }
    } catch (error) {
      error.message = `game ${i}: ${error.message}`;
      throw error;
    }
  }
  // The generator really reached every kind of move, many times over.
  for (const [kind, count] of Object.entries(seen)) assert.ok(count >= 40, `only ${count} cases of ${kind}`);
});

/* ---------------- The model's answer ---------------- */

const answer = (...moves) => JSON.stringify({ moves: moves.map(([id, note, extra]) => ({ id, note, ...extra })) });

test("a good answer from the model is taken as it is", () => {
  const decision = decide(game(QUIET)); // offered: feed, clock_down, clock_up; the rules take feed and clock_up
  assert.deepEqual(ids(decision), ["feed", "clock_down", "clock_up"]);
  const result = validateAnswer(answer(
    ["clock_up", "Slow water: no trades in 10 min, so the clock goes from 15 to 20 min."],
    ["feed", "Quiet for 45 min. I dropped 0.005 SOL in; the pot is 0.125 SOL."],
  ), decision);
  assert.equal(result.ok, true);
  // Sent in the host's order whatever order the model wrote them in, and each is the offered move untouched.
  assert.deepEqual(result.moves.map((move) => [move.id, move.wroteNote]), [["feed", "model"], ["clock_up", "model"]]);
  assert.equal(result.moves[0].note, "Quiet for 45 min. I dropped 0.005 SOL in; the pot is 0.125 SOL.");
  assert.equal(result.moves[0].amount, offer(decision, "feed").amount);
  assert.equal(result.moves[1].to, 1200n);
  // The model may go against the thresholds on the clock, or do less, or do nothing.
  assert.deepEqual(validateAnswer(answer(["clock_down", "Tightening up: clock from 15 min to 10 min."]), decision).moves.map((move) => move.to), [600n]);
  assert.deepEqual(validateAnswer('{"moves":[]}', decision), { ok: true, moves: [] });
  // Its fallback, the rules' own choice.
  assert.deepEqual(ruleMoves(decision).map((move) => [move.id, move.wroteNote, move.note]), [
    ["feed", "template", "No bite for 45 min. Added 0.005 SOL: the pot is 0.125 SOL."],
    ["clock_up", "template", "No trades in 10 min. Clock up from 15 min to 20 min."],
  ]);
});

test("anything else from the model is thrown away whole", () => {
  const decision = decide(game(QUIET));
  const good = ["feed", "Quiet for 45 min. Added 0.005 SOL: pot is 0.125 SOL."];
  assert.equal(validateAnswer(answer(good), decision).ok, true);
  const rejects = (text, why) => {
    const result = validateAnswer(text, decision);
    assert.equal(result.ok, false, text);
    assert.equal(result.moves, undefined);
    assert.match(result.reason, why, text);
  };
  // Not the shape that was asked for.
  rejects("I would feed the pot.", /not JSON/);
  rejects("```json\n" + answer(good) + "\n```", /not JSON/);
  rejects("", /not JSON/);
  rejects("null", /not an object/);
  rejects("[]", /not an object/);
  rejects('"feed"', /not an object/);
  rejects("{}", /exactly one field/);
  rejects('{"moves":"feed"}', /exactly one field/);
  rejects(JSON.stringify({ moves: [], transfer: { to: STRANGER, lamports: 1 } }), /exactly one field/);
  rejects('{"moves":["feed"]}', /not an object/);
  rejects('{"moves":[null]}', /not an object/);
  // Not exactly one of the offered moves.
  rejects(answer(["drain", "Sending the budget home."]), /"drain" is not one of the offered moves/);
  rejects(answer(["settle", "Paying the winner 0.12 SOL."]), /"settle" is not one of the offered moves/);
  rejects(answer(["reward", "A gift."]), /not one of the offered moves/);
  rejects(JSON.stringify({ moves: [{ id: 7, note: "x" }] }), /not one of the offered moves/);
  rejects(answer(["feed", good[1], { amount: "1000000000" }]), /anything else would be changing the move/);
  rejects(answer(["feed", good[1], { destination: STRANGER }]), /changing the move/);
  rejects(JSON.stringify({ moves: [{ id: "feed" }] }), /changing the move/);
  rejects(answer(good, good), /"feed" is taken twice/);
  rejects(answer(["clock_down", "Clock to 10 min."], ["clock_up", "Clock to 20 min."]), /turns the clock both ways/);
  rejects(answer(good, ["clock_up", "Clock to 20 min."], ["clock_down", "Clock to 10 min."], good), /more moves than were offered/);
  // A note that can't go on-chain.
  rejects(answer(["feed", 5]), /note for "feed": the note is not text/);
  rejects(answer(["feed", ""]), /empty/);
  rejects(answer(["feed", `Quiet for 45 min. ${"So ".repeat(40)}I added 0.005 SOL.`]), /the limit is 119/);
  rejects(answer(["feed", "Quiet.\nAdded 0.005 SOL."]), /plain ASCII/);
  rejects(answer(["feed", "Added 0.005 SOL \u{1F41F}"]), /plain ASCII/);
  rejects(answer(["feed", "Added 0.005 SOL. Details: lure.example/pot"]), /link/);
  // A number that contradicts the state.
  rejects(answer(["feed", "Quiet for 45 min. Added 0.5 SOL: pot is 0.125 SOL."]), /the number 0.5 sol is not one of this move's true numbers/);
  rejects(answer(["feed", "Quiet for 45 min. Added 0.005 SOL: pot is 12 SOL."]), /12 sol/);
  rejects(answer(["feed", "Quiet for 3 h. Added 0.005 SOL."]), /3 h/);
  rejects(answer(["clock_up", "Clock up from 15 min to 30 min."]), /30 min/);
  rejects(answer(["clock_up", "20 trades in 10 min! Clock up to 20 min."]), /note for "clock_up": the number 20 is not/);
  // One bad note spoils the whole answer, good moves included.
  rejects(answer(good, ["clock_up", "Clock up to 25 min."]), /25 min/);
});

test("the model cannot leave a winner unpaid, or do anything but pay", () => {
  const decision = decide(game({ ...QUIET, ...OVER }));
  const who = `${BUYER.slice(0, 4)}..${BUYER.slice(-4)}`;
  assert.deepEqual(validateAnswer(answer(["settle", `Round 4 is done. ${who} takes the pot of 0.12 SOL.`]), decision).moves.map((move) => move.prize), [sol(0.12)]);
  assert.match(validateAnswer('{"moves":[]}', decision).reason, /"settle" is owed and the answer leaves it out/);
  assert.match(validateAnswer(answer(["feed", "Added 0.005 SOL."]), decision).reason, /"feed" is not one of the offered moves/);
  assert.match(validateAnswer(answer(["settle", `Round 4 is done. ${who} takes 1.2 SOL.`]), decision).reason, /1.2 sol/);
  assert.equal(ruleMoves(decision)[0].note, `Round 4 is over. ${who} bought last and wins the pot: 0.12 SOL.`);
});

test("the model is shown the game and the offers, and nothing a stranger wrote", () => {
  const decision = decide(game(QUIET));
  const { system, user } = buildPrompt(decision);
  const shown = JSON.parse(user);
  assert.deepEqual(shown.offered.map((move) => move.id), ["feed", "clock_down", "clock_up"]);
  assert.deepEqual(shown.offered.map((move) => move.the_rules_would_take_it), [true, false, true]);
  assert.equal(shown.game.pot, "0.12 SOL");
  assert.equal(shown.game.phase, "running, 6 min left on the clock");
  assert.ok(shown.offered[0].numbers_you_may_use.includes("0.005 SOL (added to the pot)"));
  assert.equal(shown.offered[0].example_note, offer(decision, "feed").note);
  assert.doesNotMatch(system + user, /undefined|NaN|\[object/);
  assert.match(system, /at most 119 characters/);
  // The schema names exactly the ids the host knows.
  assert.deepEqual(ANSWER_SCHEMA.properties.moves.items.properties.id.enum, ["settle", "feed", "clock_down", "clock_up"]);
  assert.equal(ANSWER_SCHEMA.additionalProperties, false);
  const over = JSON.parse(buildPrompt(decide(game(OVER))).user);
  assert.deepEqual(over.offered.map((move) => [move.id, move.required]), [["settle", true]]);
  assert.equal(over.offered[0].names_you_may_use[0], `${BUYER.slice(0, 4)}..${BUYER.slice(-4)}`);
});

/* ---------------- After the simulation ---------------- */

test("a simulated outcome that differs from the note stops the send", () => {
  const look = game(QUIET);
  const before = { rules: decodeRules(look.rules.data), rulesLamports: look.rules.lamports, leash: decodeLeash(look.leash.data) };
  const decision = decide(look);
  const feed = offer(decision, "feed");
  const fed = { ...before, rulesLamports: before.rulesLamports + feed.amount, leash: { ...before.leash, total_spent: before.leash.total_spent + feed.amount } };
  assert.equal(checkOutcome(feed, before, fed), null);
  assert.match(checkOutcome(feed, before, before), /the pot would grow by 0 lamports, the note says 5000000/);
  assert.match(checkOutcome(feed, before, { ...fed, rulesLamports: fed.rulesLamports + 1n }), /the pot would grow by 5000001/);
  assert.match(checkOutcome(feed, before, { ...fed, leash: before.leash }), /the leash would not count/);

  const up = offer(decision, "clock_up");
  const turned = { ...before, leash: { ...before.leash, params: [{ ...before.leash.params[0], value: 1200n }] } };
  assert.equal(checkOutcome(up, before, turned), null);
  assert.match(checkOutcome(up, before, before), /the dial would read 900, the note says 1200/);

  const overLook = game(OVER);
  const settle = offer(decide(overLook), "settle");
  const start = { rules: decodeRules(overLook.rules.data), rulesLamports: overLook.rules.lamports, leash: decodeLeash(overLook.leash.data) };
  const paid = { ...start, rules: { ...start.rules, lbw_round: 4n, lbw_last_winner: BUYER, lbw_last_prize: sol(0.12) } };
  assert.equal(checkOutcome(settle, start, paid), null);
  assert.match(checkOutcome(settle, start, start), /the round would not close/);
  assert.match(checkOutcome(settle, start, { ...paid, rules: { ...paid.rules, lbw_last_prize: 0n } }), /the prize would be 0 lamports, the note says 120000000/);
  assert.match(checkOutcome(settle, start, { ...paid, rules: { ...paid.rules, lbw_last_winner: STRANGER } }), /the winner on record would be/);
  assert.match(checkOutcome({ kind: "sweep" }, start, paid), /unknown kind of move/);
});

/* ==========================================================================================
 * THE RUNNER, against a chain made of plain objects. The "programs" on that chain are the
 * mirrored checks from host-policy.mjs, so these tests are about the runner's own conduct:
 * what it reads, that a dry run sends nothing, the order of its transactions, when it stops.
 * ======================================================================================== */

const web3 = await import("@solana/web3.js").catch(() => null);
const runner = web3 && (await import("./host-agent.mjs"));
const noRunner = !runner && "@solana/web3.js is not installed here (run npm install)";
const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const agentPair = web3?.Keypair.generate();
const AGENT_KEY = agentPair?.publicKey.toBase58();
/** The made-up game again, with a leash that names a key this test can sign with. */
const played = (extra = {}) => game({ ...extra, leash: { agent: AGENT_KEY, ...extra.leash } });

/** A cluster in memory: answers the runner's RPC calls and applies its transactions. */
function fakeChain(seed, { winner = { lamports: sol(1), executable: false, owner: SYSTEM, space: 0 } } = {}) {
  const chain = {
    now: seed.now, rules: decodeRules(seed.rules.data), rulesLamports: seed.rules.lamports,
    leash: decodeLeash(seed.leash.data), leashLamports: seed.leash.lamports, winnerLamports: winner.lamports,
    rows: seed.history.touches.map((t) => ({ signature: t.signature, blockTime: Number(t.time), err: t.failed ? { InstructionError: [0, "Custom"] } : null })),
    own: [...seed.history.own], payerLamports: sol(1), sent: [], methods: [], simulations: 0, beforeSimulate: null,
  };
  const shape = (owner, amount, data) => ({ owner, lamports: Number(amount), executable: false, rentEpoch: 0, space: data.length, data: [Buffer.from(data).toString("base64"), "base64"] });
  const rulesAccount = (state) => shape(HOOK, state.rulesLamports, encodeRules(state.rules));
  const leashAccount = (state) => shape(LEASH_PROGRAM, state.leashLamports, encodeLeash(state.leash));
  const custom = (code) => ({ err: { InstructionError: [0, { Custom: code }] } });

  /** What the transaction would do to the chain: { err } or the state after it. */
  function apply(wire, sigVerify) {
    const tx = web3.Transaction.from(Buffer.from(wire, "base64"));
    if (sigVerify && !tx.verifySignatures()) return { err: "SignatureFailure" };
    assert.equal(tx.instructions.length, 2, "one move and its memo");
    const [action, memo] = tx.instructions;
    assert.equal(memo.programId.toBase58(), MEMO);
    assert.deepEqual(memo.keys.map((k) => [k.pubkey.toBase58(), k.isSigner]), [[AGENT_KEY, true]], "the agent signs the memo");
    const keys = action.keys.map((k) => k.pubkey.toBase58());
    // Once compiled, an account has one set of flags for the whole transaction, and the fee
    // payer is always writable: so only "signs" is told for the payer, "writable" for the rest.
    const flags = action.keys.map((k) => (k.pubkey.equals(tx.feePayer) ? (k.isSigner ? "s" : "-") : `${k.isSigner ? "s" : "-"}${k.isWritable ? "w" : "-"}`)).join(" ");
    const view = new DataView(action.data.buffer, action.data.byteOffset, action.data.byteLength);
    const next = structuredClone({ rules: chain.rules, rulesLamports: chain.rulesLamports, leash: chain.leash, leashLamports: chain.leashLamports, winnerLamports: chain.winnerLamports });
    const done = (kind) => ({ err: null, next, kind, memo: memo.data.toString("utf8"), payer: tx.feePayer.toBase58() });

    if (action.programId.toBase58() === LEASH_PROGRAM && action.data[0] === LEASH.SPEND_TAG) {
      assert.deepEqual([keys[0], keys[1], flags, action.data.length], [AGENT_KEY, LEASH_AT, "s -w -w", 10]);
      const amount = view.getBigUint64(2, true);
      const refusal = spendRefusal(chain.leash, { signer: keys[0], leashAddress: keys[1], index: action.data[1], destination: keys[2], amount, now: chain.now, budget: chain.leashLamports - RENT.leash });
      if (refusal) return custom(LEASH.ERRORS.indexOf(refusal));
      const newDay = chain.now - chain.leash.day_start >= LEASH.DAY;
      Object.assign(next.leash, { spent_today: (newDay ? 0n : chain.leash.spent_today) + amount, total_spent: chain.leash.total_spent + amount, day_start: newDay ? chain.now : chain.leash.day_start });
      next.leashLamports -= amount;
      if (keys[2] === RULES_AT) next.rulesLamports += amount;
      return done("feed");
    }
    if (action.programId.toBase58() === LEASH_PROGRAM && action.data[0] === LEASH.SET_PARAM_TAG) {
      assert.deepEqual([keys[0], keys[1], flags, action.data.length], [AGENT_KEY, LEASH_AT, "s -w", 10]);
      const value = view.getBigInt64(2, true);
      const refusal = setParamRefusal(chain.leash, { signer: keys[0], index: action.data[1], value, now: chain.now });
      if (refusal) return custom(LEASH.ERRORS.indexOf(refusal));
      Object.assign(next.leash.params[action.data[1]], { value, last_change: chain.now });
      return done("clock");
    }
    assert.equal(action.programId.toBase58(), HOOK);
    assert.deepEqual([keys[0], flags, [...action.data]], [RULES_AT, "-w -w", [1]]);
    const pot = chain.rulesLamports - RENT.rules;
    const outcome = settleOutcome(chain.rules, { now: chain.now, winner: keys[1], rulesAddress: keys[0], pot, payee: { lamports: chain.winnerLamports, executable: winner.executable, owner: winner.owner, rentFloor: WALLET_RENT } });
    if (outcome.refusal) return custom(Number(Object.entries(RULES.ERRORS).find(([, name]) => name === outcome.refusal)[0]));
    Object.assign(next.rules, { lbw_round: chain.rules.lbw_round + 1n, lbw_last_winner: keys[1], lbw_last_prize: outcome.prize, lbw_total_paid: chain.rules.lbw_total_paid + outcome.prize, lbw_last_buyer: NO_KEY, lbw_deadline: 0n });
    next.rulesLamports -= outcome.prize;
    next.winnerLamports += outcome.prize;
    return done("settle");
  }

  const answer = {
    getMultipleAccounts: ([addresses]) => ({ context: { slot: 1 }, value: addresses.map((address) => (
      address === RULES_AT ? rulesAccount(chain)
        : address === LEASH_AT ? leashAccount(chain)
        : address === "SysvarC1ock11111111111111111111111111111111" ? shape(RULES.SYSVAR_OWNER, 1_169_280n, (() => { const d = new Uint8Array(40); new DataView(d.buffer).setBigInt64(32, chain.now, true); return d; })())
        : address === AGENT_KEY ? shape(SYSTEM, chain.payerLamports, new Uint8Array(0))
        : address === MINT ? shape(MINT_LAYOUT.TOKEN_2022, 3_000_000n, encodeMint({ hookProgram: chain.graduated ? NO_KEY : HOOK })) : null)) }),
    getSignaturesForAddress: ([address]) => (address === RULES_AT ? chain.rows : chain.rows.filter((row) => chain.own.includes(row.signature))),
    getMinimumBalanceForRentExemption: ([size]) => Number(size === RULES.LEN ? RENT.rules : size === LEASH.LEN ? RENT.leash : WALLET_RENT),
    getAccountInfo: ([address]) => ({ context: { slot: 1 }, value: address === BUYER ? { ...shape(winner.owner, chain.winnerLamports, new Uint8Array(0)), executable: winner.executable, space: winner.space } : null }),
    getLatestBlockhash: () => ({ context: { slot: 1 }, value: { blockhash: key(77), lastValidBlockHeight: 500 } }),
    getBlockHeight: () => 400,
    getSignatureStatuses: ([[signature]]) => {
      if (chain.deaf) throw new Error("getSignatureStatuses: the node went away");
      return { context: { slot: 1 }, value: [chain.sent.some((tx) => tx.signature === signature) ? { confirmationStatus: "confirmed", err: null } : null] };
    },
    simulateTransaction: ([wire, options]) => {
      chain.simulations++;
      chain.beforeSimulate?.(chain);
      assert.equal(options.replaceRecentBlockhash, !options.sigVerify, "blockhash replaced only when signatures are not checked");
      const result = apply(wire, options.sigVerify);
      return { context: { slot: 1 }, value: { err: result.err, logs: [], unitsConsumed: 1234, accounts: result.err || chain.hideAccounts ? null : [rulesAccount(result.next), leashAccount(result.next)] } };
    },
    sendTransaction: ([wire]) => {
      const result = apply(wire, true);
      if (result.err) throw Object.assign(new Error("Transaction simulation failed"), { rpcError: { code: -32002 } });
      const signature = `sent${chain.sent.length}`;
      Object.assign(chain, result.next);
      chain.sent.push({ signature, kind: result.kind, memo: result.memo, payer: result.payer });
      // The transaction names the rules account (feed, settle) and always the agent.
      if (result.kind !== "clock") chain.rows.unshift({ signature, blockTime: Number(chain.now), err: null });
      chain.own.push(signature);
      return signature;
    },
  };
  chain.rpc = async (calls) => calls.map(([method, params]) => {
    chain.methods.push(method);
    return answer[method](params);
  });
  return chain;
}

function hostOn(chain, { send = false, ai = null, fetch: fetchNow, config } = {}) {
  const lines = [];
  const { PublicKey } = web3;
  const context = {
    rpc: chain.rpc, log: (tag, text) => lines.push(`${tag} ${text}`), config: resolveConfig(config), send, signers: send ? [agentPair] : [],
    agent: agentPair.publicKey, payer: agentPair.publicKey, mint: new PublicKey(MINT), hookProgram: new PublicKey(HOOK), leashProgram: new PublicKey(LEASH_PROGRAM),
    rulesAddress: new PublicKey(RULES_AT), leashAddress: new PublicKey(LEASH_AT), ai, fetch: fetchNow, pause: async () => {},
  };
  return { lines, run: () => runner.lookOnce(context), tagged: (tag) => lines.filter((line) => line.startsWith(tag)) };
}

test("runner: a dry run simulates every move and sends nothing", { skip: noRunner }, async () => {
  const chain = fakeChain(played(QUIET));
  const host = hostOn(chain);
  assert.equal(await host.run(), runner.EXIT.ok);
  assert.equal(chain.simulations, 2);
  assert.deepEqual(chain.sent, []);
  assert.ok(!chain.methods.includes("sendTransaction") && !chain.methods.includes("getLatestBlockhash"));
  // One request to read the game, then one per simulation.
  assert.deepEqual(chain.methods, ["getMultipleAccounts", "getSignaturesForAddress", "getSignaturesForAddress", "getMinimumBalanceForRentExemption", "getMinimumBalanceForRentExemption", "simulateTransaction", "simulateTransaction"]);
  assert.match(host.tagged("LOOK")[0], /round 4 running, 6 min left, .* leads \| pot 0.12 SOL \| clock 15 min \(dial 0\) \| 0 trades in 10 min, last 45 min ago \| budget 0.05 SOL, 0.03 left today/);
  assert.match(host.tagged("DRY")[0], /feed: would send, simulation passed \(1234 units\) .* note \(template\): "No bite for 45 min. Added 0.005 SOL: the pot is 0.125 SOL."/);
  assert.match(host.tagged("DRY")[1], /clock_up: would send.*"No trades in 10 min. Clock up from 15 min to 20 min."/);
  assert.equal(chain.rulesLamports, RENT.rules + sol(0.12), "nothing changed");
});

test("runner: with --send it feeds, then turns the clock, each with its note", { skip: noRunner }, async () => {
  const chain = fakeChain(played(QUIET));
  const host = hostOn(chain, { send: true });
  assert.equal(await host.run(), runner.EXIT.ok);
  assert.deepEqual(chain.sent.map((tx) => [tx.kind, tx.memo, tx.payer]), [
    ["feed", "No bite for 45 min. Added 0.005 SOL: the pot is 0.125 SOL.", AGENT_KEY],
    ["clock", "No trades in 10 min. Clock up from 15 min to 20 min.", AGENT_KEY],
  ]);
  assert.equal(chain.rulesLamports, RENT.rules + sol(0.125));
  assert.equal(chain.leashLamports, RENT.leash + sol(0.045));
  assert.equal(chain.leash.params[0].value, 1200n);
  // Every send was simulated first, with its signatures checked.
  assert.equal(chain.simulations, 2);
  assert.equal(host.tagged("SENT").length, 2);
  assert.match(host.tagged("SENT")[0], /feed: adds 0.005 SOL from the budget to the pot, which becomes 0.125 SOL \| sent0 \|/);

  // The next look finds the game just touched and the dial cooling down: nothing to do.
  const again = hostOn(chain, { send: true });
  assert.equal(await again.run(), runner.EXIT.ok);
  assert.equal(chain.sent.length, 2);
  assert.match(again.tagged("IDLE")[0], /feed: not quiet, the last transaction was 0 s ago .* clock: cooling down/);
});

test("runner: a finished round is paid first, then the host looks again", { skip: noRunner }, async () => {
  const chain = fakeChain(played({ ...QUIET, ...OVER }));
  const host = hostOn(chain, { send: true });
  assert.equal(await host.run(), runner.EXIT.ok);
  const who = `${BUYER.slice(0, 4)}..${BUYER.slice(-4)}`;
  // The payout lands; on the second look the game was touched a moment ago (no feed) and is cold (clock up).
  assert.deepEqual(chain.sent.map((tx) => [tx.kind, tx.memo]), [
    ["settle", `Round 4 is over. ${who} bought last and wins the pot: 0.12 SOL.`],
    ["clock", "No trades in 10 min. Clock up from 15 min to 20 min."],
  ]);
  assert.equal(chain.winnerLamports, sol(1) + sol(0.12));
  assert.equal(chain.rulesLamports, RENT.rules);
  assert.deepEqual([chain.rules.lbw_round, chain.rules.lbw_deadline, chain.rules.lbw_last_winner], [4n, 0n, BUYER]);
  assert.equal(host.tagged("LOOK").length, 2);
  assert.match(host.tagged("LOOK")[0], /round 4 over, .* unpaid/);
  assert.match(host.tagged("LOOK")[1], /round 5 waiting for its first buy \| pot 0 SOL/);
  assert.ok(chain.methods.includes("getAccountInfo"), "it read the winner's account before paying");

  // In a dry run it shows the payout and stops there.
  const dry = fakeChain(played({ ...QUIET, ...OVER }));
  const rehearsal = hostOn(dry);
  assert.equal(await rehearsal.run(), runner.EXIT.ok);
  assert.equal(rehearsal.tagged("DRY").length, 1);
  assert.match(rehearsal.tagged("DRY")[0], /settle: would send/);
  assert.deepEqual(dry.sent, []);
});

test("runner: a winner that cannot be paid still gets its round closed, and the note says so", { skip: noRunner }, async () => {
  const chain = fakeChain(played({ ...OVER, pot: 500_000n }), { winner: { lamports: 0n, executable: false, owner: SYSTEM, space: 0 } });
  const host = hostOn(chain, { send: true });
  assert.equal(await host.run(), runner.EXIT.ok);
  assert.match(chain.sent[0].memo, /bought last but cannot be paid: the pot, 0.0005 SOL, rolls over\./);
  assert.deepEqual([chain.rules.lbw_round, chain.rules.lbw_last_prize, chain.rulesLamports], [4n, 0n, RENT.rules + 500_000n]);
});

test("runner: after graduation it pays the last winner, then exits 2 for good", { skip: noRunner }, async () => {
  const chain = fakeChain(played({ ...QUIET, rules: { lbw_deadline: T0 + 60n } }));
  chain.graduated = true;
  // The last round is still running: wait, send nothing, even though the game is quiet and cold.
  const waiting = hostOn(chain, { send: true });
  assert.equal(await waiting.run(), runner.EXIT.ok);
  assert.match(waiting.tagged("IDLE")[0], /the hook is no longer on the mint, so this is the last round/);
  assert.deepEqual([chain.sent.length, chain.simulations], [0, 0]);
  // It ends: pay, look again, and find there is nothing left to host.
  chain.now += 60n;
  const last = hostOn(chain, { send: true });
  assert.equal(await last.run(), runner.EXIT.refused);
  assert.deepEqual(chain.sent.map((tx) => tx.kind), ["settle"]);
  assert.equal(chain.winnerLamports, sol(1) + sol(0.12));
  assert.match(last.lines.at(-1), /^REFUSE hook-gone: the hook is not on mint/);
  assert.equal(chain.leashLamports, RENT.leash + sol(0.05), "not a lamport of the budget was fed to a pot nobody can win");
});

test("runner: it refuses to act and exits 2 without simulating anything", { skip: noRunner }, async () => {
  for (const [extra, code] of [[{ leash: { agent: NO_KEY } }, "agent-revoked"], [{ leash: { agent: STRANGER } }, "agent-replaced"], [{ rules: { flags: 0 } }, "game-off"], [{ leash: { dest0: STRANGER } }, "destination"], [{ rules: { timer_param: 2 } }, "dial"]]) {
    const chain = fakeChain(played({ ...QUIET, ...extra, leash: { agent: AGENT_KEY, ...extra.leash } }));
    const host = hostOn(chain, { send: true });
    assert.equal(await host.run(), runner.EXIT.refused, code);
    assert.match(host.lines.at(-1), new RegExp(`^REFUSE ${code}: `));
    assert.equal(chain.simulations, 0);
    assert.deepEqual(chain.sent, []);
  }
});

test("runner: when the cluster would refuse a move, nothing is sent and the exit code says so", { skip: noRunner }, async () => {
  // Between the look and the simulation another process spends the day's cap.
  const chain = fakeChain(played(QUIET));
  chain.beforeSimulate = (state) => { state.leash.spent_today = sol(0.03); };
  const host = hostOn(chain, { send: true });
  assert.equal(await host.run(), runner.EXIT.failed);
  assert.deepEqual(chain.sent, []);
  assert.match(host.tagged("FAIL")[0], /feed: the cluster would refuse it: OverDailyCap; nothing was sent/);
  assert.equal(host.tagged("SENT").length, 0, "and it does not go on to the clock on a stale look");

  // A donation lands in the pot after the look: the note's "the pot is" would be wrong, so it waits.
  const moved = fakeChain(played(QUIET));
  moved.beforeSimulate = (state) => { state.rulesLamports = RENT.rules + sol(0.5); state.beforeSimulate = null; };
  const hostMoved = hostOn(moved, { send: true });
  assert.equal(await hostMoved.run(), runner.EXIT.failed);
  assert.match(hostMoved.tagged("FAIL")[0], /feed: it would not do what its note says .* the game moved since the look/);
  assert.deepEqual(moved.sent, []);

  // The same in a dry run: reported, exit 3, and the other move is still shown.
  const dry = fakeChain(played(QUIET));
  dry.beforeSimulate = (state) => { state.leash.spent_today = sol(0.03); };
  const rehearsal = hostOn(dry);
  assert.equal(await rehearsal.run(), runner.EXIT.failed);
  assert.equal(rehearsal.tagged("FAIL").length, 1);
  assert.equal(rehearsal.tagged("DRY").length, 1);
});

test("runner: what it cannot check it does not send, and what it cannot confirm it reports with the signature", { skip: noRunner }, async () => {
  // A node that simulates but does not hand back the accounts: the note can't be checked against the outcome.
  const blind = fakeChain(played(QUIET));
  blind.hideAccounts = true;
  const hostBlind = hostOn(blind, { send: true });
  assert.equal(await hostBlind.run(), runner.EXIT.failed);
  assert.match(hostBlind.tagged("FAIL")[0], /feed: the RPC node did not return the accounts after the simulation, so the outcome can't be checked; nothing was sent/);
  assert.deepEqual(blind.sent, []);

  // The node takes the transaction and then goes quiet: say so, with the signature, and stop.
  const deaf = fakeChain(played(QUIET));
  deaf.deaf = true;
  const hostDeaf = hostOn(deaf, { send: true });
  assert.equal(await hostDeaf.run(), runner.EXIT.failed);
  assert.match(hostDeaf.tagged("FAIL")[0], /feed: it was sent, but the node stopped answering before it confirmed .* the next look will see whether it landed \| sent0 \|/);
  assert.deepEqual(deaf.sent.map((tx) => tx.kind), ["feed"], "the feed went out once; the clock move was left for the next look");
  // That next look reads the chain, finds the feed landed, and does not feed twice.
  deaf.deaf = false;
  const after = hostOn(deaf, { send: true });
  assert.equal(await after.run(), runner.EXIT.ok);
  assert.deepEqual(deaf.sent.map((tx) => tx.kind), ["feed", "clock"]);
  assert.equal(deaf.rulesLamports, RENT.rules + sol(0.125));
});

test("runner: the transactions are built the way the programs parse them", { skip: noRunner }, () => {
  const { PublicKey } = web3;
  const context = { agent: agentPair.publicKey, hookProgram: new PublicKey(HOOK), leashProgram: new PublicKey(LEASH_PROGRAM), rulesAddress: new PublicKey(RULES_AT), leashAddress: new PublicKey(LEASH_AT) };
  const seen = (move) => runner.instructionsFor({ note: "Why.", ...move }, context).map((ix) => [ix.programId.toBase58(), ix.keys.map((k) => `${k.pubkey.toBase58()}:${k.isSigner ? "s" : "-"}${k.isWritable ? "w" : "-"}`), [...ix.data]]);
  const memo = [MEMO, [`${AGENT_KEY}:s-`], [...Buffer.from("Why.")]];
  // leash spend: tag 1; [agent signer, leash writable, destination writable]; index u8, amount u64.
  assert.deepEqual(seen({ kind: "feed", index: 0, amount: 5_000_000n }), [[LEASH_PROGRAM, [`${AGENT_KEY}:s-`, `${LEASH_AT}:-w`, `${RULES_AT}:-w`], [1, 0, 0x40, 0x4b, 0x4c, 0, 0, 0, 0, 0]], memo]);
  // leash set_param: tag 3; [agent signer, leash writable]; dial u8, value i64.
  assert.deepEqual(seen({ kind: "clock", dial: 2, to: 600n }), [[LEASH_PROGRAM, [`${AGENT_KEY}:s-`, `${LEASH_AT}:-w`], [3, 2, 0x58, 0x02, 0, 0, 0, 0, 0, 0]], memo]);
  // hook settle: tag 1; [rules writable, winner writable].
  assert.deepEqual(seen({ kind: "settle", winner: BUYER }), [[HOOK, [`${RULES_AT}:-w`, `${BUYER}:-w`], [1]], memo]);
});

/** A stand-in for the Anthropic API: records the request, answers with `reply`. */
function fakeModel(reply) {
  const requests = [];
  const fetchNow = async (url, init) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const { status = 200, ...body } = typeof reply === "string" ? { stop_reason: "end_turn", content: [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: reply }] } : reply;
    return new Response(JSON.stringify(body), { status });
  };
  return { requests, fetch: fetchNow };
}

test("runner: a good answer from the model decides the moves and words the notes", { skip: noRunner }, async () => {
  const chain = fakeChain(played(QUIET));
  const model = fakeModel(answer(["feed", "Still water for 45 min. Dropped 0.005 SOL in: the pot is 0.125 SOL."]));
  const host = hostOn(chain, { send: true, ai: { key: "sk-test-not-a-real-key", model: "claude-haiku-5-5" }, fetch: model.fetch });
  assert.equal(await host.run(), runner.EXIT.ok);
  // The model took the feed and left the clock alone; the note on-chain is the model's.
  assert.deepEqual(chain.sent.map((tx) => [tx.kind, tx.memo]), [["feed", "Still water for 45 min. Dropped 0.005 SOL in: the pot is 0.125 SOL."]]);
  assert.match(host.tagged("MODEL")[0], /took feed of feed, clock_down, clock_up/);
  assert.match(host.tagged("SENT")[0], /note \(model\)/);

  // What was sent to the API: the Messages endpoint, the model asked for, a small cap, no sampling knobs.
  const [request] = model.requests;
  assert.equal(request.url, "https://api.anthropic.com/v1/messages");
  assert.deepEqual(request.headers, { "content-type": "application/json", "x-api-key": "sk-test-not-a-real-key", "anthropic-version": "2023-06-01" });
  assert.equal(request.body.model, "claude-haiku-5-5");
  assert.ok(request.body.max_tokens <= 1024);
  assert.deepEqual(Object.keys(request.body).sort(), ["max_tokens", "messages", "model", "output_config", "system", "thinking"]);
  assert.deepEqual(request.body.output_config.format, { type: "json_schema", schema: ANSWER_SCHEMA });
  assert.deepEqual(request.body.messages.map((message) => message.role), ["user"]);
  assert.deepEqual(JSON.parse(request.body.messages[0].content).offered.map((move) => move.id), ["feed", "clock_down", "clock_up"]);
  // The key goes to the API and nowhere else.
  assert.doesNotMatch(host.lines.join("\n") + JSON.stringify(request.body), /sk-test/);
});

test("runner: a bad answer, a refusal or an outage from the model falls back to the rules", { skip: noRunner }, async () => {
  const fallbacks = [
    [answer(["feed", "Added 5 SOL to the pot!"]), /answer thrown away \(note for "feed": the number 5 sol is not one of this move's true numbers\); the rules decide/],
    [answer(["sweep", "Taking the budget home."]), /answer thrown away \("sweep" is not one of the offered moves\)/],
    ["Sure! I would feed the pot.", /answer thrown away \(the answer is not JSON\)/],
    [{ stop_reason: "refusal", content: [] }, /no usable answer \(it stopped with "refusal"\); the rules decide/],
    [{ stop_reason: "max_tokens", content: [{ type: "text", text: '{"moves":[' }] }, /it stopped with "max_tokens"/],
    [{ status: 401, type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, /no usable answer \(HTTP 401 authentication_error\)/],
    [{ status: 529, type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, /HTTP 529 overloaded_error/],
  ];
  for (const [reply, logged] of fallbacks) {
    const chain = fakeChain(played(QUIET));
    const host = hostOn(chain, { send: true, ai: { key: "sk-test-not-a-real-key", model: "claude-haiku-5-5" }, fetch: fakeModel(reply).fetch });
    assert.equal(await host.run(), runner.EXIT.ok);
    assert.match(host.tagged("MODEL")[0], logged);
    assert.deepEqual(chain.sent.map((tx) => tx.memo), ["No bite for 45 min. Added 0.005 SOL: the pot is 0.125 SOL.", "No trades in 10 min. Clock up from 15 min to 20 min."]);
  }
  // A network failure is the same story.
  const chain = fakeChain(played(QUIET));
  const host = hostOn(chain, { ai: { key: "k", model: "m" }, fetch: async () => { throw new TypeError("fetch failed"); } });
  assert.equal(await host.run(), runner.EXIT.ok);
  assert.match(host.tagged("MODEL")[0], /no usable answer \(fetch failed\)/);
  assert.equal(host.tagged("DRY").length, 2);
  // And with nothing on the table the model is not even asked.
  const idle = fakeModel('{"moves":[]}');
  const quietChain = fakeChain(played({ history: { touches: [], own: [] } }));
  await hostOn(quietChain, { ai: { key: "k", model: "m" }, fetch: idle.fetch }).run();
  assert.equal(idle.requests.length, 0);
});

test("runner: RPC calls go out as one batch, and a rate limit is waited out", { skip: noRunner }, async () => {
  const waits = [];
  const posts = [];
  const replies = [
    () => new Response("slow down", { status: 429, headers: { "retry-after": "2" } }),
    () => new Response("slow down", { status: 429 }),
    (body) => new Response(JSON.stringify([...body].reverse().map((call) => (call.method === "getSlot" ? { id: call.id, result: 7 } : { id: call.id, result: "ok" })))),
  ];
  const rpc = runner.createRpc("https://rpc.invalid", { fetch: async (url, init) => { posts.push(JSON.parse(init.body)); return replies[posts.length - 1](JSON.parse(init.body)); }, pause: async (ms) => waits.push(ms) });
  // Answers come back in any order; the caller gets them in the order it asked.
  assert.deepEqual(await rpc([["getHealth", []], ["getSlot", []]]), ["ok", 7]);
  assert.equal(posts.length, 3);
  assert.deepEqual(posts[0].map((call) => call.method), ["getHealth", "getSlot"]);
  assert.deepEqual(waits, [2000, 1000], "the server's retry-after, then a doubling pause");

  const failing = runner.createRpc("https://rpc.invalid", { fetch: async (url, init) => new Response(JSON.stringify({ id: JSON.parse(init.body).id, error: { code: -32602, message: "Invalid param:\n WrongSize" } })), pause: async () => {} });
  await assert.rejects(failing([["getAccountInfo", ["x"]]]), /^Error: getAccountInfo: Invalid param: WrongSize$/);
  const down = runner.createRpc("https://rpc.invalid", { fetch: async () => new Response("", { status: 503 }), pause: async () => {}, retries: 2 });
  await assert.rejects(down([["getHealth", []]]), /answered HTTP 503 3 times in a row/);
  const offline = runner.createRpc("https://rpc.invalid", { fetch: async () => { throw new TypeError("fetch failed"); }, pause: async () => {}, retries: 1 });
  await assert.rejects(offline([["getHealth", []]]), /cannot be reached/);
});

test("runner: the environment is checked before anything is read, and a key file is never echoed", { skip: noRunner }, () => {
  // A real pair from devnet: this mint and creator own this leash and this rules account.
  const env = { MINT: "8z3zAk2RJeQrucEVtecnerDh7s5d4sHFENM7zoXZ8cXS", CREATOR: "7f2MiAuyJ1Aaiheo9ctLgJmzGDWoDceyHEEuVB2mhPAA", AGENT: "9oP9bkeER3UpVau2zZDxCkeCcVTyqX4GMwARdPAFkpEb" };
  const context = runner.configure(env, []);
  assert.equal(context.leashAddress.toBase58(), "GoxprQWYcbLegymW1z2o3uhYr3nyuXSWDBEs7mmzrhDG");
  assert.equal(context.rulesAddress.toBase58(), "FFsBRhkiVzaXmK9F3ZaJ87ahLzbuCUbNGkQdyJRL3G9m");
  assert.deepEqual([context.send, context.every, context.signers, context.ai, context.payer.toBase58()], [false, null, [], null, env.AGENT]);
  assert.deepEqual(context.config, DEFAULT_CONFIG);
  assert.equal(runner.configure(env, ["--every", "60"]).every, 60);
  assert.deepEqual(runner.configure({ ...env, ANTHROPIC_API_KEY: "k" }, ["--once"]).ai, { key: "k", model: "claude-haiku-5-5" });
  assert.equal(runner.configure({ ...env, FEE_PAYER: env.CREATOR }, []).payer.toBase58(), env.CREATOR);

  const refused = (changes, args, why) => assert.throws(() => runner.configure({ ...env, ...changes }, args), why);
  refused({ MINT: undefined }, [], /MINT is not set/);
  refused({ MINT: "not-an-address" }, [], /MINT is not a Solana address/);
  refused({ AGENT: undefined }, [], /set AGENT_KEYPAIR \(a keypair file\), or AGENT \(an address\)/);
  refused({}, ["--send"], /--send needs AGENT_KEYPAIR/);
  refused({}, ["--every", "1"], /--every needs a number of seconds, 5 or more/);
  refused({}, ["--yolo"], /unknown argument --yolo/);
  refused({ RPC_URL: "devnet" }, [], /RPC_URL is not a URL/);

  const folder = mkdtempSync(join(tmpdir(), "lure-host-test-"));
  try {
    const file = (name, text) => { writeFileSync(join(folder, name), text); return join(folder, name); };
    const good = file("agent.json", JSON.stringify([...agentPair.secretKey]));
    const sending = runner.configure({ ...env, AGENT: undefined, AGENT_KEYPAIR: good }, ["--send"]);
    assert.equal(sending.agent.toBase58(), AGENT_KEY);
    assert.deepEqual([sending.send, sending.signers.length], [true, 1]);
    refused({ AGENT_KEYPAIR: good }, [], /AGENT and AGENT_KEYPAIR are different keys/);
    refused({ AGENT: undefined, AGENT_KEYPAIR: good, FEE_PAYER: env.CREATOR }, ["--send"], /--send needs AGENT_KEYPAIR \(and FEE_PAYER_KEYPAIR/);
    refused({ AGENT_KEYPAIR: join(folder, "missing.json") }, [], /AGENT_KEYPAIR: no file at/);
    // A key file in the wrong format: the error must not repeat a single character of it.
    const secret = "5JSecretSecretSecretSecretSecretSecretSecret";
    for (const text of [secret, JSON.stringify({ key: secret }), "[1,2,3]"]) {
      assert.throws(() => runner.configure({ ...env, AGENT_KEYPAIR: file("bad.json", text) }, []), (error) => /is not a Solana keypair file|could not be read as a keypair file/.test(error.message) && !error.message.includes("Secret") && !error.message.includes("1,2,3"));
    }
    const tuned = file("config.json", '{"quietMinutes": 20, "feedSol": 0.01}');
    assert.equal(runner.configure({ ...env, HOST_CONFIG: tuned }, []).config.quietMinutes, 20);
    refused({ HOST_CONFIG: file("typo.json", '{"quietMinuts": 20}') }, [], /HOST_CONFIG: unknown config key "quietMinuts"/);
    refused({ HOST_CONFIG: file("broken.json", "{quietMinutes: 20}") }, [], /HOST_CONFIG: .* could not be read as JSON/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
