// Walks one leash through its whole life on devnet, with real transactions.
// It doubles as a client example: every instruction the program has is built here.
//
//   npm install
//   KEYPAIR=~/.config/solana/id.json node devnet-smoke.mjs
//
// The keypair is the creator and pays every fee; the run costs about 0.015 devnet SOL.

import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const PROGRAM = new PublicKey(process.env.LEASH_PROGRAM ?? "GrojbAndyBXQTo5GxgqXAmDDKjDWkPBPeGniBEQsa89p");
const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const KEYPAIR = (process.env.KEYPAIR ?? "~/.config/solana/id.json").replace(/^~/, homedir());

const TAG = { init: 0, spend: 1, reward: 2, setParam: 3, setAgent: 4, sweep: 5 };
const ERROR = ["NotAgent", "NotCreator", "BadDestination", "OverActionCap", "OverDailyCap", "OverBudget", "BadParam",
  "ParamOutOfBounds", "ParamStepTooBig", "ParamCooldown", "AgentLocked", "NotRevoked", "BadConfig", "ZeroAmount"];
const LEASH_LEN = 432;
const PARAMS_OFFSET = 240;
const NOBODY = new PublicKey(new Uint8Array(32));

const sol = (n) => Math.round(n * LAMPORTS_PER_SOL);
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const i64 = (n) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
const meta = (pubkey, { signer = false, writable = false } = {}) => ({ pubkey, isSigner: signer, isWritable: writable });
const ix = (keys, ...data) => new TransactionInstruction({ programId: PROGRAM, keys, data: Buffer.concat(data) });

const leashAddress = (mint, creator) =>
  PublicKey.findProgramAddressSync([Buffer.from("leash"), mint.toBuffer(), creator.toBuffer()], PROGRAM);

/* ---------------- One builder per instruction ---------------- */

function init({ creator, leash, bump, mint, agent, dest, caps, params, flags = 0 }) {
  return ix(
    [meta(creator, { signer: true, writable: true }), meta(leash, { writable: true }), meta(SystemProgram.programId)],
    Buffer.from([TAG.init, bump, flags, params.length]),
    mint.toBuffer(), agent.toBuffer(), dest[0].toBuffer(), dest[1].toBuffer(),
    u64(caps.perSpend), u64(caps.perDay), u64(caps.perReward), u64(caps.rewardPerDay),
    ...params.flatMap((p) => [i64(p.value), i64(p.min), i64(p.max), u64(p.maxStep), i64(p.cooldown)]),
  );
}

const spend = ({ agent, leash, to, index, amount }) =>
  ix([meta(agent, { signer: true }), meta(leash, { writable: true }), meta(to, { writable: true })],
    Buffer.from([TAG.spend, index]), u64(amount));

const reward = ({ agent, leash, to, amount }) =>
  ix([meta(agent, { signer: true }), meta(leash, { writable: true }), meta(to, { writable: true })],
    Buffer.from([TAG.reward]), u64(amount));

const setParam = ({ agent, leash, index, value }) =>
  ix([meta(agent, { signer: true }), meta(leash, { writable: true })], Buffer.from([TAG.setParam, index]), i64(value));

const setAgent = ({ creator, leash, newAgent }) =>
  ix([meta(creator, { signer: true }), meta(leash, { writable: true })], Buffer.from([TAG.setAgent]), newAgent.toBuffer());

const sweep = ({ leash, to }) =>
  ix([meta(leash, { writable: true }), meta(to, { writable: true })], Buffer.from([TAG.sweep]));

/* ---------------- The run ---------------- */

const connection = new Connection(RPC_URL, "confirmed");
const creator = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEYPAIR, "utf8"))));
const [agent, stranger] = [Keypair.generate(), Keypair.generate()];
const [mint, pot, buyback, holder] = [1, 2, 3, 4].map(() => Keypair.generate().publicKey);
const [leash, bump] = leashAddress(mint, creator.publicKey);

let step = 0;
const balance = (address) => connection.getBalance(address, "confirmed");

async function send(label, instruction, signers = []) {
  const signature = await sendAndConfirmTransaction(connection, new Transaction().add(instruction), [creator, ...signers]);
  console.log(`${String(++step).padStart(2)}. ok       ${label}\n             ${signature}`);
}

