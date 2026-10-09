// A token's metadata: the small file its uri names (a picture, a description, links).
//
// It is read apart from the token. Nothing that reads the chain waits for it, and a link that
// is slow, dead or not metadata at all only means there is nothing to show. Everything in it
// was written by whoever launched the token: it is checked here (text of a sane length, links
// that are https and go where their name says), and a page must still escape it.

import { net } from "./core.mjs";

/* ---------------- Where IPFS content is asked for ---------------- */

// Public gateways that answer a page on another site, in the order they are tried. Checked on
// 2026-10-09: Pinata's has what was pinned at Pinata but is slow (3 to 7 s); the other two are
// quick for content the network already knows and may never find a fresh Pinata pin.
// net.js may name its own first with `ipfsGateways: ["https://<name>.mypinata.cloud", …]`.
const GATEWAYS = ["https://gateway.pinata.cloud/ipfs/", "https://ipfs.filebase.io/ipfs/", "https://4everland.io/ipfs/"];
// Gateways that no longer serve content to other sites (ipfs.io and dweb.link retired on
// 2026-09-21). A link through one of them is asked for at the gateways above instead.
const RETIRED = /(^|\.)(ipfs\.io|dweb\.link|w3s\.link|nftstorage\.link|cloudflare-ipfs\.com|cf-ipfs\.com)$/;
const CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,110}|[zkf][A-Za-z0-9]{40,110})$/;

const MAX_BYTES = 64 * 1024; // of a metadata file
const MAX_LINK = 400; // characters of a link inside it
const MAX_URI = 600; // characters of the uri itself
const MAX_WORDS = 600; // characters of a description
const HEDGE = 2500; // ms a link is waited for alone before the next is asked beside it
const RETRY_AFTER = 60_000; // ms before a link that did not answer is asked again; doubled each time it fails, up to
const RETRY_AT_MOST = 30 * 60_000;
const PARALLEL = 6; // metadata files read at once

const hostOf = (link) => new URL(link).hostname;

