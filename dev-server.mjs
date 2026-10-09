// Local preview: node dev-server.mjs
//
// Serves the repo root, and answers /api/metadata by running api/metadata.js itself, the
// function Vercel runs for the live site. Uploads need the Pinata key in the environment:
//
//   node dev-server.mjs                      no key: the function answers "not-configured"
//   PINATA_JWT=<key> node dev-server.mjs     real uploads, to the real Pinata account
//   PINATA_STUB=1 node dev-server.mjs        no key and no network: Pinata's answers are made up
//
// A file named .env beside this one (git ignores it) may hold PINATA_JWT=<key> instead.
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT) || 5173;
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

try { process.loadEnvFile(join(root, ".env")); } catch { /* no .env file: the environment is what it is */ }
if (process.env.PINATA_STUB) stubPinata();
const metadata = createRequire(import.meta.url)("./api/metadata.js");

/* Stands in for Pinata's upload endpoint, so the launch form can be tried with no account.
 * It answers in the shape of the real one and gives each file the CID it would really get as
 * a single block. Nothing is pinned: the links the function returns will not open. */
function stubPinata() {
  process.env.PINATA_JWT = "stub";
  const real = globalThis.fetch;
  const base32 = (bytes) => {
    const letters = "abcdefghijklmnopqrstuvwxyz234567";
    let out = "", bits = 0, value = 0;
    for (const byte of bytes) {
      value = ((value << 8) | byte) & 0xffff;
      bits += 8;
      while (bits >= 5) { out += letters[(value >>> (bits - 5)) & 31]; bits -= 5; }
    }
    return bits ? out + letters[(value << (5 - bits)) & 31] : out;
  };
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith("https://uploads.pinata.cloud/")) return real(url, init);
    const file = init.body.get("file");
    const bytes = Buffer.from(await file.arrayBuffer());
    // CID version 1, raw block, sha2-256.
    const cid = `b${base32(Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), createHash("sha256").update(bytes).digest()]))}`;
    console.log(`  stub: ${init.method} ${url}  network=${init.body.get("network")} name=${init.body.get("name")} file=${file.type}, ${bytes.length} bytes -> ${cid}`);
    if (file.type === "application/json") console.log(`  stub: ${bytes.toString("utf8")}`);
    return Response.json({ data: { id: randomUUID(), name: init.body.get("name"), cid, size: bytes.length, number_of_files: 1, mime_type: file.type, group_id: null, is_duplicate: false } });
  };
}

createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://x").pathname;
  if (pathname === "/api/metadata") return metadata(req, res);
  const path = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
  const file = join(root, path || "index.html");
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
}).listen(port, () => {
  const uploads = process.env.PINATA_STUB ? "stubbed, nothing is pinned" : process.env.PINATA_JWT ? "on, with the key from the environment" : "not configured";
  console.log(`Lure site on http://localhost:${port}  (uploads: ${uploads})`);
});
