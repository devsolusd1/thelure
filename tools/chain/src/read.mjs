// Reading: one token in full, the board, a wallet's balances.

import { deriveDbcPoolAddress, getPriceFromSqrtPrice } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { getAssociatedTokenAddressSync, NATIVE_MINT } from "@solana/spl-token";
import {
  cached, clockOf, CLOCK_SYSVAR, DBC_PROGRAM, DECIMALS, decodeLeash, decodeMint, decodeRules, hookProgram, key, leashProgram,
  LureError, meteora, need, net, poolAuthority, readAccounts, rentFor, RULES, rulesAddress, sol, SUPPLY, TOKEN_2022, tokens,
} from "./core.mjs";
import { metadataFromUri } from "./meta.mjs";

const CURVES = ["graduating", "infinite"];

/* ---------------- The two Lure curves ---------------- */

/** The two Meteora configs of net.js, decoded. They never change, so they are read once. */
export function loadConfigs() {
  const { configs } = need("rpcUrl", "configs", "hookProgram");
  return cached(`configs:${configs.graduating}:${configs.infinite}`, Infinity, async () => {
    const { program } = meteora();
    const addresses = CURVES.map((curve) => key(configs[curve], `${curve} config`));
    const { accounts } = await readAccounts(addresses);
    return CURVES.map((curve, i) => {
      const account = accounts[i];
      if (!account || !account.owner.equals(DBC_PROGRAM)) {
        throw new LureError("bad-config", `net.js names ${configs[curve]} as the ${curve} curve's config, but no Meteora config lives there on ${net().cluster}.`);
      }
      let stored;
      try {
        stored = program.coder.accounts.decode("configWithTransferHook", account.data);
      } catch {
        throw new LureError("bad-config", `The ${curve} config in net.js is not a Meteora config for hook tokens.`);
      }
      if (!stored.transferHookProgram.equals(hookProgram())) {
        throw new LureError("bad-config", `The ${curve} config in net.js is for another hook program (${stored.transferHookProgram.toBase58()}).`);
      }
      return { curve, address: addresses[i], state: stored.config };
    });
  });
}

/* ---------------- Shaping what was read ---------------- */

const share = (base) => Number(base) / Number(SUPPLY);