// The cluster simulates before sending, so a refused transaction costs nothing.
async function refused(label, expected, instruction, signers = []) {
  try {
    await sendAndConfirmTransaction(connection, new Transaction().add(instruction), [creator, ...signers]);
  } catch (error) {
    const code = /custom program error: 0x([0-9a-f]+)/i.exec(`${error.message} ${(error.logs ?? []).join(" ")}`);
    const name = code ? ERROR[parseInt(code[1], 16)] : null;
    if (name !== expected) throw new Error(`"${label}" failed with ${name ?? error.message}, expected ${expected}`);
    console.log(`${String(++step).padStart(2)}. refused  ${label}  (${name})`);
    return;
  }
  throw new Error(`"${label}" went through, but the leash should have refused it with ${expected}`);
}

function check(label, actual, expected) {
  if (actual !== expected) throw new Error(`${label}: got ${actual}, expected ${expected}`);
  console.log(`    check    ${label} = ${actual}`);
}

console.log(`program  ${PROGRAM}\ncreator  ${creator.publicKey}\nagent    ${agent.publicKey}\nleash    ${leash}\n`);

// The agent may feed the pot and the buyback, hand out small rewards, and move one
// parameter between 300 and 1800 in steps of 300. No cooldown, so the run doesn't wait.
await send("init", init({
  creator: creator.publicKey, leash, bump, mint, agent: agent.publicKey, dest: [pot, buyback],
  caps: { perSpend: sol(0.002), perDay: sol(0.004), perReward: sol(0.001), rewardPerDay: sol(0.001) },
  params: [{ value: 600, min: 300, max: 1800, maxStep: 300, cooldown: 0 }],
}));
const reserve = await balance(leash);
check("leash size", (await connection.getAccountInfo(leash)).data.length, LEASH_LEN);

await send("fund the leash with 0.01 SOL", SystemProgram.transfer({ fromPubkey: creator.publicKey, toPubkey: leash, lamports: sol(0.01) }));

const base = { agent: agent.publicKey, leash };
await send("agent sends 0.002 SOL to the pot", spend({ ...base, to: pot, index: 0, amount: sol(0.002) }), [agent]);
check("pot balance", await balance(pot), sol(0.002));
await refused("agent sends 0.003 SOL at once", "OverActionCap", spend({ ...base, to: pot, index: 0, amount: sol(0.003) }), [agent]);
await refused("agent sends to its own wallet", "BadDestination", spend({ ...base, to: agent.publicKey, index: 0, amount: sol(0.001) }), [agent]);
await refused("a stranger spends", "NotAgent", spend({ agent: stranger.publicKey, leash, to: pot, index: 0, amount: sol(0.001) }), [stranger]);
await send("agent sends 0.002 SOL to the buyback", spend({ ...base, to: buyback, index: 1, amount: sol(0.002) }), [agent]);
await refused("agent goes over the daily cap", "OverDailyCap", spend({ ...base, to: pot, index: 0, amount: sol(0.001) }), [agent]);

await send("agent rewards a holder with 0.001 SOL", reward({ ...base, to: holder, amount: sol(0.001) }), [agent]);
await refused("agent rewards again the same day", "OverDailyCap", reward({ ...base, to: holder, amount: sol(0.001) }), [agent]);

await send("agent moves the parameter 600 -> 900", setParam({ ...base, index: 0, value: 900 }), [agent]);
await refused("agent jumps the parameter to 1500", "ParamStepTooBig", setParam({ ...base, index: 0, value: 1500 }), [agent]);
await refused("agent pushes the parameter to 2000", "ParamOutOfBounds", setParam({ ...base, index: 0, value: 2000 }), [agent]);
const stored = (await connection.getAccountInfo(leash)).data.readBigInt64LE(PARAMS_OFFSET);
check("parameter on-chain", Number(stored), 900);

await refused("agent swaps itself in as agent", "NotCreator", setAgent({ creator: agent.publicKey, leash, newAgent: agent.publicKey }), [agent]);
await refused("sweep while the agent is in place", "NotRevoked", sweep({ leash, to: pot }));
await send("creator revokes the agent", setAgent({ creator: creator.publicKey, leash, newAgent: NOBODY }));
await refused("revoked agent spends", "NotAgent", spend({ ...base, to: pot, index: 0, amount: sol(0.001) }), [agent]);
await refused("sweep to the creator", "BadDestination", sweep({ leash, to: creator.publicKey }));
await send("sweep what is left to the pot", sweep({ leash, to: pot }));

check("leash balance (rent reserve only)", await balance(leash), reserve);
check("pot balance", await balance(pot), sol(0.002) + sol(0.01 - 0.002 - 0.002 - 0.001));
check("buyback balance", await balance(buyback), sol(0.002));
check("holder balance", await balance(holder), sol(0.001));
console.log(`\nAll ${step} steps behaved as the leash says. https://explorer.solana.com/address/${leash}?cluster=devnet`);
