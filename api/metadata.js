/* POST /api/metadata
 *
 * Pins a new token's image and its metadata JSON to IPFS through Pinata and answers the link a
 * launch writes into the token:   { uri, image }
 *
 * The request is one JSON object (Content-Type: application/json):
 *   { name, symbol, description, website, twitter, telegram, image: { type, data } | null }
 * `data` is the image file in base64. Everything but name and symbol may be left out.
 *
 * THE KEY. The Pinata key (a JWT) is read from the environment variable PINATA_JWT and from
 * nowhere else. On Vercel: Project > Settings > Environment Variables, name PINATA_JWT, then
 * redeploy. It must never be written in this repo or in any file a browser loads. Without it
 * this function answers 503 { error: "not-configured" } and the launch form falls back.
 * Optional: PINATA_GATEWAY, the host of the account's own gateway (name.mypinata.cloud). The
 * links answered then use it instead of Pinata's public gateway, once it has served the file.
 *
 * Errors are short JSON: 405 post-only, 403 bad-origin, 503 not-configured, 415 json-only,
 * 413 too-large, 400 bad-json, 400 bad-request (+ field, message), 429 slow-down (+ retryAfter),
 * 502 upload-failed (+ step, status: what Pinata answered, 0 when it did not answer).
 *
 * Module style: CommonJS, with Node's own (request, response) signature. This repo has no
 * package.json, so Node reads a .js file as CommonJS, and Vercel runs `module.exports` of a
 * file in /api as a function with no configuration. The same function is what dev-server.mjs
 * calls. It has no dependencies: fetch, FormData and Blob are Node's own (18 and later).
 */
"use strict";

// https://docs.pinata.cloud/api-reference/endpoint/upload-a-file : multipart, fields `file`,
// `network` ("public" here: the default is "private", which no gateway serves) and `name`.
// It answers { data: { id, name, cid, size, mime_type, ... } }.
const PINATA_UPLOAD = "https://uploads.pinata.cloud/v3/files";
// Pinata's public gateway serves any public CID to anyone, with open CORS, and holds what was
// just pinned. ipfs.io and dweb.link stopped serving plain requests in September 2026.
const PUBLIC_GATEWAY = "gateway.pinata.cloud";

// Vercel refuses a request body over 4.5 MB. Base64 makes a file a third bigger, so 2 MB of
// image is 2.7 MB of request.
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_BODY_BYTES = 3 * 1024 * 1024;
const MAX_DESCRIPTION = 1000;
const MAX_LINK = 200;
const PINATA_TIMEOUT_MS = 25000;

const SITES = new Set(["https://lurepad.fun", "https://www.lurepad.fun"]);
const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;
const CID = /^[A-Za-z0-9]{46,128}$/;

class Refusal extends Error {
  constructor(status, body) { super(body.error); this.status = status; this.body = body; }
}
const bad = (field, message) => new Refusal(400, { error: "bad-request", field, message });

function answer(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(JSON.stringify(body));
}

/* ---------------- Who is asking, and how often ---------------- */

// A browser says which page a POST comes from, and other sites' pages are turned away here.
// A script can claim any origin: what bounds it is the limit below and the size caps.
const fromSite = (origin) => typeof origin === "string" && (SITES.has(origin) || LOCAL.test(origin));