/** An https link, or "". What a metadata file calls a link is only text until this says so. */
function httpsLink(value, max = MAX_LINK) {
  if (typeof value !== "string") return "";
  let text = value.trim();
  if (!text || text.length > max || /[\s\u0000-\u001f\u007f-\u009f<>"'`\\]/.test(text)) return "";
  if (/^http:\/\//i.test(text)) text = `https://${text.slice(7)}`;
  let url;
  try { url = new URL(text); } catch { return ""; }
  // A name with a dot, ending in a word: not an IP address, not a machine on the visitor's network.
  if (url.protocol !== "https:" || url.username || url.password || !/^([a-z0-9-]+\.)+[a-z][a-z0-9-]*$/.test(url.hostname)) return "";
  return url.href;
}

/** "<cid>/path" when the link names IPFS content (ipfs://, a gateway's /ipfs/ path or a <cid>.ipfs. host), else null. */
function ipfsPath(link) {
  const found = /^ipfs:\/\/(?:ipfs\/)?([^/?#]+)([^?#]*)/i.exec(link)
    || /^https?:\/\/[^/?#]+\/ipfs\/([^/?#]+)([^?#]*)/i.exec(link)
    || /^https?:\/\/([^./?#]+)\.ipfs\.[^/?#]+([^?#]*)/i.exec(link);
  if (!found || !CID.test(found[1])) return null;
  return found[1] + (found[2] === "/" ? "" : found[2]);
}

function gateways() {
  let named = [];
  try { named = net().ipfsGateways; } catch { /* net.js is not loaded: the gateways above */ }
  const seen = new Set();
  return [...(Array.isArray(named) ? named : []), ...GATEWAYS]
    .map((base) => httpsLink(`${String(base).trim().replace(/\/+$/, "").replace(/\/ipfs$/i, "")}/ipfs/`))
    .filter((base) => base && !seen.has(hostOf(base)) && seen.add(hostOf(base)));
}

/**
 * The https links to ask for what `link` names, best first: the link as written, then the
 * same IPFS content at `first` (a gateway that just answered) and at each public gateway.
 * One link per host; hosts in `failed` go last.
 */
function linksFor(link, { first = "", failed = new Set(), max = MAX_LINK } = {}) {
  if (typeof link !== "string" || link.length > max) return [];
  const text = link.trim();
  const path = ipfsPath(text);
  const given = /^ipfs:/i.test(text) ? "" : httpsLink(text, max);
  const list = [];
  if (given && !(path && RETIRED.test(hostOf(given)))) list.push(given);
  if (path) for (const base of [first, ...gateways()]) if (base) list.push(httpsLink(base + path, max));
  const seen = new Set();
  return list
    .filter((one) => one && !seen.has(hostOf(one)) && seen.add(hostOf(one)))
    .sort((a, b) => Number(failed.has(hostOf(a))) - Number(failed.has(hostOf(b))));
}

/* ---------------- What a metadata file may say ---------------- */

/** Plain text: control and direction-changing characters out, runs of blanks closed, cut at `max` characters. */
function words(value, max) {
  if (typeof value !== "string") return "";
  const text = value
    .replace(/(?!\n)\p{Cc}|\p{Bidi_Control}|[\p{Zl}\p{Zp}]/gu, " ")
    .replace(/ +/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const letters = Array.from(text);
  return letters.length > max ? `${letters.slice(0, max - 1).join("").trimEnd()}…` : text;
}

const X_HOSTS = /^(www\.|mobile\.)?(x|twitter)\.com$/;
const TELEGRAM_HOSTS = /^(www\.)?(t|telegram)\.me$/;

const blank = (ok) => Object.freeze({ ok, description: "", image: "", imageAlt: "", website: "", twitter: "", telegram: "" });
const NOTHING = blank(false);

/**
 * A metadata file as the site shows it, or null when the JSON is not a token's metadata.
 * `from` says which gateway answered and which hosts did not, so the picture is asked for
 * where it is likely to be.
 */
function shape(json, from = {}) {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  if (!["name", "symbol", "description", "image"].some((field) => typeof json[field] === "string")) return null;
  const more = json.extensions && typeof json.extensions === "object" ? json.extensions : {};

  // A link is filed under where it really goes, whatever the file calls it: an "X" link to
  // another site is shown as that site. The first link of each kind is kept.
  const links = { website: "", twitter: "", telegram: "" };
  const file = (value, handleAt) => {
    const link = httpsLink(handleAt && /^@\w{1,32}$/.test(String(value).trim()) ? `${handleAt}${String(value).trim().slice(1)}` : value);
    if (!link) return;
    const host = hostOf(link);
    const kind = X_HOSTS.test(host) ? "twitter" : TELEGRAM_HOSTS.test(host) ? "telegram" : "website";
    if (!links[kind]) links[kind] = link;
  };
  for (const value of [json.twitter, more.twitter, json.x, more.x]) file(value, "https://x.com/");
  for (const value of [json.telegram, more.telegram]) file(value, "https://t.me/");
  for (const value of [json.website, more.website, json.external_url]) file(value);

  const pictures = linksFor(json.image, from);
  return Object.freeze({
    ok: true,
    description: words(json.description, MAX_WORDS),
    image: pictures[0] || "",
    imageAlt: pictures[1] || "",
    ...links,
  });
}

/** A data: URI's metadata, read on the spot. */
function fromData(uri) {
  const found = /^data:application\/json(?:;charset=[^;,]+)?(;base64)?,(.*)$/is.exec(uri);
  if (!found) return null;
  try {
    const text = found[1] ? new TextDecoder().decode(Uint8Array.from(atob(found[2]), (c) => c.charCodeAt(0))) : decodeURIComponent(found[2]);
    return shape(JSON.parse(text));
  } catch {
    return null;
  }
}

/* ---------------- Asking ---------------- */

async function fetchJson(link, signal) {
  // No cookies, no referrer, no header a gateway could take for a request for another format.
  const response = await fetch(link, { signal, credentials: "omit", referrerPolicy: "no-referrer", redirect: "follow" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (Number(response.headers.get("content-length")) > MAX_BYTES) throw new Error("too large");
  let text = "";
  if (response.body && response.body.getReader) {
    const reader = response.body.getReader(), decoder = new TextDecoder();
    for (let size = 0; ;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) { reader.cancel().catch(() => {}); throw new Error("too large"); }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } else {
    text = await response.text();
    if (text.length > MAX_BYTES) throw new Error("too large");
  }
  const json = JSON.parse(text);
  if (!shape(json)) throw new Error("not metadata");
  return json;
}

// The first link to answer with metadata wins. A link that fails gives way to the next at
// once; one that is only slow gets company after HEDGE ms. null when none answers in time.
function firstAnswer(links, timeout) {
  return new Promise((resolve) => {
    if (!links.length) return resolve(null);
    const failed = new Set(), asked = [];
    let next = 0, open = 0, over = false, hedge = 0;
    const end = (answer) => {
      if (over) return;
      over = true;
      clearTimeout(hedge);
      clearTimeout(limit);
      const done = answer && { ...answer, failed: new Set(failed) };
      for (const stop of asked) stop.abort();
      resolve(done);
    };
    const limit = setTimeout(() => end(null), timeout);
    const ask = () => {
      clearTimeout(hedge);
      if (over || next >= links.length) return;
      const link = links[next++], stop = new AbortController();
      asked.push(stop);
      open++;
      fetchJson(link, stop.signal).then(
        (json) => end({ json, link }),
        () => {
          open--;
          failed.add(hostOf(link));
          if (next < links.length) ask(); else if (!open) end(null);
        },
      );
      if (next < links.length) hedge = setTimeout(ask, HEDGE);
    };
    ask();
  });
}

let busy = 0;
const line = [];
function inTurn(job) {
  return new Promise((resolve) => {
    const run = () => {
      busy++;
      job().then(resolve, () => resolve(null)).finally(() => { busy--; const next = line.shift(); if (next) next(); });
    };
    if (busy < PARALLEL) run(); else line.push(run);
  });
}

/* ---------------- Remembering ---------------- */

const memory = new Map(); // uri -> { meta, until }
const pending = new Map(); // uri -> the read under way
const failures = new Map(); // uri -> how many reads in a row found nothing
const KEPT = "lure-meta-1:";

// Between pages an answer is kept by the browser: for good when the link names its own
// content (IPFS: the same link is always the same file), for this tab's visit otherwise.
function shelf(uri) {
  try {
    if (typeof window === "undefined") return null;
    return ipfsPath(uri) ? window.localStorage : window.sessionStorage;
  } catch {
    return null; // storage is switched off in this browser
  }
}

// What goes on the shelf is what the file said (the picture's link as written, and the gateway
// that had the file), not the links made from it. Those are made again, by the same checks,
// each time it is taken down, so they follow the gateways this version of the site knows.
function shelve(uri, json, meta, first) {
  try {
    const image = typeof json.image === "string" && json.image.length <= MAX_LINK ? json.image : "";
    shelf(uri).setItem(KEPT + uri, JSON.stringify({ name: "", description: meta.description, image, website: meta.website, twitter: meta.twitter, telegram: meta.telegram, first }));
  } catch { /* no shelf, or it is full: memory will do */ }
}

function recall(uri) {
  try {
    const saved = JSON.parse(shelf(uri).getItem(KEPT + uri));
    return shape(saved, { first: httpsLink(saved.first) });
  } catch {
    return null;
  }
}

const keep = (uri, meta, until = Infinity) => { memory.set(uri, { meta, until }); return meta; };

// What is known of a uri without asking anyone, or null for a link not read yet.
function atHand(uri) {
  const hit = memory.get(uri);
  if (hit && Date.now() < hit.until) return hit.meta;
  if (!uri) return NOTHING;
  if (/^data:/i.test(uri)) return keep(uri, fromData(uri) || NOTHING);
  if (!linksFor(uri, { max: MAX_URI }).length) return keep(uri, NOTHING); // not a link this site reads
  const saved = recall(uri);
  return saved ? keep(uri, saved) : null;
}

const clean = (uri) => (typeof uri === "string" ? uri.replace(/\0+$/, "").trim() : "");

/**
 * What is known of a token's metadata right now, with no network: a data: URI is read on the
 * spot; a link answers from what readMetadata fetched earlier (`ok` is false until then).
 */
export function metadataFromUri(uri) {
  return atHand(clean(uri)) || NOTHING;
}

/**
 * The metadata a uri names: { ok, description, image, imageAlt, website, twitter, telegram }.
 * A link (https, or ipfs:// through public gateways) is fetched once and remembered. It never
 * rejects: a link that does not answer within `timeout` ms, or is not metadata, gives the
 * empty answer with `ok` false. Calling again is free: the link is only asked again a minute
 * later, then two, then four, up to half an hour, so a page may simply call on every refresh.
 */
export function readMetadata(uri, { timeout = 12_000 } = {}) {
  const id = clean(uri);
  const known = atHand(id);
  if (known) return Promise.resolve(known);
  let read = pending.get(id);
  if (!read) {
    read = inTurn(() => firstAnswer(linksFor(id, { max: MAX_URI }), timeout)).then((answer) => {
      pending.delete(id);
      // The gateway that had the file is the first place to ask for its picture.
      const base = answer && /^https:\/\/[^/?#]+\/ipfs\//i.exec(answer.link);
      const first = base ? base[0] : "";
      const meta = answer && shape(answer.json, { first, failed: answer.failed });
      if (!meta) {
        const times = (failures.get(id) || 0) + 1;
        failures.set(id, times);
        return keep(id, NOTHING, Date.now() + Math.min(RETRY_AT_MOST, RETRY_AFTER * 2 ** (times - 1)));
      }
      failures.delete(id);
      shelve(id, answer.json, meta, first);
      return keep(id, meta);
    });
    pending.set(id, read);
  }
  return read;
}
