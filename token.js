/* The token page (token.html?mint=<address>).
 *
 * One token, read from Solana by the visitor's browser and read again every few seconds: its
 * game, a box to buy and sell it, its rules in plain sentences, its curve. Everything on the
 * chain goes through window.LureChain (vendor/lure-chain.js); everything about the cluster
 * comes from window.LURE_NET (net.js). This file only decides what the page says.
 */
(function () {
  "use strict";

  const NET = window.LURE_NET;
  const chain = window.LureChain;
  const $ = (id) => document.getElementById(id);
  const el = {
    title: $("tk-title"), id: $("tk-id"), status: $("tk-status"), body: $("tk-body"),
    game: $("tk-game"), gameK: $("tk-game-k"), clock: $("tk-clock"), state: $("tk-state"), pot: $("tk-pot"),
    leadK: $("tk-lead-k"), lead: $("tk-lead"), timer: $("tk-timer"), last: $("tk-last"),
    pay: $("tk-pay"), payBtn: $("tk-pay-btn"), payOut: $("tk-pay-out"),
    buy: $("tk-side-buy"), sell: $("tk-side-sell"), form: $("tk-form"), amount: $("tk-amount"), amountLabel: $("tk-amount-label"),
    unit: $("tk-unit"), balance: $("tk-balance"), quick: $("tk-quick"), quote: $("tk-quote"), slippage: $("tk-slippage"),
    go: $("tk-go"), out: $("tk-out"), fee: $("tk-fee"),
    rules: $("tk-rules"), stats: $("tk-stats"), curve: $("tk-curve"),
    stamp: $("stamp"), find: $("tk-find-input"), walletBtn: document.querySelector("[data-wallet]"),
  };
  if (Object.values(el).some((node) => !node)) return;

  /* ================= Words and numbers ================= */

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const short = (a) => (a && a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a || "");
  const fmtInt = (n) => Math.round(n).toLocaleString("en-US");
  const fmtTokens = (n) => n.toLocaleString("en-US", { maximumFractionDigits: n >= 1000 ? 0 : n >= 1 ? 2 : 6 });
  // SOL to four significant digits, never in exponent form: 1.008, 0.00396, 0.000000001008.
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
  const addr = (a) => `<a class="tk-addr" href="${esc(NET.addressUrl(a))}" target="_blank" rel="noopener" title="${esc(a)}">${esc(short(a))}</a>`;
  const txLink = (sig) => `<a href="${esc(NET.txUrl(sig))}" target="_blank" rel="noopener">Transaction ${esc(short(sig))} ↗</a>`;
  const timeNow = (ms) => new Date(ms).toLocaleTimeString("en-GB", { hour12: false });
  // Only touches the page when what it says has changed, so focus and selection survive a refresh.
  function setHtml(node, html) { if (node.__html !== html) { node.__html = html; node.innerHTML = html; } }
  function setText(node, text) { if (node.textContent !== text) node.textContent = text; }

  function problem(html) {
    el.status.className = "tk-status is-error";
    el.status.setAttribute("role", "alert");
    el.status.__html = null;
    el.status.innerHTML = html;
  }
  function note(html) {
    el.status.className = "tk-status";
    el.status.removeAttribute("role");
    setHtml(el.status, html);
  }

  /* ================= Before anything is read ================= */

  // Devnet notes show on devnet only.
  for (const node of document.querySelectorAll("[data-net]")) node.hidden = !NET || node.getAttribute("data-net") !== NET.cluster;
  if (!NET || !chain) return problem("This page could not load its scripts (net.js and vendor/lure-chain.js).");

  const asked = (new URLSearchParams(window.location.search).get("mint") || "").trim();
  if (asked) el.find.value = asked;
  const notReady = NET.notReady(["rpcUrl", "hookProgram", "leashProgram", "configs"]);
  if (notReady) return problem(esc(notReady));

  const wallets = chain.wallets;
  wallets.button(el.walletBtn);

  const mint = asked || (NET.demo && NET.demo.mint) || "";
  const demoLink = asked && NET.demo && NET.demo.mint ? ` <a class="linkish" href="token.html">Open the demo token</a>` : "";
  if (!mint) return problem("No token in the link. Paste a token's address below.");
  if (!chain.isAddress(mint)) return problem(`That is not a Solana address.${demoLink}`);
  el.id.innerHTML = `${asked ? "Token" : "No token in the link, so this is the demo token:"} ${addr(mint)} on ${esc(NET.cluster)}`;

  const REFRESH = 5000; // one RPC call each time, two with a wallet connected
  const reduce = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const state = {
    token: null, program: null, side: "buy", balances: null, quote: null, quoteError: "", quoteRun: 0,
    busy: false, failures: 0, timer: 0, quoteTimer: 0, stopped: false, sawOver: false,
  };

  /* ================= Reading, again and again ================= */

  function schedule(ms) {
    clearTimeout(state.timer);
    if (!state.stopped) state.timer = setTimeout(load, ms);
  }

  async function load() {
    clearTimeout(state.timer);
    // After the first read, a tab nobody is looking at stops asking; it picks up again when it is looked at.
    if (state.stopped || (document.hidden && state.token)) return;
    try {
      const token = await chain.readToken(mint, { maxAge: 2000 });
      state.token = token;
      state.failures = 0;
      state.sawOver = false;
      render(token);
      note(`Read from ${esc(NET.cluster)} at ${esc(timeNow(token.readAt))}, slot ${esc(fmtInt(token.slot))}.`);
      balances();
      requote(false);
      schedule(REFRESH);
    } catch (error) {
      const kind = error && error.kind;
      if (kind === "not-found" || kind === "not-lure" || kind === "bad-address" || kind === "bad-config" || kind === "not-ready") {
        state.stopped = true;
        el.body.hidden = true;
        return problem(`${esc(error.message)}${demoLink}`);
      }
      state.failures++;
      const wait = Math.min(40000, REFRESH * 2 ** state.failures);
      const why = kind === "rate" ? `${esc(NET.cluster)} asked this browser to slow down` : `${esc(NET.cluster)} did not answer`;
      const text = `${why.charAt(0).toUpperCase()}${why.slice(1)}. Asking again in ${Math.round(wait / 1000)} seconds.`;
      if (state.token) note(`${text} What you see was read at ${esc(timeNow(state.token.readAt))}.`); else problem(text);
      schedule(wait);
    }
  }

  async function balances() {
    const wallet = wallets.current();
    if (!wallet) { state.balances = null; return chrome(); }
    try {
      const held = await chain.readWallet(wallet.address, mint);
      if (wallets.current() && wallets.current().address === held.address) state.balances = held;
    } catch { /* the last balances stay; the next refresh asks again */ }
    chrome();
  }

  /* ================= The page ================= */

  function render(token) {
    const symbol = token.symbol || "tokens";
    setHtml(el.title, `${esc(token.name || "Unnamed token")}<br><span class="accent">${token.symbol ? `$${esc(token.symbol)}` : ""}</span>`);
    document.title = `${token.name || "Token"}${token.symbol ? ` ($${token.symbol})` : ""} · Lure`;
    const curve = token.graduated ? "Graduated" : token.curve === "infinite" ? "Infinite bonding" : "Graduating curve";
    setHtml(el.id, `${asked ? "Token" : "No token in the link, so this is the demo token:"} ${addr(token.mint)} on ${esc(NET.cluster)} · ${curve}`
      + (token.leash ? ` · <a href="agent.html?leash=${encodeURIComponent(token.leash)}">Its agent's leash</a>` : ""));

    renderGame(token);
    setHtml(el.rules, rulesHtml(token, symbol));
    setHtml(el.stats, [
      ["Price", fmtSol(token.price), "SOL"],
      ["Market cap", fmtSol(token.marketCap), "SOL"],
      ["In the curve", fmtSol(token.solInCurve), "SOL"],
      ["Left on the curve", fmtPct(token.supplyLeft), "of supply"],
    ].map(([k, v, unit]) => `<div><dt>${k}</dt><dd>${esc(v)} <small>${unit}</small></dd></div>`).join(""));
    setHtml(el.curve, curveHtml(token));
    el.curve.className = `tcurve tk-curve${token.curve === "infinite" ? " is-perm" : ""}`;
    const f = NET.fees;
    setText(el.fee, `${f.total}% per trade: ${f.creator}% creator, ${f.treasury}% Lure treasury, ${f.protocol}% Meteora.`);
    chrome();
    el.body.hidden = false;
  }

  function renderGame(token) {
    const game = token.rules && token.rules.game;
    el.game.hidden = !game;
    if (!game) return;
    setText(el.gameK, `Last Buyer Wins · round ${fmtInt(game.round)}`);
    setText(el.pot, `${fmtSol(game.pot)} SOL`);
    setText(el.timer, game.clock ? chain.clockWords(game.clock) : "its agent's setting");
    const prize = game.lastPrize > 0 ? `: ${esc(fmtSol(game.lastPrize))} SOL` : ", with nothing in the pot to pay";
    setHtml(el.last, game.lastWinner
      ? `Round ${fmtInt(game.round - 1)} went to ${addr(game.lastWinner)}${prize}.${game.totalPaid > game.lastPrize ? ` ${esc(fmtSol(game.totalPaid))} SOL paid in all.` : ""}`
      : "");
    tick();
  }

  // Four times a second: the clock counts down to the deadline that is on the chain.
  function tick() {
    const token = state.token;
    const game = token && token.rules && token.rules.game;
    if (!game) return;
    const symbol = token.symbol || "tokens";
    const now = Date.now() / 1000 + token.clockSkew; // the chain's time, not this device's
    const left = game.deadline ? game.deadline - now : 0;
    const phase = game.deadline ? (left > 0 ? "running" : "over") : game.phase;
    const least = game.minBuy > 0 ? `A buy of ${fmtTokens(game.minBuy)} ${symbol} or more` : "Any buy";

    let clock, cls = "", words;
    if (!token.hooked) {
      clock = "--:--"; cls = "is-idle";
      words = "This token left its curve and its hook is gone. No new round can start.";
    } else if (phase === "running") {
      clock = clockText(left);
      words = `Running. ${least} takes the lead and restarts the clock.`;
    } else if (phase === "over") {
      clock = "00:00"; cls = "is-over";
      words = "Over. Waiting to be paid.";
    } else {
      clock = game.clock ? clockText(game.clock) : "--:--"; cls = "is-idle";
      const guard = token.rules.blockLimit;
      words = phase === "guard"
        ? (guard && guard.opened && guard.slotsLeft !== null ? `The guard is up for about ${fmtInt(guard.slotsLeft)} more blocks. The game starts when it comes down.` : "The guard comes up with the first buy. The game starts when it comes down.")
        : `Waiting for its first buy. ${least} starts the clock.`;
    }
    setText(el.clock, clock);
    el.clock.className = `tk-clock${cls ? ` ${cls}` : ""}${clock.length > 5 ? " is-long" : ""}`;
    setText(el.state, words);
    setText(el.leadK, phase === "over" ? "Last buyer" : "Leads");
    setHtml(el.lead, game.lastBuyer ? addr(game.lastBuyer) : "Nobody yet");
    el.pay.hidden = !(phase === "over" && game.lastBuyer);
    // The clock just ran out here: look at the chain now instead of waiting for the next read.
    if (phase === "over" && game.phase === "running" && !state.sawOver) { state.sawOver = true; schedule(600); }
  }

  function rulesHtml(token, symbol) {
    const r = token.rules, sym = esc(symbol);
    if (!r) return `<li>This token has no Lure rules: its hook has nothing to check.</li>`;
    const items = [];
    if (!r.curveOk) items.push(`<li><b>Careful.</b> These rules do not name Meteora's curve as the seller, so the hook treats every trade as a plain transfer.</li>`);
    if (r.cap) {
      items.push(r.cap.tokens === null
        ? `<li><b>Wallet cap.</b> Set by the token's agent, inside its leash.</li>`
        : `<li><b>Wallet cap.</b> A wallet can hold at most ${esc(fmtTokens(r.cap.tokens))} ${sym}, ${esc(fmtPct(r.cap.share))} of supply.${r.cap.fromLeash ? " Its agent can move this number, inside its leash." : ""}</li>`);
    }
    if (r.blockLimit) {
      const b = r.blockLimit;
      const now = b.forever ? "This guard never comes down."
        : !b.opened ? `The guard comes up with the first buy and lasts ${esc(fmtInt(b.guardSlots))} blocks.`
        : b.up ? `The guard is up: about ${esc(fmtInt(b.slotsLeft))} blocks left.`
        : `The guard lasted ${esc(fmtInt(b.guardSlots))} blocks from the first buy. It is down now.`;
      items.push(`<li><b>Block limit.</b> While the guard is up, at most ${esc(fmtTokens(b.tokens))} ${sym}, ${esc(fmtPct(b.share))} of supply, can be bought from the curve in one block.<span class="tk-now">${now}</span></li>`);
    }
    if (r.game) {
      const g = r.game;
      const least = g.minBuy > 0 ? `a buy of ${esc(fmtTokens(g.minBuy))} ${sym} or more` : "any buy";
      const sets = g.clock ? `sets the clock to ${esc(chain.clockWords(g.clock))}` : "restarts the clock";
      const who = !g.clockFromLeash ? "The clock's length was fixed at launch."
        : `The clock's length is set by the token's agent${g.clockRange ? `, between ${esc(chain.clockWords(g.clockRange.min))} and ${esc(chain.clockWords(g.clockRange.max))}` : ""}.`
          + (token.leash ? ` <a href="agent.html?leash=${encodeURIComponent(token.leash)}">See its leash</a>` : "");
      items.push(`<li><b>Last Buyer Wins.</b> ${r.blockLimit ? "Once the guard is down, " : ""}${r.blockLimit ? least : least.charAt(0).toUpperCase() + least.slice(1)} takes the lead and ${sets}. When the clock runs out, the last buyer takes the pot.<span class="tk-now">${who}</span></li>`);
    }
    items.push(`<li><b>A sell always lands.</b> The hook only counts it.</li>`);
    if (token.curve === "graduating" && !token.graduated) items.push(`<li><b>Until graduation.</b> When the curve graduates, Meteora removes the hook and every rule here stops.</li>`);
    const p = state.program;
    const program = !p || p.upgradeable === null ? "" : p.upgradeable ? ` Its program can still be upgraded by ${addr(p.authority)}.` : " Its program is final: nobody can upgrade it.";
    items.push(`<li><b>Fixed at launch.</b> The hook has no instruction to change a token's rules. The hook is not audited.${program}<span class="tk-now">Transfers it has let through so far: ${esc(fmtInt(r.transfers))}.</span></li>`);
    return items.join("");
  }

  function curveHtml(token) {
    if (token.graduated) return `<span class="tcurve-k">Graduated</span><p>This token left its curve. It trades on a Meteora pool now, without its hook.</p>`;
    if (token.curve === "infinite") return `<span class="tcurve-k">∞ Infinite bonding</span><p>This curve never graduates, so the hook stays for the life of the token.</p>`;
    const g = token.graduation;
    return `<div class="tbar"><i style="width:${(token.progress * 100).toFixed(1)}%"></i></div>`
      + `<p><b>${esc(fmtPct(token.progress))}</b> of the way to graduating. At ${esc(fmtSol(g.sol))} SOL in the curve (${esc(fmtSol(g.marketCap))} SOL of market cap) the token moves to a Meteora pool and its hook is removed.</p>`;
  }

  /* ================= The trade box ================= */

  const symbolNow = () => (state.token && state.token.symbol) || "tokens";
  const slippage = () => Number(el.slippage.value) || 100;

  // Everything in the box that depends on the side, the wallet and the token, but not on the amount.
  function chrome() {
    const token = state.token, wallet = wallets.current(), symbol = symbolNow(), buying = state.side === "buy";
    el.buy.setAttribute("aria-pressed", String(buying));
    el.sell.setAttribute("aria-pressed", String(!buying));
    setText(el.amountLabel, buying ? "You pay" : "You sell");
    setText(el.unit, buying ? "SOL" : symbol);
    const held = state.balances && wallet && state.balances.address === wallet.address ? state.balances : null;
    setText(el.balance, wallet
      ? (held ? `Wallet ${short(wallet.address)}: ${fmtSol(held.sol)} SOL · ${fmtTokens(held.tokens)} ${symbol}` : `Wallet ${short(wallet.address)}`)
      : wallets.list().some((w) => w.installed) ? "No wallet connected." : "No wallet found in this browser. Reading still works.");
    const chips = buying ? [["0.01", "0.01 SOL"], ["0.05", "0.05 SOL"], ["0.1", "0.1 SOL"]]
      : held && held.tokens > 0 ? [[25, "25%"], [50, "50%"], [100, "All"]].map(([part, label]) => [unitsText((BigInt(held.tokensRaw) * BigInt(part)) / 100n, 6), label]) : [];
    setHtml(el.quick, chips.map(([value, label]) => `<button type="button" class="chip" data-amount="${esc(value)}">${esc(label)}</button>`).join(""));
    const gone = !!(token && token.graduated);
    el.amount.disabled = gone;
    setText(el.go, gone ? "Not trading here" : !wallet ? "Connect wallet" : state.busy ? "Working…" : buying ? `Buy ${symbol}` : `Sell ${symbol}`);
    el.go.disabled = gone || state.busy || (!!wallet && !el.amount.value.trim());
    el.payBtn.disabled = state.busy;
  }

  // Base units as a decimal string, exactly: "All" must sell every last unit.
  function unitsText(units, decimals) {
    const text = units.toString().padStart(decimals + 1, "0");
    return `${text.slice(0, -decimals)}.${text.slice(-decimals)}`.replace(/\.?0+$/, "");
  }

  function requote(wait = true) {
    clearTimeout(state.quoteTimer);
    const text = el.amount.value.trim();
    const run = ++state.quoteRun;
    if (!text || !state.token || state.token.graduated) {
      state.quote = null;
      state.quoteError = "";
      return renderQuote();
    }
    state.quoteTimer = setTimeout(async () => {
      const wallet = wallets.current();
      try {
        const quote = await chain.quote({ mint, side: state.side, amount: text, slippageBps: slippage(), owner: wallet ? wallet.address : null });
        if (run !== state.quoteRun) return;
        state.quote = quote;
        state.quoteError = "";
      } catch (error) {
        if (run !== state.quoteRun) return;
        state.quote = null;
        state.quoteError = (error && error.message) || "No quote.";
      }
      renderQuote();
    }, wait ? 250 : 0);
  }

  function renderQuote() {
    const token = state.token, q = state.quote, symbol = symbolNow();
    chrome();
    if (token && token.graduated) return setHtml(el.quote, "<p>This token left its curve. It trades on a Meteora pool now, not here.</p>");
    if (state.quoteError) return setHtml(el.quote, `<p>${esc(state.quoteError)}</p>`);
    if (!q) return setHtml(el.quote, `<p>Enter an amount to see what you get, the fee, and what the hook will check.</p>`);
    const out = q.side === "buy" ? `${fmtTokens(q.out)} ${symbol}` : `${fmtSol(q.out)} SOL`;
    const least = q.side === "buy" ? `${fmtTokens(q.minOut)} ${symbol}` : `${fmtSol(q.minOut)} SOL`;
    const checks = q.checks.map((c) => `<li${c.ok ? "" : ' class="is-no"'}>${esc(c.text)}</li>`).join("");
    setHtml(el.quote,
      `<p>You get about <b>${esc(out)}</b>.</p>`
      + `<p>At least ${esc(least)}, or the trade is refused.</p>`
      + `<p>Fee ${esc(String(q.feePct))}%: ${esc(fmtSol(q.fee))} SOL.</p>`
      + (q.partial ? `<p>The curve can only take ${esc(fmtSol(q.amountIn))} SOL more: this buy fills it.</p>` : "")
      + (checks ? `<ul class="tk-checks" aria-label="What will be checked">${checks}</ul>` : ""));
  }

  /* ================= Signing and sending ================= */

  const stepWords = (step) => {
    const many = step.count > 1 ? ` (${step.index + 1} of ${step.count})` : "";
    return step.phase === "simulating" ? `Asking ${esc(NET.cluster)} what it would answer…`
      : step.phase === "signing" ? "Waiting for your wallet…"
      : step.phase === "sending" ? `Sending${many}…`
      : step.phase === "confirming" ? `Sent${many}. Waiting for ${esc(NET.cluster)} to confirm…`
      : `Confirmed${many}.`;
  };

  let stampTimer = 0, flashed = false;
  function stamp(near) {
    const box = near.getBoundingClientRect(), W = document.documentElement.clientWidth, H = window.innerHeight;
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

  // No wallet: say what is missing, and open the wallet control when there is one to open.
  function needWallet(out) {
    const installed = wallets.list().some((w) => w.installed);
    out.innerHTML = installed ? "No wallet connected. Connect one, then press again."
      : "No wallet found in this browser. Install Phantom, Solflare or Backpack, or open this page inside your wallet's browser.";
    if (installed) el.walletBtn.click(); else el.walletBtn.focus();
  }

  // Builds, simulates, has the wallet sign, sends, waits. `build` gets the connected wallet.
  async function run(out, button, build, done) {
    const wallet = wallets.current();
    if (!wallet) return needWallet(out);
    if (state.busy) return;
    state.busy = true;
    out.setAttribute("aria-busy", "true");
    out.innerHTML = "Building the transaction…";
    chrome();
    try {
      const built = await build(wallet);
      const sent = await chain.send(built, wallet, { onStep: (step) => { out.innerHTML = stepWords(step) + (step.signature ? ` ${txLink(step.signature)}` : ""); } });
      out.innerHTML = `<span class="ok">${done(built)}</span> ${txLink(sent.signature)}`;
      el.amount.value = "";
      state.quote = null;
      renderQuote();
      load();
    } catch (error) {
      const kind = error && error.kind;
      if (kind === "refused") {
        stamp(button);
        const landed = error.landed && error.signature ? ` It reached the chain and failed there: ${txLink(error.signature)}` : " Nothing was sent.";
        out.innerHTML = `<span class="no">Refused.</span> ${esc(error.message)}${landed}`;
      } else {
        out.innerHTML = esc((error && error.message) || String(error));
      }
    } finally {
      state.busy = false;
      out.removeAttribute("aria-busy");
      chrome();
    }
  }

  el.form.addEventListener("submit", (event) => {
    event.preventDefault();
    const amount = el.amount.value.trim();
    if (!wallets.current()) return needWallet(el.out);
    if (!amount) return el.amount.focus();
    const side = state.side, symbol = symbolNow();
    run(el.out, el.go,
      (wallet) => (side === "buy"
        ? chain.buildBuy({ mint, owner: wallet.address, sol: amount, slippageBps: slippage() })
        : chain.buildSell({ mint, owner: wallet.address, tokens: amount, slippageBps: slippage() })),
      (built) => (side === "buy"
        ? `Bought about ${esc(fmtTokens(built.quote.out))} ${esc(symbol)} for ${esc(fmtSol(built.quote.amountIn))} SOL.`
        : `Sold ${esc(fmtTokens(built.quote.amountIn))} ${esc(symbol)} for about ${esc(fmtSol(built.quote.out))} SOL.`));
  });

  el.payBtn.addEventListener("click", () => {
    run(el.payOut, el.payBtn,
      (wallet) => chain.buildSettle({ mint, payer: wallet.address }),
      (built) => `Paid. Round ${esc(fmtInt(built.round))} is closed and its pot went to ${esc(short(built.winner))}.`);
  });

  function setSide(side) {
    if (state.side === side) return;
    state.side = side;
    el.amount.value = "";
    el.out.innerHTML = "";
    requote(false);
  }
  el.buy.addEventListener("click", () => setSide("buy"));
  el.sell.addEventListener("click", () => setSide("sell"));
  el.amount.addEventListener("input", () => requote(true));
  el.slippage.addEventListener("change", () => requote(false));
  el.quick.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-amount]");
    if (!chip) return;
    el.amount.value = chip.getAttribute("data-amount");
    requote(false);
  });

  wallets.on(() => { state.balances = null; chrome(); balances(); requote(false); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
  setInterval(tick, 250);

  renderQuote();
  // Whether the hook can still be upgraded: asked once, said in the rules.
  chain.programStatus("hook").then((status) => { state.program = status; if (state.token) setHtml(el.rules, rulesHtml(state.token, state.token.symbol || "tokens")); }).catch(() => {});
  load();
})();