// Everything the site says about a token, from the accounts as read. `leash` may be missing
// (the board does not read leashes): numbers that live there are then null.
function shape({ mint, mintAccount, pool, poolAddress, config, rulesAccount, rulesData, leashData, rent, slot, chainTime, readAt }) {
  const { poolState } = pool;
  const info = decodeMint(mintAccount.data);
  const price = Number(getPriceFromSqrtPrice(poolState.sqrtPrice, DECIMALS, 9).toString());
  const supply = info.supply > 0n ? info.supply : SUPPLY;
  const threshold = config.state.migrationQuoteThreshold;
  const hooked = info.hook === hookProgram().toBase58();
  const graduated = poolState.isMigrated !== 0 || poolState.quoteReserve.gte(threshold) || !hooked;
  const infinite = config.curve === "infinite";

  let rules = null;
  if (rulesData) {
    const r = rulesData;
    const dial = (index) => (index !== RULES.NO_PARAM && leashData && leashData.params[index]) || null;

    // The wallet cap now: fixed at launch, or the leash's value as the hook reads it.
    const capDial = dial(r.capParam);
    const capFromLeash = r.capParam !== RULES.NO_PARAM;
    const capUnits = !capFromLeash ? r.maxPerWallet : capDial ? (capDial.value < 0n ? 1n : capDial.value) : null;
    const cap = capUnits === null ? { tokens: null, share: null, fromLeash: true }
      : capUnits === 0n ? null
      : { tokens: tokens(capUnits), share: share(capUnits), fromLeash: capFromLeash };

    // Rust guard_is_up: the window opens with the first buy from the curve.
    const opened = r.blockSlot !== 0n;
    const elapsed = BigInt(slot) > r.launchSlot ? BigInt(slot) - r.launchSlot : 0n;
    const guardUp = r.blockLimit !== 0n && (r.guardSlots === 0n || !opened || elapsed < r.guardSlots);
    const blockLimit = r.blockLimit === 0n ? null : {
      tokens: tokens(r.blockLimit), share: share(r.blockLimit),
      guardSlots: Number(r.guardSlots), forever: r.guardSlots === 0n, up: guardUp, opened,
      slotsLeft: guardUp && opened && r.guardSlots !== 0n ? Number(r.guardSlots - elapsed) : null,
      boughtThisBlock: r.blockSlot === BigInt(slot) ? tokens(r.blockBought) : 0,
    };

    let game = null;
    if (r.gameOn) {
      const timerDial = dial(r.timerParam);
      const clockFromLeash = r.timerParam !== RULES.NO_PARAM;
      const clamp = (n) => Math.min(Math.max(Number(n), 1), RULES.MAX_TIMER);
      const clock = !clockFromLeash ? Number(r.timer) : timerDial ? clamp(timerDial.value) : null;
      const deadline = Number(r.deadline);
      const over = deadline !== 0 && chainTime >= deadline;
      game = {
        pot: sol(rulesAccount.lamports > rent ? rulesAccount.lamports - rent : 0),
        // guard: buys do not play yet. waiting: no buy has counted in this round. running. over: waiting to be paid.
        phase: over ? "over" : deadline !== 0 ? "running" : guardUp ? "guard" : "waiting",
        deadline,
        endsIn: deadline !== 0 && !over ? deadline - chainTime : null,
        round: Number(r.round) + 1,
        lastBuyer: r.lastBuyer,
        lastWinner: r.lastWinner,
        lastPrize: sol(r.lastPrize),
        totalPaid: sol(r.totalPaid),
        minBuy: tokens(r.minBuy),
        clock,
        clockFromLeash,
        clockRange: timerDial ? { min: clamp(timerDial.min), max: clamp(timerDial.max) } : null,
      };
    }

    rules = {
      address: rulesAddress(mint)[0].toBase58(),
      version: r.version,
      // Rules that name any other owner treat every trade as a plain transfer.
      curveOk: r.exemptOwner === poolAuthority().toBase58(),
      cap, blockLimit, game,
      transfers: Number(r.transfers),
    };
  }

  // What is known of the metadata at this moment, without asking anyone: reading a token never
  // waits for the file its uri names (see meta.mjs).
  const meta = metadataFromUri(info.uri);
  return {
    mint: mint.toBase58(),
    name: info.name, symbol: info.symbol, decimals: info.decimals, uri: info.uri,
    description: meta.description, image: meta.image,
    supply: tokens(supply),
    pool: poolAddress.toBase58(),
    config: config.address.toBase58(),
    curve: config.curve,
    creator: poolState.creator.toBase58(),
    createdSlot: Number(poolState.activationPoint.toString()),
    price,
    marketCap: price * tokens(supply),
    solInCurve: sol(poolState.quoteReserve.toString()),
    supplyLeft: Number(poolState.baseReserve.toString()) / Number(supply),
    // A graduating curve: how far it is, and what it takes. null on a curve that never graduates.
    progress: infinite ? null : Math.min(1, Number(poolState.quoteReserve.toString()) / Number(threshold.toString())),
    graduation: infinite ? null : {
      sol: sol(threshold.toString()),
      marketCap: Number(getPriceFromSqrtPrice(config.state.migrationSqrtPrice, DECIMALS, 9).toString()) * tokens(supply),
    },
    graduated,
    hooked,
    rules,
    leash: rulesData ? rulesData.leash : null,
    agent: leashData ? leashData.agent : null,
    slot, chainTime, readAt,
    // Seconds to add to this device's clock to get the chain's: a countdown ticks on chain time.
    clockSkew: chainTime - Math.floor(readAt / 1000),
  };
}

