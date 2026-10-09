// Launches the demo token on devnet: a token on a curve that never graduates, playing Last
// Buyer Wins, with an agent on a leash that can only feed the pot and turn the clock.
//
//   npm install
//   KEYPAIR=~/.config/solana/id.json AGENT_KEYPAIR=~/lure-target/demo-agent.json node demo-token.mjs
//
// The keypair is the creator and pays for everything, about 0.06 devnet SOL: 0.03 of it is
// the agent's budget. The agent's key is created at AGENT_KEYPAIR if the file is not there.
// CONFIG is a Meteora config made by curve-check.mjs; the default is the one already on devnet.
// What it made is written to demo.json, addresses only.

import {
  deriveDbcPoolAddress, deriveDbcPoolAuthority, DynamicBondingCurveClient, SwapMode,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, sendAndConfirmTransaction, SystemProgram, Transaction, TransactionInstruction,
} from "@solana/web3.js";
import BN from "bn.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const HOOK = new PublicKey(process.env.HOOK_PROGRAM ?? "4akkPWLw1imyEhcqAJaHgPPrbDZr6VPaHPifVUV7K5tS");
const LEASH_PROGRAM = new PublicKey(process.env.LEASH_PROGRAM ?? "GrojbAndyBXQTo5GxgqXAmDDKjDWkPBPeGniBEQsa89p");
const CONFIG = new PublicKey(process.env.CONFIG ?? "6BDwLdwv8hdcvEVVvcxZjCzGFWYEB12BxRbNyWJPXTdG");
const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const home = (path) => path.replace(/^~/, homedir());
const KEYPAIR = home(process.env.KEYPAIR ?? "~/.config/solana/id.json");
const AGENT_KEYPAIR = home(process.env.AGENT_KEYPAIR ?? "~/lure-target/demo-agent.json");

const DECIMALS = 6;
const TOKENS = 10n ** BigInt(DECIMALS);
const SUPPLY = 1_000_000_000n * TOKENS;
// The rules of this token.
const MAX_PER_WALLET = SUPPLY / 50n; // 2% of supply
const BLOCK_LIMIT = (SUPPLY * 3n) / 100n; // 3% of supply per block, while the guard is up
const GUARD_SLOTS = 100n; // about 40 seconds from the first buy
const MIN_BUY = 100_000n * TOKENS; // 0.01% of supply: smaller buys do not move the game
const GAME_ON = 1;
const NO_PARAM = 0xff;
// The leash. Dial 0 is the game clock, in seconds.
const CLOCK = { value: 300, min: 120, max: 1800, step: 300, cooldown: 180 };
const MAX_PER_SPEND = 0.005, MAX_PER_DAY = 0.02, BUDGET = 0.03, AGENT_FEES = 0.004;

const connection = new Connection(RPC_URL, "confirmed");
const client = DynamicBondingCurveClient.create(connection, "confirmed");
const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEYPAIR, "utf8"))));
if (!existsSync(AGENT_KEYPAIR)) writeFileSync(AGENT_KEYPAIR, JSON.stringify([...Keypair.generate().secretKey]), { mode: 0o600 });
const agent = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(AGENT_KEYPAIR, "utf8")))).publicKey;