function callerOf(req) {
  const forwarded = String(req.headers["x-real-ip"] || req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || (req.socket && req.socket.remoteAddress) || "unknown";
}

/* Uploads per caller. BEST-EFFORT ONLY: this memory belongs to one running instance of the
 * function. Vercel may run several at once and starts each one empty, so a determined caller
 * gets more than this. It stops one visitor from pinning hundreds of files a minute through
 * one instance, and nothing more. */
const PER_MINUTE = 8, PER_HOUR = 40;
const MINUTE = 60 * 1000, HOUR = 60 * MINUTE;
const seen = new Map(); // caller -> the times of its uploads in the last hour

/** Seconds this caller has to wait, or 0 after counting one more upload for it. */
function mustWait(caller, now) {
  const times = (seen.get(caller) || []).filter((t) => now - t < HOUR);
  const recent = times.filter((t) => now - t < MINUTE);
  let wait = 0;
  if (recent.length >= PER_MINUTE) wait = MINUTE - (now - recent[0]);
  else if (times.length >= PER_HOUR) wait = HOUR - (now - times[0]);
  else times.push(now);
  seen.set(caller, times);
  if (seen.size > 5000) {
    for (const [who, list] of seen) if (!list.length || now - list[list.length - 1] >= HOUR) seen.delete(who);
  }
  return Math.ceil(wait / 1000);
}

/* ---------------- Reading the request ---------------- */

async function readJson(req) {
  // On Vercel the body is already read and `request.body` parses it when touched, throwing on
  // JSON that does not parse. Under plain Node there is no such property: the stream is read here.
  let ready;
  try { ready = req.body; } catch { throw new Refusal(400, { error: "bad-json" }); }
  let text;
  if (ready === undefined || ready === null) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    }
    if (size > MAX_BODY_BYTES) throw new Refusal(413, { error: "too-large" });
    text = Buffer.concat(chunks).toString("utf8");
  } else if (Buffer.isBuffer(ready)) text = ready.toString("utf8");
  else if (typeof ready === "string") text = ready;
  else return ready;
  try { return JSON.parse(text); } catch { throw new Refusal(400, { error: "bad-json" }); }
}

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function words(value, field, message) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw bad(field, message);
  return value.replace(/\r\n?/g, "\n").trim();
}