/* ---------------- One token ---------------- */

// What quotes and builders need beyond the public shape: the decoded pool and config.
const internals = new Map();
// A token's leash never changes, so once known it rides along in the same read.
const leashOf = new Map();

async function readTokenNow(mintAddress) {
  const mint = key(mintAddress, "token");
  const configs = await loadConfigs();
  const { program } = meteora();
  const id = mint.toBase58();
  const pools = configs.map((config) => deriveDbcPoolAddress(NATIVE_MINT, mint, config.address));
  const [rulesKey] = rulesAddress(mint);
  const knownLeash = leashOf.get(id);
  const keys = [mint, rulesKey, CLOCK_SYSVAR, ...pools, ...(knownLeash ? [key(knownLeash)] : [])];
  const [{ slot, accounts }, rent] = await Promise.all([readAccounts(keys), rentFor(RULES.LEN)]);
  const readAt = Date.now();
  const [mintAccount, rulesAccount, clockAccount] = accounts;

  if (!mintAccount) throw new LureError("not-found", `No token lives at this address on ${net().cluster}.`);
  if (!mintAccount.owner.equals(TOKEN_2022)) throw new LureError("not-lure", "This is not a Lure token: it is not a Token-2022 mint.");
  const at = pools.findIndex((_, i) => accounts[3 + i] && accounts[3 + i].owner.equals(DBC_PROGRAM));
  if (at < 0) throw new LureError("not-lure", "This token was not launched on a Lure curve.");
  let pool;
  try {
    pool = program.coder.accounts.decode("transferHookPool", accounts[3 + at].data);
  } catch {
    throw new LureError("not-lure", "This token's pool is not a hook pool.");
  }

  const rulesData = rulesAccount && rulesAccount.owner.equals(hookProgram()) ? decodeRules(rulesAccount.data) : null;
  let leashData = null;
  if (rulesData && rulesData.leash) {
    let leashAccount = knownLeash === rulesData.leash ? accounts[3 + pools.length] : null;
    if (!leashAccount) leashAccount = (await readAccounts([key(rulesData.leash)])).accounts[0];
    leashOf.set(id, rulesData.leash);
    if (leashAccount && leashAccount.owner.equals(leashProgram())) leashData = decodeLeash(leashAccount.data);
  }

  const chainTime = clockOf(clockAccount);
  const token = shape({ mint, mintAccount, pool, poolAddress: pools[at], config: configs[at], rulesAccount, rulesData, leashData, rent, slot, chainTime, readAt });
  internals.set(id, { token, pool, config: configs[at], poolAddress: pools[at], rulesData, slot });
  return token;
}

/**
 * One token, in full. Answers from memory when the last read is younger than `maxAge` ms, so
 * a page may call it as often as it likes: one RPC call per read, at most.
 */
export function readToken(mint, { maxAge = 4000 } = {}) {
  const id = key(mint, "token").toBase58();
  return cached(`token:${id}`, maxAge, () => readTokenNow(id));
}

/** The token with the decoded pool and config behind it, for quotes and builders. */
export async function readTokenDeep(mint, options) {
  const token = await readToken(mint, options);
  return internals.get(token.mint);
}

/* ---------------- The board ---------------- */

/**
 * Every token launched under the two Lure configs, newest first, each in the same shape as
 * readToken (numbers that live in a leash are null: the board does not read leashes).
 * Three RPC calls for up to 49 tokens, kept for `maxAge` ms.
 */
