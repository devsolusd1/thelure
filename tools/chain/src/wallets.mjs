// Wallets: the ones a browser extension (or a wallet's own browser) injects into the page.
// The wallet only ever signs. Sending is done by send.mjs, through the site's own connection.

import { forget, LureError } from "./core.mjs";

const KNOWN = [
  { id: "phantom", name: "Phantom", url: "https://phantom.com/download", find: (w) => (w.phantom && w.phantom.solana && w.phantom.solana.isPhantom ? w.phantom.solana : w.solana && w.solana.isPhantom ? w.solana : null) },
  { id: "solflare", name: "Solflare", url: "https://solflare.com/download", find: (w) => (w.solflare && w.solflare.isSolflare ? w.solflare : null) },
  { id: "backpack", name: "Backpack", url: "https://backpack.app/download", find: (w) => (w.backpack && w.backpack.solana ? w.backpack.solana : w.backpack && w.backpack.isBackpack ? w.backpack : null) },
];
const REMEMBER = "lure.wallet";
const page = () => (typeof window === "undefined" ? null : window);
const provider = (id) => { const w = page(); const known = KNOWN.find((k) => k.id === id); return w && known ? known.find(w) : null; };
const remembered = () => { try { return page() ? page().sessionStorage.getItem(REMEMBER) : null; } catch { return null; } };
const remember = (id) => { try { if (id) page().sessionStorage.setItem(REMEMBER, id); else page().sessionStorage.removeItem(REMEMBER); } catch { /* private mode: the choice lasts for this page only */ } };

let now = null; // { id, name, address, provider, off }
const listeners = new Set();
const changed = () => { forget("wallet:"); for (const listener of [...listeners]) { try { listener(current()); } catch { /* a listener's own problem */ } } };

/** The wallets this site knows, and whether each is in this browser: [{ id, name, installed, url }]. */
export function list() {
  return KNOWN.map(({ id, name, url }) => ({ id, name, url, installed: !!provider(id) }));
}

/** The connected wallet, or null: { id, name, address, signTransaction(tx), signAllTransactions(txs) }. */
export function current() {
  if (!now) return null;
  const { id, name, address, provider: p } = now;
  return {
    id, name, address,
    signTransaction: (tx) => p.signTransaction(tx),
    signAllTransactions: typeof p.signAllTransactions === "function" ? (txs) => p.signAllTransactions(txs) : undefined,
  };
}

function adopt(id, p, publicKey) {
  const known = KNOWN.find((k) => k.id === id);
  const address = String((publicKey || p.publicKey || "").toString());
  if (!address) throw new LureError("wallet", `${known.name} did not say which account it is.`);
  if (now && now.off) now.off();
  // The wallet tells the page when the user switches account or disconnects from its side.
  const onAccount = (next) => {
    if (!now || now.id !== id) return;
    if (next) { now.address = next.toString(); changed(); } else { drop(); }
  };
  const onGone = () => { if (now && now.id === id) drop(); };
  let off = null;
  if (typeof p.on === "function") {
    p.on("accountChanged", onAccount);
    p.on("disconnect", onGone);
    off = () => { try { (p.off || p.removeListener).call(p, "accountChanged", onAccount); (p.off || p.removeListener).call(p, "disconnect", onGone); } catch { /* an old provider */ } };
  }
  now = { id, name: known.name, address, provider: p, off };
  remember(id);
  changed();
  return current();
}

function drop() {
  if (now && now.off) now.off();
  now = null;
  remember(null);
  changed();
}

/**
 * Connects a wallet and remembers the choice for this browser session. With no id it takes
 * the remembered one, or the only one installed. { silent: true } never opens the wallet's
 * window: it succeeds only when the user already trusted this site.
 */
export async function connect(id, { silent = false } = {}) {
  const installed = list().filter((w) => w.installed);
  const chosen = id || remembered() || (installed.length === 1 ? installed[0].id : null);
  if (!installed.length) throw new LureError("no-wallet", "No wallet found in this browser. Install Phantom, Solflare or Backpack, or open this page inside your wallet's browser.");
  if (!chosen) throw new LureError("choose-wallet", "More than one wallet is installed: choose one.");
  const p = provider(chosen);
  if (!p) throw new LureError("no-wallet", `${(KNOWN.find((k) => k.id === chosen) || { name: "That wallet" }).name} is not in this browser.`);
  try {
    const answer = await p.connect(silent ? { onlyIfTrusted: true } : undefined);
    return adopt(chosen, p, answer && answer.publicKey);
  } catch (error) {
    if (error instanceof LureError) throw error;
    const no = error && (error.code === 4001 || /reject|denied|cancel|declin/i.test(String(error.message)));
    throw new LureError(no ? "rejected" : "wallet", no ? "The wallet was not connected." : `The wallet did not connect: ${(error && error.message) || error}.`, { cause: error });
  }
}