/** An optional https link, on one of `hosts` when the field is for one service. "" when absent. */
function link(value, field, message, hosts) {
  const text = words(value, field, message);
  if (!text) return "";
  if (text.length > MAX_LINK || /\s/.test(text) || CONTROL.test(text) || !/^https:\/\//i.test(text)) throw bad(field, message);
  let url;
  try { url = new URL(text); } catch { throw bad(field, message); }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (url.protocol !== "https:" || url.username || url.password || !host.includes(".")) throw bad(field, message);
  if (hosts && !hosts.includes(host)) throw bad(field, message);
  return url.href;
}

/** What an image really is, by its first bytes. null for anything else, whatever it claims to be. */
function imageKind(b) {
  const ascii = (from, to) => b.toString("latin1", from, to);
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, 4) === "PNG" && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return { type: "image/png", ext: "png" };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { type: "image/jpeg", ext: "jpg" };
  if (b.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return { type: "image/gif", ext: "gif" };
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return { type: "image/webp", ext: "webp" };
  return null;
}

function image(value) {
  if (value === undefined || value === null) return null;
  const data = typeof value === "object" && !Array.isArray(value) ? value.data : undefined;
  if (typeof data !== "string" || !data) throw bad("image", "The image is { type, data }, with the file in base64.");
  // Four characters of base64 carry three bytes.
  if (data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw bad("image", "The image is 2 MB at most.");
  if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw bad("image", "The image is { type, data }, with the file in base64.");
  const bytes = Buffer.from(data, "base64");
  if (bytes.length > MAX_IMAGE_BYTES) throw bad("image", "The image is 2 MB at most.");
  const kind = imageKind(bytes);
  if (!kind) throw bad("image", "The image is a PNG, JPEG, WebP or GIF.");
  return { bytes, type: kind.type, ext: kind.ext };
}

/** Everything in the request, checked. Throws the 400 that says which field is wrong. */
function check(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("body", "Send one JSON object.");
  const name = words(body.name, "name", "The name is 1 to 32 bytes.");
  if (!name || Buffer.byteLength(name) > 32 || /[\u0000-\u001f\u007f]/.test(name)) throw bad("name", "The name is 1 to 32 bytes.");
  const symbol = words(body.symbol, "symbol", "The symbol is 1 to 10 bytes, with no spaces.");
  if (!symbol || Buffer.byteLength(symbol) > 10 || /\s/.test(symbol) || CONTROL.test(symbol)) throw bad("symbol", "The symbol is 1 to 10 bytes, with no spaces.");
  const description = words(body.description, "description", "The description is 1,000 characters at most.");
  if (description.length > MAX_DESCRIPTION || CONTROL.test(description)) throw bad("description", "The description is 1,000 characters at most.");
  return {
    name, symbol, description,
    website: link(body.website, "website", "The website is an https:// link, 200 characters at most."),
    twitter: link(body.twitter, "twitter", "The X link is an https:// link on x.com.", ["x.com", "twitter.com"]),
    telegram: link(body.telegram, "telegram", "The Telegram link is an https:// link on t.me.", ["t.me", "telegram.me"]),
    image: image(body.image),
  };
}

/* ---------------- Pinata ---------------- */

// As pasted into the environment: spaces, quotes or a leading "Bearer" do not belong to the key.
const pinataKey = () => String(process.env.PINATA_JWT || "").trim().replace(/^["']|["']$/g, "").replace(/^Bearer\s+/i, "").trim();

function ownGateway() {
  const host = String(process.env.PINATA_GATEWAY || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : "";
}

/** Pins one file to public IPFS and returns its CID. `step` only names it in an error. */
async function pin(key, blob, filename, step) {
  const form = new FormData();
  form.append("network", "public");
  form.append("name", filename);
  form.append("file", blob, filename);
  let res;
  try {
    res = await fetch(PINATA_UPLOAD, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(PINATA_TIMEOUT_MS) });
  } catch (error) {
    console.error(`metadata: Pinata did not answer for the ${step} (${(error && error.name) || "error"})`);
    throw new Refusal(502, { error: "upload-failed", step, status: 0 });
  }
  const text = await res.text().catch(() => "");
  let cid = "";
  try { cid = String(JSON.parse(text).data.cid); } catch { /* not the answer of an upload */ }
  if (!res.ok || !CID.test(cid)) {
    // Pinata's own reason, for the function's log only: short, and with anything key-shaped taken out.
    const reason = text.slice(0, 300).split(key).join("[key]").replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[key]").replace(/\s+/g, " ").slice(0, 160);
    console.error(`metadata: Pinata answered ${res.status} for the ${step}: ${reason}`);
    throw new Refusal(502, { error: "upload-failed", step, status: res.status });
  }
  return cid;
}

/** Whether the account's own gateway hands this file to a stranger. */
async function serves(host, cid) {
  try {
    const res = await fetch(`https://${host}/ipfs/${cid}`, { method: "HEAD", signal: AbortSignal.timeout(8000) });
    if (!res.ok) console.warn(`metadata: PINATA_GATEWAY answered ${res.status}; the public gateway is used instead`);
    return res.ok;
  } catch {
    console.warn("metadata: PINATA_GATEWAY did not answer; the public gateway is used instead");
    return false;
  }
}

/* ---------------- The function ---------------- */

module.exports = async function metadata(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return answer(res, 405, { error: "post-only" });
    }
    if (!fromSite(req.headers.origin)) return answer(res, 403, { error: "bad-origin" });
    const key = pinataKey();
    if (!key) return answer(res, 503, { error: "not-configured" });
    if (String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase() !== "application/json") {
      return answer(res, 415, { error: "json-only" });
    }
    const token = check(await readJson(req));

    const wait = mustWait(callerOf(req), Date.now());
    if (wait) {
      res.setHeader("Retry-After", String(wait));
      return answer(res, 429, { error: "slow-down", retryAfter: wait });
    }

    const file = `lure-${token.symbol.replace(/[^A-Za-z0-9]/g, "") || "token"}`;
    const own = ownGateway();
    let host = PUBLIC_GATEWAY, asked = false;

    let imageLink = "";
    if (token.image) {
      const cid = await pin(key, new Blob([token.image.bytes], { type: token.image.type }), `${file}.${token.image.ext}`, "image");
      if (own) { asked = true; if (await serves(own, cid)) host = own; }
      imageLink = `https://${host}/ipfs/${cid}`;
    }

    // What wallets and trading terminals read: the four standard fields, then the links, at
    // the top level and again under "extensions". A link that was not given is not written.
    const links = {};
    for (const field of ["website", "twitter", "telegram"]) if (token[field]) links[field] = token[field];
    const json = {
      name: token.name,
      symbol: token.symbol,
      description: token.description,
      ...(imageLink ? { image: imageLink } : {}),
      ...(links.website ? { external_url: links.website } : {}),
      ...links,
      ...(Object.keys(links).length ? { extensions: links } : {}),
    };
    const cid = await pin(key, new Blob([JSON.stringify(json)], { type: "application/json" }), `${file}.json`, "metadata");
    if (own && !asked && await serves(own, cid)) host = own;

    return answer(res, 200, { uri: `https://${host}/ipfs/${cid}`, image: imageLink });
  } catch (error) {
    if (error instanceof Refusal) return answer(res, error.status, error.body);
    // Never the request, never the key: only what kind of error it was.
    console.error(`metadata: failed (${(error && error.name) || "error"})`);
    return answer(res, 500, { error: "failed" });
  }
};
