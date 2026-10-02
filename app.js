/* Shared data and helpers for every Lure page: fees, the hook catalog, token cards, storage, toast. */
window.LURE = (() => {
  // Every trade on a Lure curve pays FEES.total percent, split like this (percent of trade volume).
  // Meteora's bonding curve keeps 20% of the trading fee (PROTOCOL_FEE_PERCENT), so 1% nets 0.8%:
  // the creator gets half of it, the platform the other half (treasury and $LURE buyback).
  const FEES = { total: 1, creator: 0.4, treasury: 0.2, buyback: 0.2, protocol: 0.2 };

  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const wallet = () => {
    const s = (n) => Array.from({ length: n }, () => pick(B58)).join("");
    return `${s(4)}…${s(4)}`;
  };
  const shortAddr = (a) => (a && a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a || "");
  const isAddress = (a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a || "");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const fmtUsd = (n) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${Math.round(n)}`);
  const fmtNum = (n) => Number(n).toLocaleString("en-US");
  const fmtSol = (n) => `${n === 0 ? "0" : n < 0.01 ? n.toFixed(4) : n.toFixed(2)} SOL`;
  const fmtAge = (min) =>
    min < 1 ? "just now" : min < 60 ? `${Math.round(min)}m ago` : min < 1440 ? `${Math.round(min / 60)}h ago` : `${Math.round(min / 1440)}d ago`;
  const fmtClock = (sec) => {
    const t = Math.max(0, Math.ceil(sec));
    const m = Math.floor(t / 60), s = t % 60;
    return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  };

  /* ---------------- Hook catalog ---------------- */
  const CATEGORIES = { games: "Game", access: "Access", guards: "Guard", oracle: "Oracle" };
  // Only one hook from each of these categories per token.
  const EXCLUSIVE = new Set(["games", "oracle"]);

  // settings: number fields by default; type "select" or "address" otherwise.
  // dsl(settings, launch) returns the line(s) the rule builder shows for this hook.
  const HOOKS = [
    {
      id: "lbw", cat: "games", name: "Last Buyer Wins", orig: true,
      desc: "Every qualifying buy resets a countdown. When it hits zero, the last buyer claims the pot.",
      settings: [
        { key: "timer", label: "Countdown", unit: "min", min: 1, max: 60, step: 1, def: 10 },
        { key: "minBuy", label: "Minimum buy", unit: "% supply", min: 0.01, max: 1, step: 0.01, def: 0.05 },
      ],
      dsl: (s, l) => `game last_buyer_wins { timer ${s.timer}m, min_buy ${s.minBuy}%, pot ${l.potShare}% of creator_fee }`,
    },
    {
      id: "kob", cat: "games", name: "King of the Block", orig: true,
      desc: "The biggest buy in each round takes a slice of the pot. The hook counts the rounds, not a server.",
      settings: [
        { key: "round", label: "Round length", unit: "min", min: 1, max: 60, step: 1, def: 5 },
        { key: "payout", label: "Pot paid per round", unit: "%", min: 5, max: 100, step: 5, def: 20 },
      ],
      dsl: (s, l) => `game king_of_the_block { round ${s.round}m, payout ${s.payout}%, pot ${l.potShare}% of creator_fee }`,
    },
    {
      id: "dh", cat: "games", name: "Diamond Hands", orig: true,
      desc: "The hook stamps when each wallet started holding. Selling resets the streak; the longest streaks earn rewards.",
      settings: [
        { key: "top", label: "Wallets paid", unit: "top", min: 1, max: 100, step: 1, def: 10 },
        { key: "period", label: "Pays every", type: "select", options: [["week", "Week"], ["day", "Day"]], def: "week" },
      ],
      dsl: (s, l) => `game diamond_hands { top ${s.top}, every ${s.period}, pot ${l.potShare}% of creator_fee }`,
    },
    {
      id: "fac", cat: "games", name: "Factions", orig: true,
      desc: "Two tokens, one war. The hook tallies net buys per round and the winning side's holders split the pot.",
      settings: [
        { key: "rival", label: "Rival token mint", type: "address", def: "" },
        { key: "round", label: "Round length", unit: "h", min: 1, max: 168, step: 1, def: 24 },
      ],
      dsl: (s, l) => `game factions { rival ${shortAddr(s.rival) || "?"}, round ${s.round}h, pot ${l.potShare}% of creator_fee }`,
    },
    {
      id: "pass", cat: "access", name: "Lure Pass", orig: true,
      desc: "Every launch opens with an early window where only wallets holding $LURE can buy.",
      settings: [
        { key: "window", label: "Pass window", unit: "min", min: 1, max: 60, step: 1, def: 5 },
        { key: "min", label: "Minimum held", unit: "$LURE", min: 1000, max: 10000000, step: 1000, def: 50000 },
      ],
      dsl: (s) => `when age < ${s.window}m and holds($LURE) < ${s.min} -> refuse buy`,
    },
    {
      id: "devlock", cat: "access", name: "Dev Lock", orig: true,
      desc: "The creator's own wallet is locked by the hook: no sells during the cliff, then a daily cap.",
      settings: [
        { key: "cliff", label: "Cliff", unit: "days", min: 1, max: 90, step: 1, def: 7 },
        { key: "daily", label: "Daily sell cap after", unit: "% of bag", min: 0.1, max: 10, step: 0.1, def: 1 },
      ],
      dsl: (s) => `creator -> lock ${s.cliff}d then sell ${s.daily}% per day`,
    },
    {
      id: "gated", cat: "access", name: "Holder-gated",
      desc: "Only wallets holding a token or NFT you pick can receive. Communities launch for their own.",
      settings: [
        { key: "gate", label: "Gate token mint", type: "address", def: "" },
        { key: "min", label: "Minimum held", unit: "tokens", min: 1, max: 1e12, step: 1, def: 1 },
      ],
      dsl: (s) => `always -> require holds(${shortAddr(s.gate) || "?"}) >= ${s.min}`,
    },
    {
      id: "sniper", cat: "guards", name: "Sniper-fee cap",
      desc: "Buys paying giant priority fees or Jito tips during the launch window are refused.",
      settings: [
        { key: "window", label: "Launch window", unit: "min", min: 1, max: 1440, step: 1, def: 10 },
        { key: "fee", label: "Max priority fee", unit: "SOL", min: 0.0001, max: 0.05, step: 0.0001, def: 0.002 },
        { key: "tip", label: "Max Jito tip", unit: "SOL", min: 0, max: 0.05, step: 0.0001, def: 0.002 },
      ],
      dsl: (s) => `when age < ${s.window}m -> max_priority_fee ${s.fee} SOL, max_tip ${s.tip} SOL`,
    },
    {
      id: "maxw", cat: "guards", name: "Max per wallet",
      desc: "No wallet can hold more than your cap. The pool is exempt, so trading never breaks.",
      settings: [{ key: "pct", label: "Max per wallet", unit: "% supply", min: 0.1, max: 5, step: 0.1, def: 1 }],
      dsl: (s) => `always -> max_wallet ${s.pct}%`,
    },
    {
      id: "sliding", cat: "guards", name: "Sliding caps",
      desc: "Per-sell caps tighten as market cap grows, so whales exit in ever smaller pieces.",
      settings: [
        { key: "sell0", label: "Max sell at launch", unit: "% supply", min: 0.05, max: 5, step: 0.05, def: 1 },
        { key: "mc", label: "Tighten from", unit: "$ mcap", min: 10000, max: 1e9, step: 10000, def: 1000000 },
        { key: "sell1", label: "Max sell after", unit: "% supply", min: 0.05, max: 5, step: 0.05, def: 0.25 },
      ],
      dsl: (s) => `always -> max_sell ${s.sell0}%\nwhen mcap > $${fmtNum(s.mc)} -> max_sell ${s.sell1}%`,
    },
    {
      id: "bundle", cat: "guards", name: "Anti-bundle",
      desc: "Only a few trades per block. A bundler can't buy up the launch in one shot.",
      settings: [{ key: "n", label: "Max trades per block", unit: "trades", min: 1, max: 20, step: 1, def: 3 }],
      dsl: (s) => `always -> max_trades_per_block ${s.n}`,
    },
    {
      id: "price", cat: "oracle", name: "Price trigger", orig: true,
      desc: "Sells stay locked until a Pyth price feed crosses your target, like BTC above $150k. Then it unlocks for good.",
      settings: [
        { key: "feed", label: "Price feed", type: "select", options: [["BTC/USD", "BTC/USD"], ["ETH/USD", "ETH/USD"], ["SOL/USD", "SOL/USD"]], def: "BTC/USD" },
        { key: "target", label: "Unlock sells at", unit: "$", min: 1, max: 1e9, step: 1, def: 150000 },
      ],
      dsl: (s) => `when pyth("${s.feed}") < ${s.target} -> refuse sell`,
    },
    {
      id: "mood", cat: "oracle", name: "Market mood", orig: true,
      desc: "Sell caps loosen while SOL pumps and tighten while it dumps, read live from Pyth on every trade.",
      settings: [
        { key: "base", label: "Base max sell", unit: "% supply", min: 0.05, max: 5, step: 0.05, def: 0.5 },
        { key: "sens", label: "Sensitivity", unit: "%", min: 1, max: 100, step: 1, def: 25 },
      ],
      dsl: (s) => `always -> max_sell ${s.base}% scaled_by pyth("SOL/USD").change_1h * ${s.sens}%`,
    },
  ];
  const hookById = Object.fromEntries(HOOKS.map((h) => [h.id, h]));
  const defaults = (h) => Object.fromEntries(h.settings.map((f) => [f.key, f.def]));

  /* ---------------- Rule-language highlighting ---------------- */
  const TOKEN =
    /(#[^\n]*)|("[^"]*")|\b(rule|when|always|and|or|then|feed|game|refuse|unlock|lock|creator|forever|per|require|every|of|scaled_by)\b|(\$[A-Z]+)|(?<![\w$])(\$?\d[\d,.]*(?:%|m|h|d|k)?)|\b([a-z_]+)(?=\()|(->|>=|<|>)/g;

  function highlight(src) {
    let out = "", last = 0;
    for (const m of src.matchAll(TOKEN)) {
      out += esc(src.slice(last, m.index));
      const [all, com, str, kw, ticker, num, fn, op] = m;
      if (com) out += `<span class="tk-c">${esc(com)}</span>`;
      else if (str) out += `<span class="tk-s">${esc(str)}</span>`;
      else if (kw) out += `<span class="tk-k">${kw}</span>`;
      else if (ticker) out += `<span class="tk-s">${ticker}</span>`;
      else if (num) out += `<span class="tk-n">${num}</span>`;
      else if (fn) out += `<span class="tk-f">${fn}</span>`;
      else if (op) out += `<span class="tk-k">${esc(op)}</span>`;
      else out += esc(all);
      last = m.index + all.length;
    }
    return out + esc(src.slice(last));
  }

  /* ---------------- Token card ---------------- */
  const AVATAR_COLORS = [["#fd4b00", "#000"], ["#f6eee6", "#000"], ["#ff9a66", "#000"], ["#1a1715", "#fd4b00"]];
  const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7) >>> 0;
  const progress = (t) => Math.max(0, Math.min(100, ((t.mc - t.startMc) / (t.gradMc - t.startMc)) * 100));
  const ageMin = (t) => t.ageMin ?? (Date.now() - t.createdAt) / 60000;

  function avatar(t) {
    if (t.image) return `<img src="${esc(t.image)}" alt="">`;
    const key = t.ticker || t.name || "?";
    const [bg, fg] = AVATAR_COLORS[hash(key) % AVATAR_COLORS.length];
    return `<span class="tav-gen" style="background:${bg};color:${fg}">${esc(key.charAt(0).toUpperCase())}</span>`;
  }

  function gameLine(t) {
    const g = t.game;
    if (!g) return "";
    const clock = (label) => `<span class="tclock" data-ends="${g.endsAt || ""}">${g.endsAt ? fmtClock((g.endsAt - Date.now()) / 1000) : label}</span>`;
    let body = "";
    if (g.type === "lbw") body = `<span>Pot <b data-f="pot">${fmtSol(g.pot)}</b></span>${clock("starts at launch")}`;
    else if (g.type === "kob") body = `<span>Round pot <b data-f="pot">${fmtSol(g.pot)}</b></span>${clock("starts at launch")}`;
    else if (g.type === "dh") body = `<span>Top streak <b>${g.streak || 0}d</b></span><span class="tgame-note">pays every ${esc(g.period || "week")}</span>`;
    else if (g.type === "fac") body = `<span><b>${g.share ?? 50}%</b> vs ${100 - (g.share ?? 50)}%</span><span class="tgame-note">vs ${esc(g.rival || "rival")}</span>`;
    return `<div class="tgame"><span class="tgame-k">${hookById[g.type].name}</span>${body}</div>`;
  }

  function curveBlock(t) {
    if (t.curve === "permanent") return `<div class="tcurve is-perm"><span class="tcurve-k">∞ Permanent curve</span><span class="tcurve-note">hooks run forever</span></div>`;
    if (t.curve === "graduated") return `<div class="tcurve is-grad"><span class="tcurve-k">Graduated</span><span class="tcurve-note">on Meteora · hooks off</span></div>`;
    const p = progress(t);
    return `<div class="tcurve">
        <div class="tbar"><i data-f="bar" style="width:${p.toFixed(1)}%"></i></div>
        <span><b data-f="prog">${Math.floor(p)}%</b> to graduation</span><span class="tcurve-note">at ${fmtUsd(t.gradMc)}</span>
      </div>`;
  }

  function tokenCard(t) {
    const change = t.change || 0;
    const chips = t.hooks.length
      ? t.hooks.map((id) => `<span class="hchip cat-${hookById[id].cat}">${hookById[id].name}</span>`).join("")
      : `<span class="hchip cat-none">No hooks</span>`;
    return `<article class="tcard${t.mine ? " is-mine" : ""}${t.curve === "graduated" ? " is-grad" : ""}" data-id="${esc(t.id)}">
      <header class="tcard-head">
        <div class="tav">${avatar(t)}</div>
        <div class="tid">
          <h3><span class="tname">${esc(t.name)}</span> <span class="ttick">$${esc(t.ticker)}</span></h3>
          <p class="tby">${t.mine ? `<span class="tmine">Yours · demo</span>` : `by ${esc(t.creator)}`} · ${fmtAge(ageMin(t))}</p>
        </div>
        ${t.vol24
          ? `<span class="tchg ${change >= 0 ? "up" : "down"}" data-f="chg">${change >= 0 ? "+" : "−"}${Math.abs(change).toFixed(1)}%</span>`
          : `<span class="tchg is-fresh">New</span>`}
      </header>
      ${t.desc ? `<p class="tdesc">${esc(t.desc)}</p>` : ""}
      <div class="thooks">${chips}</div>
      ${gameLine(t)}
      <dl class="tstats">
        <div><dt>Market cap</dt><dd data-f="mc">${fmtUsd(t.mc)}</dd></div>
        <div><dt>Vol 24h</dt><dd>${fmtUsd(t.vol24)}</dd></div>
        <div><dt>Holders</dt><dd>${fmtNum(t.holders)}</dd></div>
      </dl>
      ${curveBlock(t)}
    </article>`;
  }

  /* ---------------- Demo storage (this browser only) ---------------- */
  const STORE_KEY = "lure.demo.tokens.v1";
  function loadMine() {
    try {
      const list = JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }
  function saveMine(list) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(0, 8)));
      return true;
    } catch {
      return false;
    }
  }

  /* ---------------- Toast ---------------- */
  let toastTimer;
  function toast(msg) {
    let el = document.getElementById("toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "toast";
      el.className = "toast";
      el.setAttribute("role", "status");
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add("is-on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("is-on"), 3200);
  }

  // Wallet buttons are placeholders until the devnet beta.
  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-demo-wallet]")) toast("Wallet connect arrives with the devnet beta. This is a preview.");
  });

  return {
    FEES, CATEGORIES, EXCLUSIVE, HOOKS, hookById, defaults,
    rand, pick, wallet, shortAddr, isAddress, esc,
    fmtUsd, fmtNum, fmtSol, fmtAge, fmtClock,
    highlight, tokenCard, progress, ageMin,
    loadMine, saveMine, toast,
  };
})();
