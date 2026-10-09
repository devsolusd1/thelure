/* The board (tokens.html).
 *
 * Every token launched under the two Lure curves of the cluster net.js names, read from Solana
 * by the visitor's browser: one read when the page opens, one more every 25 seconds while the
 * tab is looked at. Everything on the chain goes through window.LureChain (vendor/lure-chain.js);
 * everything about the cluster comes from window.LURE_NET (net.js). Nothing here is invented:
 * a figure that cannot be read from the chain is not shown.
 */
(function () {
  "use strict";

  const NET = window.LURE_NET;
  const chain = window.LureChain;
  const $ = (id) => document.getElementById(id);
  const el = {
    status: $("bd-status"), body: $("bd-body"), stats: $("stats"), fee: $("bd-fee"), search: $("search"),
    meta: $("board-meta"), board: $("board"), empty: $("empty"), moreRow: $("bd-more-row"), more: $("bd-more"),
    walletBtn: document.querySelector("[data-wallet]"),
  };
  const tabs = Array.from(document.querySelectorAll(".tab[data-filter]"));
  if (Object.values(el).some((node) => !node) || !tabs.length) return;

  /* ================= Words and numbers ================= */

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const short = (a) => (a && a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a || "");
  const fmtInt = (n) => Math.round(n).toLocaleString("en-US");
  // SOL to four significant digits, never in exponent form: 1.008, 0.00396.
  function fmtSol(n) {
    if (!n) return "0";
    if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: n >= 1000 ? 0 : 3 });
    const digits = Math.min(12, Math.max(4, 3 - Math.floor(Math.log10(n))));
    return n.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
  }
  const fmtPct = (share) => `${(share * 100).toLocaleString("en-US", { maximumFractionDigits: share < 0.001 ? 4 : 2 })}%`;
  const two = (n) => String(n).padStart(2, "0");
  function clockText(seconds) {
    const t = Math.max(0, Math.ceil(seconds));
    const d = Math.floor(t / 86400), h = Math.floor((t % 86400) / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return d ? `${d}d ${two(h)}:${two(m)}:${two(s)}` : h ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
  }
  const timeNow = (ms) => new Date(ms).toLocaleTimeString("en-GB", { hour12: false });
  function setHtml(node, html) { if (node.__html !== html) { node.__html = html; node.innerHTML = html; } }
  function setText(node, text) { if (node.textContent !== text) node.textContent = text; }

  // The line above the board: quiet while reading, a dashed box when something is wrong.
  function say(text) {
    el.status.className = "tk-status bd-status";
    el.status.setAttribute("role", "status");
    el.status.textContent = text;
    el.status.hidden = !text;
  }
  function problem(html, retry) {
    el.status.className = "tk-status bd-status is-error";
    el.status.setAttribute("role", "alert");
    el.status.innerHTML = html + (retry ? ` <button type="button" class="pill pill-s" data-retry>Try again now</button>` : "");
    el.status.hidden = false;
  }

  /* ================= Before anything is read ================= */

  // Devnet notes show on devnet only.
  for (const node of document.querySelectorAll("[data-net]")) node.hidden = !NET || node.getAttribute("data-net") !== NET.cluster;
  if (!NET || !chain) {
    el.walletBtn.parentElement.hidden = true;
    return problem("This page could not load its scripts (net.js and vendor/lure-chain.js).");
  }
  const where = NET.cluster;
  const Where = where.charAt(0).toUpperCase() + where.slice(1);
  const f = NET.fees;
  el.fee.innerHTML = `<b>${esc(f.total)}%</b> per trade: ${esc(f.creator)}% creator, ${esc(f.treasury)}% Lure treasury, ${esc(f.protocol)}% Meteora.`;
  chain.wallets.button(el.walletBtn);

  const notReady = NET.notReady(["rpcUrl", "hookProgram", "configs"]);
  if (notReady) return problem(esc(notReady));

  const REFRESH = 25000; // three RPC calls each time: the pools of each curve, then every mint and its rules in one ask
  const PAGE = 60; // cards drawn at once
  const state = {
    tokens: null, byMint: null, readAt: 0, filter: "all", query: "", asked: "", shown: PAGE,
    loading: false, failures: 0, timer: 0, stopped: false,
    ended: new Set(), // clocks seen running out here, so each asks the chain early only once
    broken: new Set(), // images that did not load
    launched: (new URLSearchParams(window.location.search).get("launched") || "").trim(),
  };
  const cards = new Map(); // mint -> its <article>

  /* ================= Reading, again and again ================= */

  function schedule(ms) {
    clearTimeout(state.timer);
    if (!state.stopped) state.timer = setTimeout(() => load(false), ms);
  }

  async function load(byHand, maxAge = 8000) {
    clearTimeout(state.timer);
    if (state.stopped || state.loading) return;
    // After the first read, a tab nobody is looking at stops asking; it picks up again when it is looked at.
    if (document.hidden && state.tokens && !byHand) return;
    state.loading = true;
    if (!state.tokens || byHand) say(`Reading the board from ${where}…`);
    try {
      const tokens = await chain.listTokens({ maxAge: byHand ? 0 : maxAge });
      state.tokens = tokens;
      state.byMint = new Map(tokens.map((t) => [t.mint, t]));
      state.readAt = tokens.length ? tokens[0].readAt : Date.now();
      state.failures = 0;
      say("");
      el.body.hidden = false;
      renderStats();
      render();
      wantAgain();
      point();
      schedule(REFRESH);
    } catch (error) {
      const kind = error && error.kind;
      if (kind === "not-ready" || kind === "bad-config") {
        state.stopped = true;
        el.body.hidden = true;
        return problem(esc(error.message));
      }
      state.failures++;
      const wait = Math.min(120000, 30000 * 2 ** (state.failures - 1));
      const why = kind === "rate" ? `${Where} asked this browser to slow down.` : `${Where} did not answer.`;
      const kept = state.tokens ? ` What you see was read at ${timeNow(state.readAt)}.` : "";
      problem(`${esc(why)} The board asks again in ${Math.round(wait / 1000)} seconds.${esc(kept)}`, true);
      if (window.console && console.warn) console.warn("Lure board: the read failed.", error);
      schedule(wait);
    } finally {
      state.loading = false;
    }
  }

  /* ================= What a token is doing now ================= */

  const playing = (t) => !!(t.rules && t.rules.game) && !t.graduated;
  const FILTERS = {
    all: () => true,
    playing,
    infinite: (t) => t.curve === "infinite" && !t.graduated,
    graduating: (t) => t.curve === "graduating" && !t.graduated,
    graduated: (t) => t.graduated,
  };

  // The round as it stands this second, on the chain's clock: the deadline was read, the time left is counted here.
  function gameNow(token) {
    const game = token.rules && token.rules.game;
    if (!game) return null;
    if (!token.hooked) return { phase: "gone", left: 0 };
    const now = Date.now() / 1000 + token.clockSkew;
    const left = game.deadline ? game.deadline - now : 0;
    return { phase: game.deadline ? (left > 0 ? "running" : "over") : game.phase, left };
  }
  const PHASE_ORDER = { running: 0, over: 1, waiting: 2, guard: 3, gone: 4 };
  const PHASE_WORDS = { over: "Over, waiting to be paid", waiting: "Waiting for a buy", guard: "Starts when the guard comes down", gone: "Hook removed" };

  function visible() {
    const q = state.query;
    const list = state.tokens.filter((t) => FILTERS[state.filter](t) && (!q || `${t.name} ${t.symbol} ${t.mint}`.toLowerCase().includes(q)));
    if (state.filter !== "playing") return list; // newest first, as read
    // Playing: clocks about to run out first, then rounds waiting to be paid, then the biggest pots.
    return list.sort((a, b) => {
      const ga = gameNow(a), gb = gameNow(b);
      return (PHASE_ORDER[ga.phase] - PHASE_ORDER[gb.phase])
        || (ga.phase === "running" ? ga.left - gb.left : b.rules.game.pot - a.rules.game.pot);
    });
  }

  /* ================= A card ================= */

  const AVATAR_COLORS = [["#fd4b00", "#000"], ["#f6eee6", "#000"], ["#ff9a66", "#000"], ["#1a1715", "#fd4b00"]];
  const hash = (s) => Array.from(s).reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7) >>> 0;

  // What the token's metadata says, as far as it is known now: a data: URI at once, a link once
  // its file has been read (see want() below). Whatever it says was written by the token's creator.
  const metaOf = (token) => chain.metadataFromUri(token.uri);
  const https = (link) => typeof link === "string" && /^https:\/\//.test(link);

  // The token's letter, and over it the picture when there is one: the letter shows until the
  // picture has loaded, and stays when it does not.
  function avatar(token) {
    const meta = metaOf(token);
    const src = [meta.image, meta.imageAlt].find((link) => https(link) && !state.broken.has(link));
    const letter = Array.from(token.symbol || token.name || "?")[0].toUpperCase();
    const [bg, fg] = AVATAR_COLORS[hash(token.mint) % AVATAR_COLORS.length];
    return `<span class="tav-gen" style="background:${bg};color:${fg}">${esc(letter)}</span>`
      + (src ? `<img src="${esc(src)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : "");
  }

  // The rules the token carries, as the board's small chips.
  function chips(token) {
    const r = token.rules;
    if (!r) return `<span class="hchip cat-none">No rules</span>`;
    const list = [];
    if (r.game) list.push(["cat-games", "Last Buyer Wins"]);
    if (r.cap) list.push(["cat-guards", r.cap.share === null ? "Wallet cap set by its agent" : `Wallet cap ${fmtPct(r.cap.share)}`]);
    if (r.blockLimit) list.push(["cat-guards", `Block limit ${fmtPct(r.blockLimit.share)}`]);
    if (token.leash) list.push(["cat-access", "Agent on a leash"]);
    if (!r.curveOk) list.push(["cat-none", "Rules not tied to the curve"]);
    if (!list.length) list.push(["cat-none", "No limits"]);
    return list.map(([cls, text]) => `<span class="hchip ${cls}">${esc(text)}</span>`).join("");
  }

  function gameLine(token) {
    const game = token.rules && token.rules.game;
    if (!game) return "";
    // The last span is the clock or the round's state: tick() writes it, so a refresh never redraws the card for it.
    return `<div class="tgame"><span class="tgame-k">Last Buyer Wins · round ${esc(fmtInt(game.round))}</span>`
      + `<span>Pot <b>${esc(fmtSol(game.pot))} SOL</b></span><span data-clock></span></div>`;
  }

  function curveBlock(token) {
    if (token.graduated) {
      return `<div class="tcurve is-grad"><span class="tcurve-k">Graduated</span><span class="tcurve-note">${token.hooked ? "moving to a Meteora pool" : "on Meteora, hook removed"}</span></div>`;
    }
    if (token.curve === "infinite") {
      return `<div class="tcurve is-perm"><span class="tcurve-k">∞ Infinite bonding</span><span class="tcurve-note">never graduates</span></div>`;
    }
    return `<div class="tcurve"><div class="tbar"><i style="width:${(token.progress * 100).toFixed(1)}%"></i></div>`
      + `<span><b>${esc(fmtPct(token.progress))}</b> of the way</span>`
      + `<span class="tcurve-note">graduates at ${esc(fmtSol(token.graduation.sol))} SOL</span></div>`;
  }

  function cardHtml(token, picture) {
    const name = token.name || "Unnamed token";
    const description = metaOf(token).description;
    // A graduated token no longer trades on its curve: the curve's last price is not its price.
    const numbers = token.graduated ? "" : `<dl class="tstats">`
      + `<div><dt>Market cap</dt><dd>${esc(fmtSol(token.marketCap))} <small>SOL</small></dd></div>`
      + `<div><dt>In the curve</dt><dd>${esc(fmtSol(token.solInCurve))} <small>SOL</small></dd></div></dl>`;
    return `<header class="tcard-head"><div class="tav">${picture}</div><div class="tid">`
      + `<h3><a href="token.html?mint=${encodeURIComponent(token.mint)}"><span class="tname">${esc(name)}</span>${token.symbol ? ` <span class="ttick">$${esc(token.symbol)}</span>` : ""}</a></h3>`
      + `<p class="tby">${esc(short(token.mint))} · by ${esc(short(token.creator))}</p></div></header>`
      + (description ? `<p class="tdesc">${esc(description)}</p>` : "")
      + `<div class="thooks">${chips(token)}</div>`
      + gameLine(token) + numbers + curveBlock(token);
  }

  // The card's element is kept between reads and only redrawn when what it says has changed,
  // so a refresh does not flicker and a focused card keeps the focus.
  function cardFor(token) {
    let node = cards.get(token.mint);
    if (!node) {
      node = document.createElement("article");
      node.className = "tcard bd-card";
      node.setAttribute("data-mint", token.mint);
      cards.set(token.mint, node);
      if (near) near.observe(node); else want(token.mint);
    }
    node.classList.toggle("is-grad", token.graduated);
    const picture = avatar(token);
    const html = cardHtml(token, picture);
    if (node.__html !== html) {
      const focused = node.contains(document.activeElement);
      // A picture that has not changed is not loaded again: its element is put back as it was.
      const kept = node.__picture === picture ? node.querySelector(".tav") : null;
      node.__html = html;
      node.__picture = picture;
      node.innerHTML = html;
      if (kept) node.querySelector(".tav").replaceWith(kept);
      if (focused) { const link = node.querySelector("a"); if (link) link.focus(); }
    }
    return node;
  }

  /* ================= Pictures and descriptions ================= */

  // The file a token's uri names is asked for when its card comes near the screen, once, and
  // the card is drawn again when the answer lands. The board never waits for it: a link that
  // is slow or dead only leaves the letter on the card.
  const seen = new Set(); // mints whose card has come near the screen
  const asking = new Set(); // mints whose file is being read
  function want(mint) {
    seen.add(mint);
    const token = state.byMint && state.byMint.get(mint);
    if (!token || !token.uri || asking.has(mint) || metaOf(token).ok) return; // nothing to read, or known already
    asking.add(mint);
    chain.readMetadata(token.uri).then((meta) => {
      asking.delete(mint);
      const now = state.byMint.get(mint);
      if (meta.ok && now && cards.has(mint)) { cardFor(now); tick(); }
    });
  }
  // Asking again is free: the chain layer fetches a link once, and one that did not answer
  // (a gateway can be slow with a file pinned a moment ago) only after a wait. So every read of
  // the board asks again for the cards that have been near the screen and still have no file.
  const wantAgain = () => { for (const mint of seen) want(mint); };
  const near = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      near.unobserve(entry.target);
      want(entry.target.getAttribute("data-mint"));
    }
  }, { rootMargin: "600px 0px" }) : null;

  /* ================= The page ================= */

  function renderStats() {
    const all = state.tokens;
    const inCurves = all.reduce((sum, t) => sum + (t.graduated ? 0 : t.solInCurve), 0);
    const pots = all.reduce((sum, t) => sum + (t.rules && t.rules.game ? t.rules.game.pot : 0), 0);
    setHtml(el.stats, [
      ["Tokens", fmtInt(all.length)],
      ["In the curves", `${fmtSol(inCurves)} SOL`],
      ["In game pots now", `${fmtSol(pots)} SOL`, true],
    ].map(([k, v, accent]) => `<div class="stat${accent ? " is-accent" : ""}"><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join(""));
    for (const tab of tabs) {
      const name = tab.getAttribute("data-filter");
      const count = all.filter(FILTERS[name]).length;
      if (!tab.__label) tab.__label = tab.textContent;
      setHtml(tab, `${esc(tab.__label)} <span class="bd-n">${fmtInt(count)}</span>`);
      if (name === "graduated") tab.hidden = count === 0 && state.filter !== "graduated";
    }
  }

  function render() {
    if (!state.tokens) return;
    const list = visible();
    const nodes = list.slice(0, state.shown).map(cardFor);
    const now = el.board.children;
    if (nodes.length !== now.length || nodes.some((node, i) => node !== now[i])) el.board.replaceChildren(...nodes);
    tick();

    const total = state.tokens.length;
    setText(el.meta, `${fmtInt(list.length)}${list.length !== total ? ` of ${fmtInt(total)}` : ""} token${total === 1 ? "" : "s"} · read from ${where} at ${timeNow(state.readAt)}`);
    el.moreRow.hidden = list.length <= state.shown;
    setText(el.more, `Show ${fmtInt(Math.min(PAGE, list.length - state.shown))} more`);
    el.empty.hidden = list.length > 0;
    if (!list.length) {
      setHtml(el.empty, !total
        ? `Nothing has been launched on ${esc(where)} yet. <a href="launch.html">Launch the first token</a>`
        : chain.isAddress(state.asked)
          ? `No token on the board has this address. <a href="token.html?mint=${encodeURIComponent(state.asked)}">Open it as a token</a>`
          : `No tokens match. <button type="button" class="linkish" data-reset>Show all tokens</button>`);
    }
  }

  // Once a second: every clock on the board counts down to the deadline that is on the chain.
  function tick() {
    if (!state.tokens) return;
    let ended = false;
    for (const node of el.board.children) {
      const slot = node.querySelector("[data-clock]");
      if (!slot) continue;
      const token = state.byMint.get(node.getAttribute("data-mint"));
      const now = token && gameNow(token);
      if (!now) continue;
      const running = now.phase === "running";
      const cls = running ? "tclock" : `tgame-note${now.phase === "over" ? " is-over" : ""}`;
      if (slot.className !== cls) slot.className = cls;
      setText(slot, running ? clockText(now.left) : PHASE_WORDS[now.phase] || "");
      // The clock just ran out here: look at the chain soon instead of waiting for the next read.
      const key = `${token.mint}:${token.rules.game.deadline}`;
      if (now.phase === "over" && token.rules.game.phase === "running" && !state.ended.has(key)) { state.ended.add(key); ended = true; }
    }
    if (ended && !state.loading) { clearTimeout(state.timer); state.timer = setTimeout(() => load(false, 1000), 1500); }
  }

  // A link from the launch page names the new token: show where it is, once.
  function point() {
    if (!state.launched) return;
    const node = cards.get(state.launched);
    state.launched = "";
    try { window.history.replaceState(null, "", window.location.pathname); } catch { /* the address bar keeps the link */ }
    if (!node || !node.isConnected) return;
    node.classList.add("is-new");
    node.scrollIntoView({ block: "center" });
  }

  function setFilter(name) {
    state.filter = FILTERS[name] ? name : "all";
    state.shown = PAGE;
    for (const tab of tabs) {
      const on = tab.getAttribute("data-filter") === state.filter;
      tab.classList.toggle("is-active", on);
      tab.setAttribute("aria-pressed", String(on));
    }
    if (state.tokens) renderStats();
    render();
  }

  for (const tab of tabs) tab.addEventListener("click", () => setFilter(tab.getAttribute("data-filter")));
  el.search.addEventListener("input", () => {
    state.asked = el.search.value.trim();
    state.query = state.asked.replace(/^\$/, "").toLowerCase();
    state.shown = PAGE;
    render();
  });
  el.more.addEventListener("click", () => { state.shown += PAGE; render(); });
  el.empty.addEventListener("click", (event) => {
    if (!event.target.closest("[data-reset]")) return;
    el.search.value = "";
    state.asked = state.query = "";
    setFilter("all");
    el.search.focus();
  });
  el.status.addEventListener("click", (event) => { if (event.target.closest("[data-retry]")) load(true); });
  // A picture covers the token's letter once it has loaded. One that does not load gives way to the
  // same picture at another gateway, then to the letter. (Neither event bubbles: they are caught on the way down.)
  el.board.addEventListener("load", (event) => {
    if (event.target.tagName === "IMG" && event.target.parentElement) event.target.parentElement.classList.add("has-img");
  }, true);
  el.board.addEventListener("error", (event) => {
    const img = event.target;
    if (!img || img.tagName !== "IMG") return;
    state.broken.add(img.getAttribute("src"));
    const card = img.closest("[data-mint]");
    const token = card && state.byMint && state.byMint.get(card.getAttribute("data-mint"));
    if (token) { cardFor(token); tick(); }
  }, true);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) load(false); });
  setInterval(tick, 1000);

  load(false);
})();