const sol = (n) => Math.round(n * LAMPORTS_PER_SOL);
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const i64 = (n) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
const meta = (pubkey, { signer = false, writable = false } = {}) => ({ pubkey, isSigner: signer, isWritable: writable });
const send = (tx, signers = []) => sendAndConfirmTransaction(connection, tx, [wallet, ...signers]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let step = 0;
const say = (text, signature) => console.log(`\n${++step}. ${text}${signature ? `\n   ${signature}` : ""}`);
function check(label, ok) {
  if (!ok) throw new Error(`FAILED: ${label}`);
  console.log(`   check: ${label}`);
}

const startBalance = await connection.getBalance(wallet.publicKey);
console.log(`hook     ${HOOK}\nleash    ${LEASH_PROGRAM}\ncreator  ${wallet.publicKey}  (${startBalance / LAMPORTS_PER_SOL} SOL)\nagent    ${agent}`);

const mint = Keypair.generate();
const [rules, rulesBump] = PublicKey.findProgramAddressSync([Buffer.from("rules"), mint.publicKey.toBuffer()], HOOK);
const [list, listBump] = PublicKey.findProgramAddressSync([Buffer.from("extra-account-metas"), mint.publicKey.toBuffer()], HOOK);
const [leash, leashBump] = PublicKey.findProgramAddressSync(
  [Buffer.from("leash"), mint.publicKey.toBuffer(), wallet.publicKey.toBuffer()],
  LEASH_PROGRAM,
);
const poolAuthority = deriveDbcPoolAuthority();

/* ---------------- The leash, then the rules that read it ---------------- */

// The agent's SOL can only go to the pot: the token's rules account is its one destination.
// Rewards are off. Its one dial is the game clock.
const initLeash = new TransactionInstruction({
  programId: LEASH_PROGRAM,
  keys: [meta(wallet.publicKey, { signer: true, writable: true }), meta(leash, { writable: true }), meta(SystemProgram.programId)],
  data: Buffer.concat([
    Buffer.from([0, leashBump, 0, 1]),
    mint.publicKey.toBuffer(), agent.toBuffer(), rules.toBuffer(), Buffer.alloc(32),
    u64(sol(MAX_PER_SPEND)), u64(sol(MAX_PER_DAY)), u64(0), u64(0),
    i64(CLOCK.value), i64(CLOCK.min), i64(CLOCK.max), u64(CLOCK.step), i64(CLOCK.cooldown),
  ]),
});

// init checks the leash it names, so the leash has to exist first.
const initRules = new TransactionInstruction({
  programId: HOOK,
  keys: [
    meta(wallet.publicKey, { signer: true, writable: true }),
    meta(mint.publicKey, { signer: true }),
    meta(rules, { writable: true }),
    meta(list, { writable: true }),
    meta(SystemProgram.programId),
    meta(leash),
  ],
  data: Buffer.concat([
    Buffer.from([0, rulesBump, listBump, GAME_ON, NO_PARAM, 0]), // cap fixed, clock from dial 0
    poolAuthority.toBuffer(),
    leash.toBuffer(),
    // The fixed clock stays 0: one number, one source, and this token reads it from the leash.
    u64(MAX_PER_WALLET), u64(GUARD_SLOTS), u64(BLOCK_LIMIT), i64(0), u64(MIN_BUY),
  ]),
});
say(`leash ${leash}\n   rules ${rules}`, await send(new Transaction().add(initLeash, initRules), [mint]));

const poolSig = await send(
  await client.creator.createPoolWithTransferHook({
    baseMint: mint.publicKey,
    config: CONFIG,
    name: "Last Bite",
    symbol: "BITE",
    uri: "https://example.com/last-bite.json",
    payer: wallet.publicKey,
    poolCreator: wallet.publicKey,
    transferHookProgram: HOOK,
  }),
  [mint],
);
const pool = deriveDbcPoolAddress(NATIVE_MINT, mint.publicKey, CONFIG);
say(`pool on a curve that never graduates: ${pool}\n   mint ${mint.publicKey}`, poolSig);

say(
  `agent's budget: ${BUDGET} SOL in the leash, and ${AGENT_FEES} SOL in its own wallet for network fees`,
  await send(new Transaction().add(
    SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: leash, lamports: sol(BUDGET) }),
    SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: agent, lamports: sol(AGENT_FEES) }),
  )),
);

/* ---------------- Two buys: one under the guard, one that plays ---------------- */

const myTokens = getAssociatedTokenAddressSync(mint.publicKey, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID);
const buy = (amount) =>
  client.pool.swap2WithTransferHook({
    owner: wallet.publicKey,
    payer: wallet.publicKey,
    pool,
    swapBaseForQuote: false,
    referralTokenAccount: null,
    swapMode: SwapMode.ExactIn,
    amountIn: new BN(sol(amount)),
    minimumAmountOut: new BN(1),
  });
// The game's part of the rules account (layout 2, see programs/README.md).
async function game() {
  const { data } = await connection.getAccountInfo(rules);
  return {
    transfers: data.readBigUInt64LE(112),
    guardFrom: data.readBigUInt64LE(120),
    deadline: Number(data.readBigInt64LE(176)),
    round: data.readBigUInt64LE(184),
    lastBuyer: new PublicKey(data.subarray(192, 224)),
  };
}

const first = await send(await buy(0.002));
let state = await game();
say("first buy, 0.002 SOL: it opens the guard and is counted against the block limit", first);
check("the hook counted it inside the Meteora swap", state.transfers === 1n);
check("the game has not started: the guard is up", state.deadline === 0);

const guardEnds = Number(state.guardFrom + GUARD_SLOTS);
for (let slot = await connection.getSlot(); slot <= guardEnds; slot = await connection.getSlot()) await sleep(3000);
const second = await send(await buy(0.002));
state = await game();
const clock = state.deadline - Math.round(Date.now() / 1000);
say(`second buy, after the guard: it takes the lead and starts the clock (${clock}s left)`, second);
check("the last buyer is the creator's wallet", state.lastBuyer.equals(wallet.publicKey));
check("the clock was read from the leash: about 300 seconds", clock > 240 && clock <= CLOCK.value);
const held = (await connection.getAccountInfo(myTokens)).data.readBigUInt64LE(64);
check("both buys landed under the 2% wallet cap", held > 0n && held <= MAX_PER_WALLET);

const out = {
  cluster: "devnet", hook: HOOK.toBase58(), leashProgram: LEASH_PROGRAM.toBase58(), config: CONFIG.toBase58(),
  mint: mint.publicKey.toBase58(), pool: pool.toBase58(), rules: rules.toBase58(), leash: leash.toBase58(),
  creator: wallet.publicKey.toBase58(), agent: agent.toBase58(),
};
writeFileSync(new URL("./demo.json", import.meta.url), `${JSON.stringify(out, null, 2)}\n`);
const spent = (startBalance - (await connection.getBalance(wallet.publicKey))) / LAMPORTS_PER_SOL;
console.log(`\nThe demo token is live. Cost: ${spent.toFixed(4)} SOL. Addresses are in demo.json.`);
console.log(`https://explorer.solana.com/address/${pool}?cluster=devnet`);