export function listTokens({ maxAge = 10_000 } = {}) {
  need("rpcUrl", "configs", "hookProgram");
  return cached("board", maxAge, async () => {
    const configs = await loadConfigs();
    const { conn, program } = meteora();
    const kind = program.coder.accounts.memcmp("transferHookPool");
    const found = [];
    for (const config of configs) {
      const rows = await conn.getProgramAccounts(DBC_PROGRAM, {
        filters: [{ memcmp: { offset: kind.offset ?? 0, bytes: kind.bytes } }, { memcmp: { offset: 72, bytes: config.address.toBase58() } }],
      });
      for (const row of rows) {
        try {
          found.push({ config, poolAddress: row.pubkey, pool: program.coder.accounts.decode("transferHookPool", row.account.data) });
        } catch { /* not a pool this site can read */ }
      }
    }
    if (!found.length) return [];
    const keys = [CLOCK_SYSVAR];
    for (const { pool } of found) keys.push(pool.poolState.baseMint, rulesAddress(pool.poolState.baseMint)[0]);
    const [{ slot, accounts }, rent] = await Promise.all([readAccounts(keys), rentFor(RULES.LEN)]);
    const readAt = Date.now();
    const chainTime = clockOf(accounts[0]);
    const out = [];
    found.forEach((entry, i) => {
      const mintAccount = accounts[1 + 2 * i], rulesAccount = accounts[2 + 2 * i];
      if (!mintAccount || !mintAccount.owner.equals(TOKEN_2022)) return;
      const rulesData = rulesAccount && rulesAccount.owner.equals(hookProgram()) ? decodeRules(rulesAccount.data) : null;
      out.push(shape({ mint: entry.pool.poolState.baseMint, mintAccount, pool: entry.pool, poolAddress: entry.poolAddress, config: entry.config, rulesAccount, rulesData, leashData: null, rent, slot, chainTime, readAt }));
    });
    return out.sort((a, b) => b.createdSlot - a.createdSlot);
  });
}

/* ---------------- The programs themselves ---------------- */

/**
 * Whether one of the two Lure programs can still be changed: { address, upgradeable, authority }.
 * `which` is "hook" or "leash". Read once (two small calls); `upgradeable` is null if the
 * cluster's answer could not be read.
 */
export function programStatus(which = "hook") {
  const address = which === "leash" ? leashProgram() : hookProgram();
  return cached(`program:${address.toBase58()}`, Infinity, async () => {
    const unknown = { address: address.toBase58(), upgradeable: null, authority: null };
    const { conn } = meteora();
    const program = await conn.getAccountInfo(address);
    // An upgradeable program's account: tag 2, then the address of its data.
    if (!program || program.data.length < 36 || program.data[0] !== 2) return unknown;
    const data = await conn.getAccountInfo(key(program.data.subarray(4, 36)), { dataSlice: { offset: 0, length: 45 } });
    // Its data: tag 3, the slot of the last deploy, then the upgrade authority if there still is one.
    if (!data || data.data.length < 13 || data.data[0] !== 3) return unknown;
    const has = data.data[12] === 1 && data.data.length >= 45;
    return { address: address.toBase58(), upgradeable: has, authority: has ? key(data.data.subarray(13, 45)).toBase58() : null };
  });
}

/* ---------------- A wallet ---------------- */

/** What a wallet holds: SOL, and this token. One RPC call, kept for `maxAge` ms. */
export function readWallet(owner, mint, { maxAge = 3000 } = {}) {
  const ownerKey = key(owner, "wallet"), mintKey = key(mint, "token");
  return cached(`wallet:${ownerKey.toBase58()}:${mintKey.toBase58()}`, maxAge, async () => {
    const account = getAssociatedTokenAddressSync(mintKey, ownerKey, true, TOKEN_2022);
    const { accounts } = await readAccounts([ownerKey, account]);
    const held = accounts[1] && accounts[1].owner.equals(TOKEN_2022) && accounts[1].data.length >= 72
      ? new DataView(accounts[1].data.buffer, accounts[1].data.byteOffset, accounts[1].data.byteLength).getBigUint64(64, true) : 0n;
    return {
      address: ownerKey.toBase58(),
      sol: sol(accounts[0] ? accounts[0].lamports : 0),
      tokens: tokens(held),
      tokensRaw: held.toString(),
      tokenAccount: account.toBase58(),
      hasTokenAccount: !!accounts[1],
    };
  });
}