/** Forgets the wallet here, and asks it to forget the page. */
export async function disconnect() {
  const p = now && now.provider;
  drop();
  try { if (p && typeof p.disconnect === "function") await p.disconnect(); } catch { /* it is forgotten here either way */ }
}

/** On page load: the wallet chosen earlier in this session, back without a prompt, or null. */
export async function restore() {
  const id = remembered();
  if (!id || !provider(id)) return null;
  try { return await connect(id, { silent: true }); } catch { return null; }
}

/** Calls `listener(current())` whenever the wallet connects, changes account or goes. Returns a function that stops it. */
export function on(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/* ---------------- The control in the nav strip ----------------
 * Markup it works on:  <span class="tk-wallet"><button type="button" class="btn btn-small btn-ghost" data-wallet>Connect wallet</button></span>
 * The styles are the "tk-wallet" rules of the token-page block in app.css. */

const short = (address) => `${address.slice(0, 4)}…${address.slice(-4)}`;

/**
 * Turns a button into the site's wallet control: connect, choose between wallets, copy the
 * address, disconnect. Restores this session's wallet on its own. Keyboard: Enter opens,
 * Escape closes. Returns { refresh }.
 */
export function button(element) {
  const doc = element.ownerDocument;
  const wrap = element.parentElement;
  const menu = doc.createElement("div");
  menu.className = "tk-wallet-menu";
  menu.hidden = true;
  wrap.appendChild(menu);
  element.setAttribute("aria-haspopup", "true");
  element.setAttribute("aria-expanded", "false");
  let note = "";

  const close = (focus) => {
    menu.hidden = true;
    element.setAttribute("aria-expanded", "false");
    if (focus) element.focus();
  };
  const item = (label, act) => {
    const b = doc.createElement("button");
    b.type = "button";
    b.className = "tk-wallet-item";
    b.textContent = label;
    b.addEventListener("click", act);
    return b;
  };
  const line = (text) => { const p = doc.createElement("p"); p.className = "tk-wallet-note"; p.textContent = text; return p; };
  const attempt = async (id) => {
    note = "";
    close(true);
    element.disabled = true;
    try { await connect(id); } catch (error) { if (error.kind !== "rejected") { note = error.message; open(); } } finally { element.disabled = false; paint(); }
  };

  function paint() {
    const wallet = current();
    element.textContent = wallet ? short(wallet.address) : "Connect wallet";
    element.classList.toggle("is-connected", !!wallet);
    element.setAttribute("aria-label", wallet ? `Wallet ${wallet.address}, connected with ${wallet.name}` : "Connect wallet");
  }

  function open() {
    const wallet = current();
    const installed = list().filter((w) => w.installed);
    menu.textContent = "";
    if (note) menu.appendChild(line(note));
    if (wallet) {
      menu.appendChild(line(`${wallet.name} · ${short(wallet.address)}`));
      menu.appendChild(item("Copy address", async () => { try { await page().navigator.clipboard.writeText(wallet.address); } catch { /* no clipboard here */ } close(true); }));
      menu.appendChild(item("Disconnect", async () => { close(true); await disconnect(); }));
    } else if (installed.length) {
      for (const w of installed) menu.appendChild(item(w.name, () => attempt(w.id)));
    } else {
      menu.appendChild(line("No wallet found in this browser. Install one, or open this page inside your wallet's browser."));
      for (const w of list()) {
        const a = doc.createElement("a");
        a.className = "tk-wallet-item";
        a.href = w.url;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = `Get ${w.name}`;
        menu.appendChild(a);
      }
    }
    menu.hidden = false;
    element.setAttribute("aria-expanded", "true");
  }

  element.addEventListener("click", () => {
    if (!menu.hidden) return close(false);
    const installed = list().filter((w) => w.installed);
    // One wallet and nothing to choose: straight to it.
    if (!current() && installed.length === 1) return attempt(installed[0].id);
    note = "";
    open();
  });
  doc.addEventListener("click", (event) => { if (!menu.hidden && !wrap.contains(event.target)) close(false); });
  doc.addEventListener("keydown", (event) => { if (event.key === "Escape" && !menu.hidden) close(true); });
  on(paint);
  paint();
  restore();
  return { refresh: paint };
}
