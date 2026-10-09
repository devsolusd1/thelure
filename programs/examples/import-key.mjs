// Turns a wallet's private key, as a wallet app exports it, into the key file the Solana
// tools read. It prints the wallet's address and nothing else: never the key.
//
//   node import-key.mjs <file with the exported key> <key file to write> [address it must be]
//
// The exported key may be the base58 text Phantom and Solflare show, or the list of 64
// numbers the Solana tools use. Delete the first file once this has run.

import { Keypair } from "@solana/web3.js";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";

const [from, to, expected] = process.argv.slice(2);
if (!from || !to) {
  console.error("Usage: node import-key.mjs <exported key file> <key file to write> [expected address]");
  process.exit(1);
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(text) {
  let n = 0n;
  for (const c of text) {
    const digit = ALPHABET.indexOf(c);
    if (digit < 0) throw new Error("not base58");
    n = n * 58n + BigInt(digit);
  }
  const bytes = [];
  for (; n > 0n; n >>= 8n) bytes.unshift(Number(n & 0xffn));
  for (const c of text) { if (c !== "1") break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
}

let keypair;
try {
  const text = readFileSync(from, "utf8").trim();
  const secret = text.startsWith("[") ? Uint8Array.from(JSON.parse(text)) : base58(text);
  keypair = secret.length === 32 ? Keypair.fromSeed(secret) : Keypair.fromSecretKey(secret);
} catch {
  // Say nothing about the content: an error message could quote part of the key.
  console.error("That file does not hold a private key I can read (base58 text, or a list of 64 numbers).");
  process.exit(1);
}

const address = keypair.publicKey.toBase58();
if (expected && expected !== address) {
  console.error(`That key is for ${address}, not ${expected}. Nothing was written.`);
  process.exit(1);
}
writeFileSync(to, JSON.stringify([...keypair.secretKey]), { mode: 0o600 });
chmodSync(to, 0o600);
console.log(`Key file written for ${address}. Now delete ${from}.`);
