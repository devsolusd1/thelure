/* The leash page (agent.html).
 *
 * For one leash it shows what the token's agent may do, lets the visitor try forbidden moves
 * against the live program, and lists what the agent did. Everything is read from Solana
 * devnet by the visitor's browser: no server, no library. Nothing is ever signed or sent.
 *
 * The file has two halves. The first is pure (bytes, decoding, sentences, the transaction
 * encoder, the RPC calls) and also runs in Node: it is exported as LURE_AGENT. The second,
 * `boot`, is the page itself and only runs where there is a document.
 */
(function (root) {
  "use strict";

  /* ================= Addresses ================= */

  const RPC_URL = "https://api.devnet.solana.com";
  const EXPLORER = "https://explorer.solana.com";
  const CLUSTER = "devnet";
  // Shown when the link names no leash: the run made by programs/examples/devnet-smoke.mjs.
  const DEMO_LEASH = "6E6i1HrRUeQQ8bkA9VqhNvExzVQxux4ScDN4RB1kjyMY";
  const LEASH_PROGRAM = "GrojbAndyBXQTo5GxgqXAmDDKjDWkPBPeGniBEQsa89p";
  // A simulated transaction needs a fee payer that exists. The creator when it holds SOL, else this.
  const FALLBACK_PAYER = "7f2MiAuyJ1Aaiheo9ctLgJmzGDWoDceyHEEuVB2mhPAA";
  const SYSTEM_PROGRAM = "11111111111111111111111111111111";
  const NOBODY = SYSTEM_PROGRAM; // 32 zero bytes: an unset destination, a revoked agent
  const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
  const MEMO_PROGRAMS = ["MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo"];

  /* ================= The leash, byte by byte (programs/leash/src/state.rs) ================= */

  const LEASH = {
    LEN: 432,
    VERSION: 1,
    FLAG_AGENT_LOCKED: 1,
    MAX_PARAMS: 4,
    DAY: 86400n,
    OFF: {
      flags: 2, paramCount: 3, mint: 8, creator: 40, agent: 72, dest0: 104, dest1: 136,
      maxPerSpend: 168, maxPerDay: 176, maxPerReward: 184, maxRewardPerDay: 192,
      dayStart: 200, spentToday: 208, rewardedToday: 216, totalSpent: 224, totalRewarded: 232,
      params: 240, paramLen: 48,
    },
    TAG: { init: 0, spend: 1, reward: 2, setParam: 3, setAgent: 4, sweep: 5 },
    // `init` data, counted from the tag byte: tag, bump, flags, count, mint, agent, two destinations, four caps, then 40 bytes per dial.
    INIT: { count: 3, agent: 36, params: 164, paramLen: 40 },
  };

  // LeashError, in the order of the enum: the code is the index.
  const LEASH_ERRORS = [
    ["NotAgent", "That key is not this leash's agent."],
    ["NotCreator", "Only the creator can name or remove the agent."],
    ["BadDestination", "That account is not a destination fixed at launch."],
    ["OverActionCap", "More than the cap per action."],
    ["OverDailyCap", "It would pass the cap per day."],
    ["OverBudget", "The leash does not hold that much."],
    ["BadParam", "The leash has no such dial."],
    ["ParamOutOfBounds", "Outside the dial's range."],
    ["ParamStepTooBig", "Further than one move may go."],
    ["ParamCooldown", "The dial was turned too recently."],
    ["AgentLocked", "The leash is locked: its agent can be removed, never replaced."],
    ["NotRevoked", "The budget can only be swept once the agent is revoked."],
    ["BadConfig", "The limits contradict each other."],
    ["ZeroAmount", "There is nothing to move."],
  ];

  /* ================= HOOK_V1: everything this page takes from the hook =================
   * Source: programs/hook/src/state.rs and processor.rs, the Last Buyer Wins version that is
   * written but NOT deployed yet. If that layout changes, this block is the only place to fix.
   * The page uses it for three things: to tell whether a leash's first destination is the
   * token's pot (its rules account), which dial the hook reads as the game clock or the wallet
   * cap, and to recognise `settle` inside a transaction. When nothing matches, the page falls
   * back to plain words ("its first destination", "dial 1") and nothing else changes.
   */
  const HOOK_V1 = {
    PROGRAM: "4akkPWLw1imyEhcqAJaHgPPrbDZr6VPaHPifVUV7K5tS",
    RULES_LEN: 272,
    RULES_VERSION: 2,
    FLAG_LAST_BUYER_WINS: 1,
    NO_PARAM: 0xff,
    SETTLE_TAG: 1, // instruction data is this one byte; accounts: rules, winner
    OFF: { version: 0, flags: 2, capParam: 3, timerParam: 4, mint: 8, leash: 72 },
  };

  /* ================= Bytes ================= */

  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

  function b58encode(bytes) {
    let n = 0n;
    for (const b of bytes) n = (n << 8n) | BigInt(b);
    let text = "";
    for (; n > 0n; n /= 58n) text = B58[Number(n % 58n)] + text;
    for (let i = 0; i < bytes.length && bytes[i] === 0; i++) text = "1" + text;
    return text;
  }

  // Returns null for anything that is not base58.
  function b58decode(text) {
    if (typeof text !== "string") return null;
    let n = 0n;
    for (const c of text) {
      const digit = B58.indexOf(c);
      if (digit < 0) return null;
      n = n * 58n + BigInt(digit);
    }
    const out = [];
    for (; n > 0n; n >>= 8n) out.push(Number(n & 255n));
    for (let i = 0; i < text.length && text[i] === "1"; i++) out.push(0);
    return Uint8Array.from(out.reverse());
  }

  function b64decode(text) {
    const bin = atob(text);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function b64encode(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const readU32 = (bytes, at) => view(bytes).getUint32(at, true);
  const readU64 = (bytes, at) => view(bytes).getBigUint64(at, true);
  const readI64 = (bytes, at) => view(bytes).getBigInt64(at, true);
  const readKey = (bytes, at) => b58encode(bytes.subarray(at, at + 32));
  const u64le = (n) => { const b = new Uint8Array(8); view(b).setBigUint64(0, BigInt(n), true); return b; };
  const i64le = (n) => { const b = new Uint8Array(8); view(b).setBigInt64(0, BigInt(n), true); return b; };

  function concat(parts) {
    const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  }

  const isAddress = (text) => typeof text === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text) && b58decode(text).length === 32;
  const isSignature = (text) => typeof text === "string" && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(text);

  /* ================= Words ================= */

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const shortAddr = (a) => (typeof a === "string" && a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : String(a ?? ""));
  const group = (digits) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

  function fmtInt(n) {
    const s = BigInt(n).toString();
    return s[0] === "-" ? `-${group(s.slice(1))}` : group(s);
  }

  // Exact: lamports are never rounded.
  function fmtSol(lamports) {
    const l = BigInt(lamports);
    const frac = (l % 1000000000n).toString().padStart(9, "0").replace(/0+$/, "");
    return `${group((l / 1000000000n).toString())}${frac ? `.${frac}` : ""} SOL`;
  }

  function fmtSeconds(seconds) {
    const s = BigInt(seconds);
    const unit = (n, word) => `${fmtInt(n)} ${word}${n === 1n ? "" : "s"}`;
    if (s >= 86400n && s % 86400n === 0n) return unit(s / 86400n, "day");
    if (s >= 3600n && s % 3600n === 0n) return unit(s / 3600n, "hour");
    if (s >= 120n && s % 60n === 0n) return unit(s / 60n, "minute");
    return unit(s, "second");
  }

  function fmtTime(unix, timeZone) {
    if (unix === null || unix === undefined) return "time unknown";
    const options = { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false };
    if (timeZone) options.timeZone = timeZone;
    return new Date(Number(unix) * 1000).toLocaleString("en-GB", options);
  }

  const addressUrl = (a) => `${EXPLORER}/address/${encodeURIComponent(a)}?cluster=${CLUSTER}`;
  const txUrl = (sig) => `${EXPLORER}/tx/${encodeURIComponent(sig)}?cluster=${CLUSTER}`;

  // A memo is whatever its sender typed. Control and direction-override characters are dropped
  // here; the HTML escaping happens where the text meets the page, in `toHtml`.
  function cleanNote(text) {
    return String(text).replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, " ").replace(/\s+/g, " ").trim().slice(0, 280);
  }

  // Sentences are lists of pieces: plain strings, addresses, numbers to stress, quoted notes.
  // `toText` prints them (Node, aria labels); `toHtml` is the only way they reach innerHTML.
  const addr = (value, label) => ({ k: "addr", v: value, label });
  const num = (value) => ({ k: "num", v: String(value) });
  const quote = (value) => ({ k: "quote", v: String(value) });
  const flat = (pieces) => pieces.flat(Infinity).filter((p) => p !== "" && p !== null && p !== undefined);

  function toText(pieces) {
    return flat(pieces).map((p) => (typeof p === "string" ? p : p.k === "addr" ? p.label || shortAddr(p.v) : p.k === "quote" ? `"${p.v}"` : p.v)).join("");
  }

  function toHtml(pieces) {
    return flat(pieces).map((p) => {
      if (typeof p === "string") return esc(p);
      if (p.k === "num") return `<b>${esc(p.v)}</b>`;
      if (p.k === "quote") return `<q>${esc(p.v)}</q>`;
      const label = esc(p.label || shortAddr(p.v));
      return isAddress(p.v) ? `<a class="leash-addr" href="${esc(addressUrl(p.v))}" target="_blank" rel="noopener" title="${esc(p.v)}">${label}</a>` : label;
    }).join("");
  }

  /* ================= Decoding accounts ================= */

  // Returns null unless the bytes are a leash in the layout this page knows.
  function decodeLeash(data) {
    if (!(data instanceof Uint8Array) || data.length !== LEASH.LEN || data[0] !== LEASH.VERSION) return null;
    const O = LEASH.OFF;
    const key = (at) => { const k = readKey(data, at); return k === NOBODY ? null : k; };
    const count = Math.min(data[O.paramCount], LEASH.MAX_PARAMS);
    const params = [];
    for (let i = 0; i < count; i++) {
      const at = O.params + O.paramLen * i;
      params.push({
        value: readI64(data, at), min: readI64(data, at + 8), max: readI64(data, at + 16),
        maxStep: readU64(data, at + 24), cooldown: readI64(data, at + 32), lastChange: readI64(data, at + 40),
      });
    }
    return {
      version: data[0],
      locked: (data[O.flags] & LEASH.FLAG_AGENT_LOCKED) !== 0,
      mint: readKey(data, O.mint),
      creator: readKey(data, O.creator),
      agent: key(O.agent), // null once revoked
      dest: [key(O.dest0), key(O.dest1)], // null where unset
      maxPerSpend: readU64(data, O.maxPerSpend),
      maxPerDay: readU64(data, O.maxPerDay),
      maxPerReward: readU64(data, O.maxPerReward),
      maxRewardPerDay: readU64(data, O.maxRewardPerDay),
      dayStart: readI64(data, O.dayStart),
      spentToday: readU64(data, O.spentToday),
      rewardedToday: readU64(data, O.rewardedToday),
      totalSpent: readU64(data, O.totalSpent),
      totalRewarded: readU64(data, O.totalRewarded),
      params,
    };
  }

  // The hook's rules account, as far as this page needs it. Null unless it is one.
  function decodeRules(data) {
    const H = HOOK_V1;
    if (!(data instanceof Uint8Array) || data.length !== H.RULES_LEN || data[H.OFF.version] !== H.RULES_VERSION) return null;
    const dial = (at) => (data[at] === H.NO_PARAM ? null : data[at]);
    return {
      gameOn: (data[H.OFF.flags] & H.FLAG_LAST_BUYER_WINS) !== 0,
      capDial: dial(H.OFF.capParam),
      clockDial: dial(H.OFF.timerParam),
      mint: readKey(data, H.OFF.mint),
      leash: readKey(data, H.OFF.leash),
    };
  }

  // Who may still change the leash program. Null when it cannot be told from these two accounts.
  function decodeUpgrade(program, programData) {
    if (!program || !program.executable) return null;
    if (program.owner !== UPGRADEABLE_LOADER) return { upgradeable: false, authority: null };
    if (!programData || programData.owner !== UPGRADEABLE_LOADER || programData.data.length < 45 || readU32(programData.data, 0) !== 3) return null;
    return programData.data[12] === 1 ? { upgradeable: true, authority: readKey(programData.data, 13) } : { upgradeable: false, authority: null };
  }

  const programDataOf = (program) =>
    program && program.owner === UPGRADEABLE_LOADER && program.data.length >= 36 && readU32(program.data, 0) === 2 ? readKey(program.data, 4) : null;

  // An account as the RPC returns it, with the fields this page reads.
  function readAccount(raw) {
    if (!raw) return null;
    const data = b64decode(raw.data[0]);
    return { lamports: BigInt(raw.lamports), owner: raw.owner, executable: !!raw.executable, data, space: typeof raw.space === "number" ? raw.space : data.length };
  }

  /* Everything the page knows about one leash, from the accounts read in `loadLeash`.
   *   info      the leash account            rent   { leash, empty } minimum balances, in lamports
   *   accounts  address -> account or null   program { upgradeable, authority } or null
   */
  function buildView({ address, info, rent, accounts, program, readAt, slot }) {
    const leash = decodeLeash(info.data);
    if (!leash) return null;
    const rentLeash = BigInt(rent.leash), rentEmpty = BigInt(rent.empty);
    const v = {
      address, leash, accounts: accounts || {}, program: program || null, readAt, slot,
      lamports: info.lamports,
      budget: info.lamports > rentLeash ? info.lamports - rentLeash : 0n,
      rent: { leash: rentLeash, empty: rentEmpty, perByte: (rentLeash - rentEmpty) / BigInt(LEASH.LEN) },
      pot: null, clockDial: null, capDial: null,
    };
    const creator = v.accounts[leash.creator];
    v.payer = creator && creator.lamports >= rentEmpty + 100000n ? leash.creator : FALLBACK_PAYER;

    // The first destination is "the pot" only if it is this token's rules account, with the game on.
    const first = leash.dest[0] ? v.accounts[leash.dest[0]] : null;
    const rules = first && first.owner === HOOK_V1.PROGRAM ? decodeRules(first.data) : null;
    if (rules && rules.mint === leash.mint) {
      const floor = rentFloor(v, HOOK_V1.RULES_LEN);
      if (rules.gameOn) v.pot = { address: leash.dest[0], lamports: first.lamports > floor ? first.lamports - floor : 0n, rules };
      if (rules.leash === address) {
        const has = (i) => i !== null && i < leash.params.length;
        if (rules.gameOn && has(rules.clockDial)) v.clockDial = rules.clockDial;
        if (has(rules.capDial)) v.capDial = rules.capDial;
      }
    }
    return v;
  }

  // What an account of `space` bytes must hold. Rent is linear in the size.
  const rentFloor = (v, space) => v.rent.empty + v.rent.perByte * BigInt(space);

  /* ================= What it may do, as sentences ================= */

  const firstName = (v) => (v.pot ? "the pot" : "its first destination");
  const dialName = (v, i) => (i === v.clockDial ? "the clock" : `dial ${i + 1}`);

  function accountKind(v, address) {
    const a = v.accounts[address];
    if (v.pot && v.pot.address === address) return "this token's game account";
    if (a === undefined) return "";
    if (a === null) return "an address with nothing in it yet";
    if (a.owner === SYSTEM_PROGRAM && a.space === 0) return "a plain wallet";
    return ["an account of program ", addr(a.owner)];
  }

  function dialSentence(v, i) {
    const p = v.leash.params[i], n = String(i + 1);
    const isClock = i === v.clockDial;
    let now;
    if (isClock) {
      const seconds = p.value < 1n ? 1n : p.value; // the hook never lets a round last less than a second
      const plain = fmtSeconds(seconds);
      now = ["Dial ", n, " is the game clock: every buy that counts sets it to ", num(`${fmtInt(seconds)} seconds`), plain.endsWith("seconds") || plain.endsWith("second") ? "" : ` (${plain})`, "."];
    } else if (i === v.capDial) {
      now = ["Dial ", n, " is the most one wallet may hold: ", num(fmtInt(p.value)), " of the token's smallest units", p.value === 0n ? " (0 means no cap)" : "", "."];
    } else {
      now = ["Dial ", n, " is at ", num(fmtInt(p.value)), "."];
    }
    if (p.min === p.max) return [now, " It cannot move."];
    const range = [" It can go from ", num(fmtInt(p.min)), " to ", num(fmtInt(p.max)), isClock ? " seconds" : ""];
    const step = p.maxStep === 0n ? ", any distance in one move" : [", at most ", num(fmtInt(p.maxStep)), " per move"];
    const wait = p.cooldown === 0n ? ", with no wait between moves" : [", one move every ", num(fmtSeconds(p.cooldown).replace(/^1 /, ""))];
    return [now, range, step, wait, "."];
  }

  // `now` is unix seconds. Each sentence is a list of pieces for `toHtml` or `toText`.
  function limitSentences(v, now) {
    const L = v.leash, out = [];
    const clock = BigInt(Math.floor(now));
    const sameDay = clock - L.dayStart < LEASH.DAY;

    if (L.agent && L.agent === L.creator) out.push(["The agent's key is ", addr(L.agent), ", which is also the creator's key: whoever holds it can do what is listed here, and what the creator can."]);
    else if (L.agent) out.push(["The agent's key is ", addr(L.agent), ". Whoever holds it can do what is listed here and nothing else."]);
    else if (L.locked) out.push(["The agent was revoked and the leash is locked: no key will ever spend, reward or turn a dial again. The rest is what the leash allowed."]);
    else out.push(["The agent was revoked: right now no key can spend, reward or turn a dial. The rest is what the leash allowed, and would allow a new agent."]);

    const dests = [0, 1].filter((i) => L.dest[i]);
    if (L.maxPerSpend === 0n || !dests.length) {
      out.push(["It cannot send SOL to any destination: ", L.maxPerSpend === 0n ? "the cap is 0" : "none was set", "."]);
    } else {
      const named = dests.map((i) => {
        const kind = accountKind(v, L.dest[i]);
        return [i === 0 && v.pot ? "the pot, " : "", addr(L.dest[i]), kind ? [" (", kind, ")"] : ""];
      });
      out.push(dests.length === 2
        ? ["SOL from the budget can go to two accounts only: ", named[0], " and ", named[1], "."]
        : ["SOL from the budget can go to one account only: ", named[0], "."]);
      const used = L.agent && sameDay && L.spentToday > 0n ? [" Today it has used ", num(fmtSol(L.spentToday)), " of that."] : "";
      out.push(["Never more than ", num(fmtSol(L.maxPerSpend)), " per action or ", num(fmtSol(L.maxPerDay)), " per day.", used]);
    }

    out.push(L.maxPerReward === 0n
      ? ["Rewards are off: it can pay no other wallet."]
      : ["It can also reward any wallet it picks, its own included: up to ", num(fmtSol(L.maxPerReward)), " per action and ", num(fmtSol(L.maxRewardPerDay)), " per day."]);

    if (!L.params.length) out.push(["It has no dial to turn."]);
    L.params.forEach((_, i) => out.push(dialSentence(v, i)));

    const sent = L.totalSpent + L.totalRewarded > 0n
      ? [" So far ", num(fmtSol(L.totalSpent)), " went to its destinations", L.totalRewarded > 0n ? [" and ", num(fmtSol(L.totalRewarded)), " to rewards"] : "", "."]
      : "";
    const sweepable = !L.agent && v.budget > 0n && L.dest[0] ? [" Anyone can sweep it to ", firstName(v), "."] : "";
    out.push(["Budget left: ", num(fmtSol(v.budget)), ".", sent, sweepable]);
    if (v.pot) out.push(["The pot holds ", num(fmtSol(v.pot.lamports)), " right now."]);

    const creator = ["The creator, ", addr(L.creator), ","];
    if (L.agent) out.push(L.locked
      ? [creator, " can remove the agent at any time. The leash is locked, so no other agent can ever be named."]
      : [creator, " can remove the agent at any time and name another."]);
    else if (!L.locked) out.push([creator, " can still name a new agent."]);

    const fixed = ["Nobody can change these limits, the creator included: the leash program has no instruction for it."];
    if (v.program && v.program.upgradeable) fixed.push(" The program itself can still be replaced by whoever holds ", addr(v.program.authority), ", so the limits are only as fixed as that key.");
    else if (v.program) fixed.push(" The program can no longer be changed either.");
    out.push(fixed);

    out.push(["Made for token ", addr(L.mint), "."]);
    return out;
  }

  /* ================= Instructions and the transaction encoder ================= */

  const meta = (pubkey, signer, writable) => ({ pubkey, signer: !!signer, writable: !!writable });

  // An action in plain terms -> the leash instruction that asks for it. Same bytes as
  // programs/examples/devnet-smoke.mjs builds.
  function toInstruction(act, leash) {
    const ix = (keys, ...data) => ({ programId: LEASH_PROGRAM, keys, data: concat(data) });
    const T = LEASH.TAG;
    switch (act.kind) {
      case "spend":
        return ix([meta(act.signer, true), meta(leash, false, true), meta(act.to, false, true)], Uint8Array.of(T.spend, act.index), u64le(act.amount));
      case "reward":
        return ix([meta(act.signer, true), meta(leash, false, true), meta(act.to, false, true)], Uint8Array.of(T.reward), u64le(act.amount));
      case "dial":
        return ix([meta(act.signer, true), meta(leash, false, true)], Uint8Array.of(T.setParam, act.index), i64le(act.value));
      case "agent":
        return ix([meta(act.signer, true), meta(leash, false, true)], Uint8Array.of(T.setAgent), b58decode(act.next || NOBODY));
      case "sweep":
        return ix([meta(leash, false, true), meta(act.to, false, true)], Uint8Array.of(T.sweep));
      default:
        throw new Error(`unknown action ${act.kind}`);
    }
  }

  function shortvec(n) {
    const out = [];
    for (;;) {
      const low = n & 0x7f;
      n >>= 7;
      if (n === 0) { out.push(low); return Uint8Array.from(out); }
      out.push(low | 0x80);
    }
  }

  // A legacy transaction message. Keys are ordered the way Solana wants them: signers first,
  // writable before read-only, the fee payer at the front.
  function compileMessage(payer, instructions, blockhash) {
    const seen = new Map();
    const touch = (pubkey, signer, writable) => {
      const m = seen.get(pubkey) || { signer: false, writable: false };
      m.signer = m.signer || signer;
      m.writable = m.writable || writable;
      seen.set(pubkey, m);
    };
    touch(payer, true, true);
    for (const ix of instructions) {
      touch(ix.programId, false, false);
      for (const k of ix.keys) touch(k.pubkey, k.signer, k.writable);
    }
    const pick = (signer, writable) => [...seen].filter(([, m]) => m.signer === signer && m.writable === writable).map(([k]) => k);
    const signedRO = pick(true, false), unsignedRO = pick(false, false);
    const keys = [...pick(true, true), ...signedRO, ...pick(false, true), ...unsignedRO];
    const signers = keys.length - pick(false, true).length - unsignedRO.length;
    const index = new Map(keys.map((k, i) => [k, i]));
    const parts = [Uint8Array.of(signers, signedRO.length, unsignedRO.length), shortvec(keys.length), ...keys.map(b58decode), blockhash || new Uint8Array(32), shortvec(instructions.length)];
    for (const ix of instructions) {
      parts.push(Uint8Array.of(index.get(ix.programId)), shortvec(ix.keys.length), Uint8Array.from(ix.keys.map((k) => index.get(k.pubkey))), shortvec(ix.data.length), ix.data);
    }
    return { bytes: concat(parts), signers, keys };
  }

  // The wire form with every signature left as zeros: enough to simulate, impossible to send.
  const unsignedTransaction = (message) => concat([shortvec(message.signers), new Uint8Array(64 * message.signers), message.bytes]);

  /* ================= What the program would answer, worked out here =================
   * A copy of the checks in programs/leash/src, in the same order. The page never shows this:
   * the answer on screen is always the live program's. It travels with each attempt as
   * `expect`, so a proof run in Node can hold every live answer against the one expected.
   */
  function predict(v, act, now) {
    const L = v.leash, clock = BigInt(Math.floor(Number(now)));
    const isAgent = L.agent !== null && act.signer === L.agent;
    const pay = (amount, perAction, perDay, today) => {
      const fresh = clock - L.dayStart >= LEASH.DAY;
      const a = BigInt(amount);
      if (a === 0n) return { code: 13 };
      if (a > perAction) return { code: 3 };
      if ((fresh ? 0n : today) + a > perDay) return { code: 4 };
      if (a > v.budget) return { code: 5 };
      return { ok: true };
    };
    switch (act.kind) {
      case "spend":
        if (act.to === v.address) return { code: 2 };
        if (!isAgent) return { code: 0 };
        if (act.index > 1 || L.dest[act.index] === null || L.dest[act.index] !== act.to) return { code: 2 };
        return pay(act.amount, L.maxPerSpend, L.maxPerDay, L.spentToday);
      case "reward":
        if (act.to === v.address) return { code: 2 };
        if (!isAgent) return { code: 0 };
        return pay(act.amount, L.maxPerReward, L.maxRewardPerDay, L.rewardedToday);
      case "dial": {
        if (!isAgent) return { code: 0 };
        const p = L.params[act.index];
        if (!p) return { code: 6 };
        const value = BigInt(act.value), moved = value > p.value ? value - p.value : p.value - value;
        if (value < p.min || value > p.max) return { code: 7 };
        if (p.maxStep !== 0n && moved > p.maxStep) return { code: 8 };
        if (clock - p.lastChange < p.cooldown) return { code: 9 };
        return { ok: true };
      }
      case "agent":
        if (act.signer !== L.creator) return { code: 1 };
        if (act.next && L.locked) return { code: 10 };
        return { ok: true };
      case "sweep":
        if (L.agent !== null) return { code: 11 };
        if (L.dest[0] === null || act.to !== L.dest[0]) return { code: 2 };
        return { ok: true };
      default:
        return { code: -1 };
    }
  }

  // Solana fails any transaction that leaves a credited account below its rent floor, whatever
  // the program said. A payment into an empty address has to be big enough to clear it.
  function lands(v, to, amount) {
    const a = v.accounts[to];
    return (a ? a.lamports : 0n) + amount >= rentFloor(v, a ? a.space : 0);
  }

  const smallest = (...values) => values.reduce((a, b) => (b < a ? b : a));

  // One move the leash allows right now, or null. Feeding the pot first, then a dial, then a reward.
  function insideMove(v, clock, outsider) {
    const L = v.leash;
    if (!L.agent) return null;
    // The chain's clock can run a little behind this one, so windows are only trusted with a margin.
    const fresh = clock - L.dayStart >= LEASH.DAY + 120n;
    if (L.dest[0] && L.maxPerSpend > 0n) {
      const amount = smallest(L.maxPerSpend, L.maxPerDay - (fresh ? 0n : L.spentToday), v.budget);
      if (amount > 0n && lands(v, L.dest[0], amount)) {
        return {
          label: v.pot ? `Feed the pot ${fmtSol(amount)}` : `Send ${fmtSol(amount)} to its first destination`,
          act: { kind: "spend", signer: L.agent, index: 0, to: L.dest[0], amount },
          what: ["send ", num(fmtSol(amount)), " to ", firstName(v), ", ", addr(L.dest[0]), "."],
        };
      }
    }
    const order = L.params.map((_, i) => i).sort((a, b) => (a === v.clockDial ? -1 : b === v.clockDial ? 1 : a - b));
    for (const i of order) {
      const p = L.params[i];
      if (p.cooldown !== 0n && clock - p.lastChange < p.cooldown + 120n) continue;
      const up = p.maxStep === 0n ? p.max : smallest(p.value + p.maxStep, p.max);
      const down = p.maxStep === 0n ? p.min : p.value - p.maxStep > p.min ? p.value - p.maxStep : p.min;
      const value = up > p.value ? up : down;
      if (value === p.value) continue;
      return {
        label: `Turn ${dialName(v, i)} from ${fmtInt(p.value)} to ${fmtInt(value)}`,
        act: { kind: "dial", signer: L.agent, index: i, value },
        what: ["turn ", dialName(v, i), " from ", num(fmtInt(p.value)), " to ", num(fmtInt(value)), p.maxStep === 0n ? ". This dial has no step limit." : ", one step."],
      };
    }
    if (L.maxPerReward > 0n) {
      const amount = smallest(L.maxPerReward, L.maxRewardPerDay - (fresh ? 0n : L.rewardedToday), v.budget);
      if (amount > 0n && lands(v, outsider, amount)) {
        return {
          label: `Reward an outside wallet ${fmtSol(amount)}`,
          act: { kind: "reward", signer: L.agent, to: outsider, amount },
          what: ["reward ", addr(outsider), ", a wallet it picked, with ", num(fmtSol(amount)), "."],
        };
      }
    }
    return null;
  }

  // A dial move that should be refused: too far in one go if the dial has a step, else out of range.
  function badDialMove(v) {
    const L = v.leash;
    const order = L.params.map((_, i) => i).sort((a, b) => (a === v.clockDial ? -1 : b === v.clockDial ? 1 : a - b));
    const I64_MAX = (1n << 63n) - 1n, I64_MIN = -(1n << 63n);
    for (const i of order) {
      const p = L.params[i], name = dialName(v, i);
      if (p.maxStep !== 0n && p.max - p.value > p.maxStep) return { index: i, value: p.max, label: `Jump ${name} to ${fmtInt(p.max)} in one move`, why: [", the end of its range, in one move."] };
      if (p.maxStep !== 0n && p.value - p.min > p.maxStep) return { index: i, value: p.min, label: `Jump ${name} to ${fmtInt(p.min)} in one move`, why: [", the end of its range, in one move."] };
      if (p.max < I64_MAX) return { index: i, value: p.max + 1n, label: `Push ${name} past its range`, why: [", just past the top of its range."] };
      if (p.min > I64_MIN) return { index: i, value: p.min - 1n, label: `Push ${name} past its range`, why: [", just under the bottom of its range."] };
    }
    return null;
  }

  /* The buttons of "Try to break it", chosen from the leash as it is now.
   *   options.now       unix seconds        options.outsider  an address outside the leash
   *   options.oldAgent  for a revoked leash: the key that used to be its agent, if the history gave it
   * Each attempt: { id, label, act, what (pieces), expect ({ ok } or { code }) }.
   */
  function planAttempts(v, options) {
    const L = v.leash, clock = BigInt(Math.floor(options.now)), outsider = options.outsider;
    const out = [];
    const add = (id, label, act, what) => out.push({ id, label, act, what, expect: predict(v, act, clock) });
    const first = L.dest[0] || outsider;
    const dial = badDialMove(v);

    if (L.agent) {
      const as = ["Signed as the agent, ", addr(L.agent), ": "];
      const all = v.budget > 0n ? v.budget : 1n;
      add("steal", v.budget > 0n ? "Send the whole budget to an outside wallet" : "Send SOL to an outside wallet", { kind: "spend", signer: L.agent, index: 0, to: outsider, amount: all },
        [as, "send ", num(fmtSol(all)), v.budget > 0n ? ", the whole budget," : "", " to ", addr(outsider), ", a wallet outside the leash."]);
      if (L.dest[0]) {
        const over = L.maxPerSpend + 1n;
        add("overcap", `Send more than the cap to ${firstName(v)}`, { kind: "spend", signer: L.agent, index: 0, to: L.dest[0], amount: over },
          [as, "send ", num(fmtSol(over)), " to ", firstName(v), ", one lamport over the cap per action."]);
      }
      const prize = L.maxPerReward > 0n ? L.maxPerReward + 1n : all;
      add("reward", L.maxPerReward > 0n ? "Reward an outside wallet over the cap" : "Pay an outside wallet as a reward", { kind: "reward", signer: L.agent, to: outsider, amount: prize },
        [as, "reward ", addr(outsider), " with ", num(fmtSol(prize)), L.maxPerReward > 0n ? ", one lamport over the reward cap." : ". Rewards are off on this leash."]);
      if (dial) add("dial", dial.label, { kind: "dial", signer: L.agent, index: dial.index, value: dial.value }, [as, "set ", dialName(v, dial.index), " to ", num(fmtInt(dial.value)), dial.why]);
      add("newagent", "Name a new agent", { kind: "agent", signer: L.agent, next: outsider }, [as, "hand the leash to a new agent, ", addr(outsider), "."]);
      add("sweep", "Sweep the budget", { kind: "sweep", to: first }, ["Signed by nobody, since anyone may ask: sweep the budget to ", L.dest[0] ? [firstName(v), "."] : [addr(first), "."]]);
      const some = L.maxPerSpend > 0n ? L.maxPerSpend : 1n;
      add("stranger", "A stranger spends", { kind: "spend", signer: outsider, index: 0, to: first, amount: some },
        ["Signed as a stranger, ", addr(outsider), ": send ", num(fmtSol(some)), " to ", L.dest[0] ? firstName(v) : addr(first), "."]);
      const inside = insideMove(v, clock, outsider);
      if (inside) add("inside", inside.label, inside.act, [as, inside.what]);
    } else {
      const key = options.oldAgent || outsider;
      const who = options.oldAgent ? "the old agent" : "a stranger";
      const as = [`Signed as ${who}, `, addr(key), ": "];
      const some = L.maxPerSpend > 0n ? L.maxPerSpend : 1n;
      add("oldspend", options.oldAgent ? "The old key spends" : "A stranger spends", { kind: "spend", signer: key, index: 0, to: first, amount: some },
        [as, "send ", num(fmtSol(some)), " to ", L.dest[0] ? firstName(v) : addr(first), "."]);
      if (dial) add("olddial", options.oldAgent ? `The old key turns ${dialName(v, dial.index)}` : `A stranger turns ${dialName(v, dial.index)}`, { kind: "dial", signer: key, index: dial.index, value: dial.value },
        [as, "set ", dialName(v, dial.index), " to ", num(fmtInt(dial.value)), "."]);
      add("oldagent", options.oldAgent ? "The old key names itself agent again" : "A stranger names itself agent", { kind: "agent", signer: key, next: key }, [as, "make that key the agent."]);
      add("sweepout", "Sweep the budget to an outside wallet", { kind: "sweep", to: outsider }, ["Signed by nobody, since anyone may ask: sweep what is left to ", addr(outsider), ", a wallet outside the leash."]);
      if (L.dest[0]) add("inside", `Sweep what is left to ${firstName(v)}`, { kind: "sweep", to: L.dest[0] },
        ["Signed by nobody, since anyone may ask: sweep what is left, ", num(fmtSol(v.budget)), ", to ", firstName(v), ", ", addr(L.dest[0]), "."]);
    }
    return out;
  }

  // The base64 transaction the page hands to simulateTransaction for one attempt.
  function attemptTransaction(v, attempt) {
    return b64encode(unsignedTransaction(compileMessage(v.payer, [toInstruction(attempt.act, v.address)])));
  }

  /* Reads `value` of a simulateTransaction result. `at` is the instruction the leash was asked in.
   *   { ok: true, units }                         the program let it through
   *   { ok: false, by: "leash", code, name, plain }   refused by the leash, with its own code
   *   { ok: false, by: "rent" }                   allowed by the leash, stopped by Solana's rent rule
   *   { ok: false, by: "other", detail }          anything else (fee payer missing, an RPC quirk)
   */
  function readSimulation(value, at = 0) {
    const units = value && typeof value.unitsConsumed === "number" ? value.unitsConsumed : null;
    const err = value ? value.err : "no result";
    if (err === null || err === undefined) return { ok: true, units };
    if (err && typeof err === "object" && Array.isArray(err.InstructionError)) {
      const [index, why] = err.InstructionError;
      if (index === at && why && typeof why === "object" && Number.isInteger(why.Custom)) {
        const known = LEASH_ERRORS[why.Custom];
        return { ok: false, by: "leash", code: why.Custom, name: known ? known[0] : `Custom ${why.Custom}`, plain: known ? known[1] : "The program refused with a code this page does not know.", units };
      }
      return { ok: false, by: "other", detail: `instruction ${index}: ${typeof why === "string" ? why : JSON.stringify(why)}`, units };
    }
    if (err && typeof err === "object" && err.InsufficientFundsForRent) return { ok: false, by: "rent", units };
    return { ok: false, by: "other", detail: typeof err === "string" ? err : JSON.stringify(err), units };
  }

  // The live answer in words. `attempt` sharpens two cases the bare code leaves vague.
  function verdict(result, v, attempt) {
    if (result.ok && attempt && attempt.act.kind === "agent") return { tone: "ok", head: "Would go through.", body: ["On this leash that key is the creator's key, and the creator may name the agent."] };
    if (result.ok) return { tone: "ok", head: "Would go through.", body: ["The leash program allowed it."] };
    if (result.by === "leash") {
      let plain = result.plain;
      if (result.code === 0 && !v.leash.agent) plain = "The agent was revoked, so no key can act for this leash.";
      if (result.code === 3 && attempt && attempt.act.kind === "reward" && v.leash.maxPerReward === 0n) plain = "Rewards are off on this leash: the cap is 0.";
      return { tone: "no", head: "Refused by the leash.", body: [plain, " Error ", num(`0x${result.code.toString(16)}`), ", ", result.name, "."] };
    }
    if (result.by === "rent") return { tone: "no", head: "Stopped by Solana, not by the leash.", body: ["The leash allowed it, but the payment is too small for an empty address to keep."] };
    return { tone: "no", head: "Devnet could not run it.", body: ["It answered: ", result.detail, "."] };
  }

  /* ================= What it did: one transaction, one sentence ================= */

  // Turns a getTransaction result (encoding "json") into what it did to this leash.
  // `parts` is empty for a transaction that only read the account, such as a trade of the token.
  function describeTransaction(tx, leash) {
    const message = tx.transaction.message, m = tx.meta || {};
    const loaded = m.loadedAddresses || {};
    const keys = [...message.accountKeys, ...(loaded.writable || []), ...(loaded.readonly || [])];
    const entry = {
      signature: tx.transaction.signatures[0], slot: tx.slot, time: tx.blockTime ?? null,
      feePayer: keys[0], parts: [], notes: [], failed: null, delta: 0n,
    };
    const at = keys.indexOf(leash);
    if (at >= 0 && m.preBalances && m.postBalances) entry.delta = BigInt(m.postBalances[at]) - BigInt(m.preBalances[at]);

    const inner = new Map((m.innerInstructions || []).map((g) => [g.index, g.instructions]));
    const all = [];
    message.instructions.forEach((ix, i) => {
      all.push({ ix, top: i, inner: false });
      for (const sub of inner.get(i) || []) all.push({ ix: sub, top: i, inner: true });
    });

    for (const { ix, inner: isInner } of all) {
      const program = keys[ix.programIdIndex];
      const acct = (ix.accounts || []).map((i) => keys[i]);
      const data = b58decode(ix.data) || new Uint8Array(0);
      const T = LEASH.TAG;
      if (program === LEASH_PROGRAM && acct.includes(leash)) {
        const tag = data[0];
        if (tag === T.init && acct[1] === leash && data.length >= LEASH.INIT.params) {
          const dials = [];
          for (let i = 0; i < data[LEASH.INIT.count] && LEASH.INIT.params + LEASH.INIT.paramLen * (i + 1) <= data.length; i++) dials.push(readI64(data, LEASH.INIT.params + LEASH.INIT.paramLen * i));
          entry.parts.push({ kind: "init", creator: acct[0], agent: readKey(data, LEASH.INIT.agent), dials });
        } else if (tag === T.spend && acct[1] === leash && data.length >= 10) {
          entry.parts.push({ kind: "spend", signer: acct[0], index: data[1], to: acct[2], amount: readU64(data, 2) });
        } else if (tag === T.reward && acct[1] === leash && data.length >= 9) {
          entry.parts.push({ kind: "reward", signer: acct[0], to: acct[2], amount: readU64(data, 1) });
        } else if (tag === T.setParam && acct[1] === leash && data.length >= 10) {
          entry.parts.push({ kind: "dial", signer: acct[0], index: data[1], value: readI64(data, 2), from: null });
        } else if (tag === T.setAgent && acct[1] === leash && data.length >= 33) {
          const next = readKey(data, 1);
          entry.parts.push({ kind: "agent", signer: acct[0], next: next === NOBODY ? null : next });
        } else if (tag === T.sweep && acct[0] === leash) {
          entry.parts.push({ kind: "sweep", to: acct[1], amount: 0n });
        } else {
          entry.parts.push({ kind: "other" });
        }
      } else if (program === SYSTEM_PROGRAM && data.length >= 12 && readU32(data, 0) === 2 && acct[1] === leash) {
        entry.parts.push({ kind: "deposit", from: acct[0], amount: readU64(data, 4), inner: isInner });
      } else if (program === SYSTEM_PROGRAM && data.length >= 12 && readU32(data, 0) === 11 && acct[2] === leash) {
        entry.parts.push({ kind: "deposit", from: acct[0], amount: readU64(data, 4), inner: isInner });
      } else if (program === HOOK_V1.PROGRAM && data.length === 1 && data[0] === HOOK_V1.SETTLE_TAG && acct.length >= 2) {
        entry.parts.push({ kind: "settle", winner: acct[1] });
      } else if (MEMO_PROGRAMS.includes(program)) {
        const text = cleanNote(new TextDecoder("utf-8").decode(data));
        if (text) entry.notes.push(text);
      }
    }

    // `init` pays the account's rent through the system program: that is not a top-up.
    if (entry.parts.some((p) => p.kind === "init")) entry.parts = entry.parts.filter((p) => !(p.kind === "deposit" && p.inner));
    // A settle only belongs here when the same transaction also touched the leash.
    if (!entry.parts.some((p) => p.kind !== "settle")) entry.parts = [];

    if (m.err) {
      // It landed, but as a failure: nothing in it happened. `code` is set when the leash itself said no.
      entry.failed = { plain: null, code: null, name: null };
      const ie = m.err.InstructionError;
      if (Array.isArray(ie) && ie[1] && typeof ie[1] === "object" && Number.isInteger(ie[1].Custom) && message.instructions[ie[0]] && keys[message.instructions[ie[0]].programIdIndex] === LEASH_PROGRAM) {
        const known = LEASH_ERRORS[ie[1].Custom];
        entry.failed = { plain: known ? known[1] : null, code: ie[1].Custom, name: known ? known[0] : null };
      }
    } else {
      const sum = (kind) => entry.parts.filter((p) => p.kind === kind).reduce((total, p) => total + p.amount, 0n);
      const sweeps = entry.parts.filter((p) => p.kind === "sweep");
      // What a sweep moved is not in its data: it is whatever the balance lost beyond the rest.
      if (sweeps.length) sweeps[0].amount = sum("deposit") - sum("spend") - sum("reward") - entry.delta;
      if (!entry.parts.length && entry.delta > 0n) entry.parts.push({ kind: "deposit", from: null, amount: entry.delta, inner: true });
    }
    entry.byAgent = !entry.failed && entry.parts.some((p) => p.kind === "spend" || p.kind === "reward" || p.kind === "dial");
    return entry;
  }

  // A dial change only carries the new value. The old one is the change before it, or the launch.
  // `entries` is newest first; call again whenever older ones are added.
  function linkDials(entries) {
    const known = [];
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].failed) continue;
      for (const p of entries[i].parts) {
        if (p.kind === "init") p.dials.forEach((value, d) => { known[d] = value; });
        if (p.kind === "dial") { p.from = known[p.index] === undefined ? null : known[p.index]; known[p.index] = p.value; }
      }
    }
    return known;
  }

  // For a revoked leash: the last key that was its agent, if the loaded history shows it.
  function lastAgent(entries) {
    for (const e of entries) {
      if (e.failed) continue;
      for (let i = e.parts.length - 1; i >= 0; i--) {
        const p = e.parts[i];
        if (p.kind === "spend" || p.kind === "reward" || p.kind === "dial") return p.signer;
        if (p.kind === "agent" && p.next) return p.next;
        if (p.kind === "init") return p.agent;
      }
    }
    return null;
  }

  // One entry as a sentence (pieces). The note is separate: see `entry.notes`.
  function entrySentence(entry, v) {
    if (entry.missing) return ["A transaction this page could not read."];
    const L = v.leash, tried = !!entry.failed;
    // "its" only where the agent is the subject; anyone else gets "the leash's".
    const destName = (i, own) => (i === 0 && v.pot ? "the pot" : `${own ? "its" : "the leash's"} ${i === 0 ? "first destination" : i === 1 ? "second destination" : `destination ${i + 1}`}`);
    const actor = (key) => (key === L.creator ? "Creator" : key ? addr(key) : "Someone");
    const clauses = entry.parts.map((p) => {
      const own = !(tried && p.signer !== L.agent);
      const agent = own ? "Agent" : actor(p.signer);
      switch (p.kind) {
        case "init": return ["Creator", tried ? "set up the leash" : ["set up the leash and named ", addr(p.agent), " its agent"]];
        case "deposit": return [actor(p.from), [tried ? "add " : "added ", num(fmtSol(p.amount)), " to the budget"]];
        case "spend": return [agent, [tried ? "send " : "sent ", num(fmtSol(p.amount)), " to ", destName(p.index, own)]];
        case "reward": return [agent, [tried ? "reward " : "rewarded ", addr(p.to), " with ", num(fmtSol(p.amount))]];
        case "dial": return [agent, [tried ? "turn " : "turned ", dialName(v, p.index), p.from === null || tried ? "" : [" from ", num(fmtInt(p.from))], " to ", num(fmtInt(p.value))]];
        case "agent": return ["Creator", p.next ? [tried ? "name " : "named ", addr(p.next), " the new agent"] : [tried ? "revoke the agent" : "revoked the agent"]];
        case "sweep": return [actor(entry.feePayer), tried ? ["sweep the budget to ", addr(p.to)] : ["swept the remaining ", num(fmtSol(p.amount)), " to ", p.to === L.dest[0] ? destName(0, false) : addr(p.to)]];
        case "settle": return [entry.byAgent ? "Agent" : actor(entry.feePayer), [tried ? "pay " : "paid ", "the round's winner ", addr(p.winner)]];
        default: return [actor(entry.feePayer), [tried ? "call" : "called", " the leash program in a way this page does not know"]];
      }
    });
    // Clauses that share a subject share a sentence: "Agent sent ... and turned ...".
    const groups = [];
    for (const [subject, phrase] of clauses) {
      const last = groups[groups.length - 1];
      if (last && toText([last.subject]) === toText([subject])) last.phrases.push(phrase);
      else groups.push({ subject, phrases: [phrase] });
    }
    const out = [];
    groups.forEach((g, i) => {
      const list = g.phrases.map((phrase, n) => [n === 0 ? "" : n === g.phrases.length - 1 ? " and " : ", ", phrase]);
      out.push(i ? " " : "", g.subject, tried ? " tried to " : " ", list, ".");
    });
    if (tried && entry.failed.code !== null) {
      const why = entry.failed.plain ? entry.failed.plain.charAt(0).toLowerCase() + entry.failed.plain.slice(1).replace(/\.$/, "") : "the leash said no";
      out.push(" Refused on chain: ", why, " (", num(`0x${entry.failed.code.toString(16)}`), ").");
    } else if (tried) {
      out.push(" It failed on chain, so nothing moved.");
    }
    return out;
  }

  /* ================= Asking devnet =================
   * What the public devnet RPC allows one IP address, measured on 2026-10-09:
   *   - 10 getTransaction and 10 getSignaturesForAddress per ten seconds; 50 account reads; 150 simulations;
   *   - every call inside a batch is counted, and so is every call it refuses;
   *   - a batch holding two getAccountInfo calls is refused outright (getMultipleAccounts is not).
   * So: single calls, one getMultipleAccounts for several accounts, getTransaction batched but
   * paced by this page's own tally, and a long wait, not a quick one, after a "too many requests".
   */

  class ReadError extends Error {
    // kind: "rate" | "network" | "rpc" | "missing" | "notleash"
    constructor(kind, message, extra) { super(message); this.kind = kind; Object.assign(this, extra || {}); }
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const RATE_WAIT = 11000; // the RPC counts in ten-second windows
  const isRateError = (e) => e && (e.code === 429 || /too many|rate limit/i.test(String(e.message)));

  /* One HTTP request for one call, or for several calls of the same method ([method, params]
   * each). Returns the results in order. When the RPC says "too many requests", for the whole
   * request or for some of its calls, it waits out the window and asks again for what is
   * missing. A request that does not get through at all is retried sooner.
   *   options.tries   attempts in all (3)      options.onWait(kind, ms)   called before each wait
   *   options.lenient a call the RPC answers with an error gives null instead of failing them all
   */
  async function rpc(calls, options = {}) {
    const url = options.url || RPC_URL, tries = options.tries || 3;
    const results = new Array(calls.length);
    let pending = calls.map((_, i) => i);
    let last = new ReadError("network", "no answer");
    for (let attempt = 0; attempt < tries; attempt++) {
      if (attempt) {
        const wait = last.kind === "rate" ? RATE_WAIT : 2000 * attempt;
        if (options.onWait) options.onWait(last.kind, wait);
        await sleep(wait);
      }
      const body = pending.map((i) => ({ jsonrpc: "2.0", id: i + 1, method: calls[i][0], params: calls[i][1] }));
      let response, json;
      try {
        response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body.length === 1 ? body[0] : body) });
      } catch (error) {
        last = new ReadError("network", "the request did not get through");
        continue;
      }
      if (response.status === 429) { last = new ReadError("rate", "too many requests"); continue; }
      if (response.status >= 500) { last = new ReadError("network", `HTTP ${response.status}`); continue; }
      if (!response.ok) throw new ReadError("rpc", `HTTP ${response.status}`);
      try { json = await response.json(); } catch (error) { last = new ReadError("network", "the answer was cut short"); continue; }
      const byId = new Map((Array.isArray(json) ? json : [json]).map((r) => [r && r.id, r]));
      const missing = [];
      for (const i of pending) {
        const r = byId.get(i + 1);
        if (!r) throw new ReadError("rpc", `no answer to ${calls[i][0]}`);
        if (r.error && isRateError(r.error)) missing.push(i);
        else if (r.error && options.lenient) results[i] = null;
        else if (r.error) throw new ReadError("rpc", `${calls[i][0]}: ${r.error.message || r.error.code}`);
        else results[i] = r.result;
      }
      if (!missing.length) return results;
      pending = missing;
      last = new ReadError("rate", "too many requests");
    }
    throw last;
  }

  // The leash, the program and the rent in parallel; then every account the leash names.
  async function loadLeash(address, options = {}) {
    const base64 = { encoding: "base64", commitment: "confirmed" };
    const [[first], [rentLeash], [rentEmpty]] = await Promise.all([
      rpc([["getMultipleAccounts", [[address, LEASH_PROGRAM], base64]]], options),
      rpc([["getMinimumBalanceForRentExemption", [LEASH.LEN]]], options),
      rpc([["getMinimumBalanceForRentExemption", [0]]], options),
    ]);
    if (!first.value[0]) throw new ReadError("missing", "nothing at this address");
    const info = readAccount(first.value[0]);
    if (info.owner !== LEASH_PROGRAM) throw new ReadError("notleash", "another program owns this account", { owner: info.owner });
    const leash = decodeLeash(info.data);
    if (!leash) throw new ReadError("notleash", "not laid out as a leash", { owner: info.owner });

    const program = readAccount(first.value[1]);
    const programData = programDataOf(program);
    const wanted = [...new Set([leash.creator, leash.agent, leash.dest[0], leash.dest[1], FALLBACK_PAYER, programData].filter(Boolean))];
    // 300 bytes is enough for a rules account and for the head of the program's data.
    const [others] = await rpc([["getMultipleAccounts", [wanted, { ...base64, dataSlice: { offset: 0, length: 300 } }]]], options);
    const accounts = {};
    wanted.forEach((key, i) => { accounts[key] = readAccount(others.value[i]); });
    return buildView({
      address, info, accounts,
      rent: { leash: rentLeash, empty: rentEmpty },
      program: decodeUpgrade(program, programData ? accounts[programData] : null),
      readAt: Date.now(), slot: first.context.slot,
    });
  }

  async function simulate(v, attempt, options = {}) {
    const [result] = await rpc([["simulateTransaction", [attemptTransaction(v, attempt), { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" }]]], options);
    return { ...readSimulation(result.value, 0), slot: result.context.slot, at: Date.now() };
  }

  const PAGE = 25;
  // Devnet carries transactions in three formats today (legacy, 0 and 1) and the RPC refuses
  // to return one newer than the caller says it knows. Their JSON has one shape; if a later
  // format breaks it, that transaction is listed as unreadable and the rest still loads.
  const TX_OPTIONS = { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 255 };

  // The browser's storage, where there is one. Every use is optional: a private window may
  // refuse it and Node has none, and then the page simply asks devnet again.
  function stored(area, key) {
    try { const raw = root[area] && root[area].getItem(key); return raw ? JSON.parse(raw) : null; } catch (error) { return null; }
  }
  function store(area, key, value) {
    try { if (root[area]) root[area].setItem(key, JSON.stringify(value)); } catch (error) { /* full or refused */ }
  }

  // This page's own tally of getTransaction calls: never more than 9 in 10.5 seconds. It is
  // kept across reloads and tabs, because the RPC counts by IP address, not by page.
  const TX_PACE = { calls: 9, ms: 10500, key: "lure.leash.tx-times" };
  let txTimes = [];

  // How many getTransaction calls may go now. Waits, telling `onPace(ms)`, until at least one may.
  async function txRoom(options) {
    for (;;) {
      const now = Date.now(), saved = stored("localStorage", TX_PACE.key);
      if (Array.isArray(saved) && saved.length > txTimes.length) txTimes = saved.filter((t) => typeof t === "number" && t <= now);
      txTimes = txTimes.filter((t) => now - t < TX_PACE.ms);
      if (txTimes.length < TX_PACE.calls) return TX_PACE.calls - txTimes.length;
      const wait = txTimes[0] + TX_PACE.ms - now + 50;
      if (options.onPace) options.onPace(wait);
      await sleep(wait);
      if (options.stop && options.stop()) return 0;
    }
  }

  // A finalized transaction never changes, so what was read once is kept for the visit: only
  // the fields `describeTransaction` reads, or a bare `{ skip: true }` for one that only read the leash.
  const txKey = (signature) => `lure.leash.tx.${signature}`;
  const slimTransaction = (tx) => ({
    slot: tx.slot, blockTime: tx.blockTime,
    meta: { err: tx.meta.err, preBalances: tx.meta.preBalances, postBalances: tx.meta.postBalances, innerInstructions: tx.meta.innerInstructions, loadedAddresses: tx.meta.loadedAddresses },
    transaction: { signatures: tx.transaction.signatures.slice(0, 1), message: { accountKeys: tx.transaction.message.accountKeys, instructions: tx.transaction.message.instructions } },
  });

  const newHistory = (address) => ({ address, queue: [], before: undefined, end: false, entries: [], scanned: 0 });
  const historyDone = (h) => h.end && !h.queue.length;

  /* Reads further back until `want` more entries are known, the history ends, or `maxScan`
   * transactions were looked at in this call. A token's trades also name its leash (the hook
   * reads it), so on a busy token most of what is scanned is skipped. It goes at the RPC's
   * pace: about nine transactions every ten seconds.
   *   options.onProgress(h)  after each batch     options.onPace(ms)  before each wait for room
   *   options.stop()         return true to give up between batches
   * Returns how many entries were added.
   */
  async function readHistory(h, options = {}) {
    const want = options.want || PAGE, maxScan = options.maxScan || 45, started = h.entries.length;
    const stopped = () => !!(options.stop && options.stop());
    const known = (s) => stored("sessionStorage", txKey(s.signature));
    let scanned = 0;
    while (h.entries.length - started < want && scanned < maxScan && !stopped()) {
      if (!h.queue.length) {
        if (h.end) break;
        const [page] = await rpc([["getSignaturesForAddress", [h.address, { limit: 100, before: h.before, commitment: "confirmed" }]]], options);
        if (page.length < 100) h.end = true;
        if (!page.length) break;
        h.before = page[page.length - 1].signature;
        h.queue.push(...page);
      }
      const most = Math.min(want - (h.entries.length - started), maxScan - scanned);
      // Whatever this visit already read comes first and costs nothing.
      let batch = [], txs = [];
      for (const s of h.queue.slice(0, most)) {
        const tx = known(s);
        if (!tx) break;
        batch.push(s);
        txs.push(tx);
      }
      if (!batch.length) {
        const room = await txRoom(options);
        if (!room || stopped()) break;
        for (const s of h.queue.slice(0, Math.min(room, most))) {
          if (known(s)) break;
          batch.push(s);
        }
        try {
          txs = await rpc(batch.map((s) => ["getTransaction", [s.signature, TX_OPTIONS]]), { ...options, lenient: true });
        } finally {
          // Counted when the answer is in, or refused: the RPC counts refusals too.
          const now = Date.now();
          for (let i = 0; i < batch.length; i++) txTimes.push(now);
          store("localStorage", TX_PACE.key, txTimes);
        }
      }
      h.queue.splice(0, batch.length); // only once the batch is in hand, so a failed read can be tried again
      txs.forEach((tx, i) => {
        const s = batch[i];
        const unreadable = () => h.entries.push({ missing: true, signature: s.signature, slot: s.slot, time: s.blockTime ?? null, parts: [], notes: [], failed: null });
        if (!tx) return unreadable();
        let entry = null;
        try { entry = tx.skip ? null : describeTransaction(tx, h.address); } catch (error) { return unreadable(); }
        const listed = !!(entry && entry.parts.length);
        if (listed) h.entries.push(entry);
        if (!tx.skip && s.confirmationStatus === "finalized") store("sessionStorage", txKey(s.signature), listed ? slimTransaction(tx) : { skip: true });
      });
      scanned += batch.length;
      h.scanned += batch.length;
      linkDials(h.entries);
      if (options.onProgress) options.onProgress(h);
    }
    return h.entries.length - started;
  }

  function randomAddress() {
    const bytes = new Uint8Array(32);
    root.crypto.getRandomValues(bytes);
    return b58encode(bytes);
  }

  const api = {
    RPC_URL, DEMO_LEASH, LEASH_PROGRAM, FALLBACK_PAYER, SYSTEM_PROGRAM, MEMO_PROGRAMS, LEASH, LEASH_ERRORS, HOOK_V1, PAGE, TX_OPTIONS,
    b58encode, b58decode, b64encode, b64decode, isAddress, isSignature, esc, shortAddr, fmtInt, fmtSol, fmtSeconds, fmtTime, cleanNote,
    toText, toHtml, decodeLeash, decodeRules, decodeUpgrade, readAccount, buildView, limitSentences,
    toInstruction, compileMessage, unsignedTransaction, attemptTransaction, predict, planAttempts, readSimulation, verdict,
    describeTransaction, linkDials, lastAgent, entrySentence,
    ReadError, rpc, loadLeash, simulate, newHistory, readHistory, historyDone, randomAddress,
  };
  root.LURE_AGENT = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;

  /* ================= The page ================= */

  function boot() {
    const $ = (id) => document.getElementById(id);
    const el = {
      id: $("leash-id"), status: $("leash-status"),
      may: $("may"), limits: $("limits"), baitMay: $("bait-may"),
      brk: $("break"), baitBreak: $("bait-break"), how: $("try-how"), tries: $("tries"), out: $("try-out"),
      did: $("did"), log: $("log"), logState: $("log-state"), more: $("log-more"),
      stamp: $("stamp"), input: $("leash-input"),
    };
    if (Object.values(el).some((node) => !node)) return;

    const reduce = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    const asked = (new URLSearchParams(window.location.search).get("leash") || "").trim();
    const address = asked || DEMO_LEASH;
    const state = { run: 0, view: null, history: null, shown: 0, attempts: [], outsider: null, oldAgent: null, oldKeyKnown: false, busy: false, reading: false };
    const clock = (ms) => new Date(ms).toLocaleTimeString("en-GB", { hour12: false });
    const seconds = (ms) => `${Math.max(1, Math.ceil(ms / 1000))} seconds`;
    const slowDown = (kind, ms) => `${kind === "rate" ? "Devnet asked this browser to slow down" : "Devnet did not answer"}. Asking again in ${seconds(ms)}.`;

    if (asked) el.input.value = asked;
    el.id.innerHTML = isAddress(address) ? `${asked ? "Leash" : "No leash in the link, so this is the demo leash:"} ${toHtml([addr(address)])} on ${CLUSTER}` : "";

    function problem(html) {
      el.status.className = "leash-status is-error";
      el.status.innerHTML = html;
    }

    function readProblem(error) {
      const demo = asked ? ` <a class="linkish" href="agent.html">Open the demo leash</a>` : "";
      if (error instanceof ReadError && error.kind === "missing") return problem(`Nothing lives at this address on ${CLUSTER}. A leash exists from the moment its token is launched.${demo}`);
      if (error instanceof ReadError && error.kind === "notleash") {
        const owner = error.owner === SYSTEM_PROGRAM ? " It is a plain wallet."
          : error.owner && error.owner !== LEASH_PROGRAM ? ` It belongs to the program ${toHtml([addr(error.owner)])}, not to the leash program.`
          : " The leash program owns it, but it is not laid out as a leash this page can read.";
        return problem(`This account is not a leash.${owner}${demo}`);
      }
      const quiet = error instanceof ReadError && (error.kind === "rate" || error.kind === "network");
      problem(`${quiet
        ? "Devnet did not answer. Its public door limits how often one browser may ask; this usually passes within ten seconds."
        : `Devnet answered with an error: ${esc(error && error.message)}.`} Nothing is wrong with the leash.<br><button type="button" class="pill pill-s" id="leash-retry">Try again</button>`);
      $("leash-retry").addEventListener("click", load);
    }

    /* ---- 1. what it may do ---- */
    function renderLimits() {
      const v = state.view, L = v.leash;
      el.baitMay.textContent = L.agent ? "This is all the line I get." : "I was taken off the line. This is what it allowed.";
      el.limits.innerHTML = `
        <div class="card-top">
          <h3>${L.agent ? `Agent ${toHtml([addr(L.agent)])}` : "No agent"}</h3>
          <span class="tag${L.agent ? "" : " tag-muted"}">${L.agent ? (L.locked ? "On the leash, locked" : "On the leash") : "Revoked"}</span>
        </div>
        <ul class="leash-rules">${limitSentences(v, Date.now() / 1000).map((s) => `<li>${toHtml(s)}</li>`).join("")}</ul>`;
      el.may.hidden = false;
    }

    /* ---- 2. try to break it ---- */
    function renderTries() {
      const v = state.view, L = v.leash;
      el.baitBreak.textContent = L.agent ? "Pull as hard as you like." : "My old key still exists. Try it.";
      el.brk.hidden = false;
      if (!L.agent && !state.oldKeyKnown) {
        el.how.textContent = "The agent was revoked. Looking in the history for the key it used.";
        el.tries.innerHTML = "";
        el.out.textContent = "";
        return;
      }
      state.attempts = planAttempts(v, { now: Date.now() / 1000, outsider: state.outsider, oldAgent: state.oldAgent });
      const signer = L.agent ? "the agent's key" : state.oldAgent ? "the agent's old key" : "a stranger's key, because the old agent's key is further back in the history";
      const nothing = L.agent && !state.attempts.some((a) => a.id === "inside") ? " Right now no move is inside the limits: the budget is empty or today's caps are used up." : "";
      el.how.textContent = `Each button builds a real transaction, signed in name only by ${signer}, and asks ${CLUSTER} what the leash program would answer. It is a simulation, run when you press. Nothing is sent.${nothing}`;
      el.tries.innerHTML = state.attempts.map((a, i) => `<button type="button" class="pill pill-s" data-try="${i}">${esc(a.label)}</button>`).join("");
      el.out.textContent = "Press one.";
    }

    // For a revoked leash the buttons wait for the history, which holds the key the agent used.
    function findOldKey(final) {
      if (state.oldKeyKnown || state.view.leash.agent) return;
      const key = lastAgent(state.history.entries);
      if (!key && !final) return;
      state.oldAgent = key;
      state.oldKeyKnown = true;
      renderTries();
    }

    let stampTimer = 0, flashed = false;
    function refuse(pill) {
      const box = pill.getBoundingClientRect(), W = document.documentElement.clientWidth, H = window.innerHeight;
      const clamp = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high));
      el.stamp.textContent = "REFUSED";
      el.stamp.style.left = `${clamp(box.left + box.width / 2, 110, W - 110)}px`;
      el.stamp.style.top = `${clamp(box.top - 46, 70, H - 70)}px`;
      el.stamp.className = "stamp";
      void el.stamp.offsetWidth;
      el.stamp.classList.add("is-on");
      clearTimeout(stampTimer);
      stampTimer = setTimeout(() => el.stamp.classList.replace("is-on", "is-off"), 1500);
      if (flashed || reduce) return;
      flashed = true; // once: for a moment the page is the logo inverted, as on the landing
      document.documentElement.classList.add("is-refused");
      setTimeout(() => document.documentElement.classList.remove("is-refused"), 380);
    }

    el.tries.addEventListener("click", async (event) => {
      const pill = event.target.closest("[data-try]");
      if (!pill || state.busy) return;
      const attempt = state.attempts[Number(pill.dataset.try)], v = state.view, run = state.run;
      if (!attempt) return;
      state.busy = true;
      // The last answer stays, dimmed, until the new one is in: nothing jumps while devnet thinks.
      el.tries.setAttribute("aria-busy", "true");
      el.out.setAttribute("aria-busy", "true");
      try {
        const result = await simulate(v, attempt, { onWait: (kind, ms) => { if (run === state.run) el.out.textContent = slowDown(kind, ms); } });
        if (run !== state.run) return;
        const say = verdict(result, v, attempt);
        pill.classList.remove("is-ok", "is-no");
        pill.classList.add(say.tone === "ok" ? "is-ok" : "is-no");
        el.out.innerHTML = `<span class="${say.tone}">${esc(say.head)}</span> ${toHtml(say.body)}
          <span class="leash-line">${toHtml(attempt.what)}</span>
          <span class="leash-line">Simulated on ${CLUSTER} at ${esc(clock(result.at))}, slot ${esc(fmtInt(result.slot))}. Nothing was sent.</span>`;
        if (result.by === "leash") refuse(pill);
      } catch (error) {
        if (run !== state.run) return;
        const why = error instanceof ReadError && error.kind === "rpc" ? `: ${esc(error.message)}` : ", most likely because it limits how often one browser may ask";
        el.out.innerHTML = `<span class="no">No answer.</span> Devnet did not run the simulation${why}. Press again in a few seconds.`;
      } finally {
        state.busy = false;
        el.tries.removeAttribute("aria-busy");
        el.out.removeAttribute("aria-busy");
      }
    });

    /* ---- 3. what it did ---- */
    function renderLog() {
      const v = state.view, h = state.history;
      el.log.innerHTML = h.entries.slice(0, state.shown).map((e) => {
        const when = fmtTime(e.time);
        const link = isSignature(e.signature)
          ? `<a class="run-detail" href="${esc(txUrl(e.signature))}" target="_blank" rel="noopener" title="Open the transaction">${esc(when)}</a>`
          : `<span class="run-detail">${esc(when)}</span>`;
        // Only a transaction the agent signed carries the agent's own words.
        const notes = e.notes.map((n) => `<span class="leash-note${e.byAgent ? "" : " is-other"}">${e.byAgent ? "" : "Note sent with it: "}${toHtml([quote(n)])}</span>`).join("");
        return `<li class="${e.failed || e.missing ? "is-no" : "is-ok"}"><span class="run-text">${toHtml(entrySentence(e, v))}${notes}</span>${link}</li>`;
      }).join("");
      if (state.reading) { el.logState.textContent = ""; return; }
      const done = historyDone(h) && state.shown >= h.entries.length;
      const oldest = h.entries[h.entries.length - 1];
      const skipped = h.scanned - h.entries.length;
      el.more.hidden = done;
      el.more.disabled = false;
      el.more.textContent = "More";
      el.logState.textContent = !h.entries.length && done ? "Devnet has no transaction for this leash."
        : done ? (oldest.parts.some((p) => p.kind === "init") ? "That is the whole history, back to the launch." : "That is everything devnet still has for this leash.")
        : skipped > 0 ? `${fmtInt(skipped)} transactions that only read the leash were skipped: every trade of the token does that.`
        : "";
    }

    // Shows up to 25 more, as they come: the public RPC hands out about ten transactions every ten seconds.
    async function more() {
      if (state.reading || !state.history) return;
      const h = state.history, run = state.run, target = state.shown + PAGE;
      const alive = () => run === state.run;
      const show = () => { state.shown = Math.min(h.entries.length, target); renderLog(); findOldKey(false); };
      state.reading = true;
      el.did.hidden = false;
      el.more.hidden = false;
      el.more.disabled = true;
      el.more.textContent = "Reading…";
      let failed = null;
      try {
        show();
        if (h.entries.length < target && !historyDone(h)) {
          await readHistory(h, {
            want: target - h.entries.length,
            stop: () => !alive(),
            onProgress: () => { if (alive()) show(); },
            onPace: (ms) => { if (alive()) el.logState.textContent = `Devnet's public door hands out about ten transactions every ten seconds. The next ones come in ${seconds(ms)}.`; },
            onWait: (kind, ms) => { if (alive()) el.logState.textContent = slowDown(kind, ms); },
          });
        }
      } catch (error) { failed = error; }
      if (!alive()) return;
      state.reading = false;
      show();
      findOldKey(true);
      if (failed) {
        el.more.hidden = false;
        el.more.textContent = "Try again";
        el.logState.textContent = failed instanceof ReadError && failed.kind === "rpc"
          ? `Devnet answered with an error: ${failed.message}.`
          : "Devnet did not hand over the rest. Its public door limits how often one browser may ask.";
      }
    }
    el.more.addEventListener("click", more);

    async function load() {
      const run = ++state.run;
      Object.assign(state, { view: null, history: null, shown: 0, attempts: [], oldAgent: null, oldKeyKnown: false, busy: false, reading: false });
      el.status.className = "leash-status";
      el.status.textContent = `Reading the leash from ${CLUSTER}…`;
      el.may.hidden = el.brk.hidden = el.did.hidden = true;
      el.log.innerHTML = "";
      let v;
      try {
        v = await loadLeash(address, { onWait: (kind, ms) => { if (run === state.run) el.status.textContent = slowDown(kind, ms); } });
      } catch (error) {
        if (run === state.run) readProblem(error);
        return;
      }
      if (run !== state.run) return;
      if (!v) return readProblem(new ReadError("notleash", "not laid out as a leash"));
      state.view = v;
      state.outsider = state.outsider || randomAddress();
      state.history = newHistory(address);
      el.status.innerHTML = `Read from ${CLUSTER} at ${esc(clock(v.readAt))}, slot ${esc(fmtInt(v.slot))}. <button type="button" class="linkish" id="leash-again">Read again</button>`;
      $("leash-again").addEventListener("click", load);
      renderLimits();
      renderTries();
      await more();
    }

    if (!isAddress(address)) {
      problem(`That is not a Solana address. A leash address is 32 to 44 letters and digits. <a class="linkish" href="agent.html">Open the demo leash</a>`);
      return;
    }
    load();
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
    else boot();
  }
})(typeof window !== "undefined" ? window : globalThis);
