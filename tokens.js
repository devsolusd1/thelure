(() => {
  const L = window.LURE;
  const { FEES, hookById, tokenCard, progress, ageMin, fmtUsd, fmtSol, fmtClock, rand, pick, wallet, loadMine } = L;

  /* ---------------- Demo tokens (nothing here is on-chain yet) ---------------- */
  const START = 5000, GRAD = 75000;
  const DEMO = [
    { name: "Last Bite", ticker: "BITE", desc: "Every buy resets the clock. Last one in takes the pot.", hooks: ["lbw", "pass", "sniper"], curve: "graduating", mc: 61200, vol24: 48900, change: 34.2, holders: 412, ageMin: 95, game: { type: "lbw", pot: 6.8, ends: 312, timer: 600 } },
    { name: "Krill Issue", ticker: "KRILL", desc: "Skill issue, but for krill. Nobody holds more than 1%.", hooks: ["maxw", "bundle"], curve: "graduating", mc: 28400, vol24: 19300, change: 12.5, holders: 233, ageMin: 41 },
    { name: "Diamond Fins", ticker: "FINS", desc: "Sell and your streak dies. The longest holders get paid every week.", hooks: ["dh", "devlock"], curve: "permanent", mc: 142000, vol24: 22100, change: 3.1, holders: 1208, ageMin: 12960, game: { type: "dh", streak: 19, period: "week" } },
    { name: "Team Shark", ticker: "SHARK", desc: "Sharks vs Squids. Net buys win the round.", hooks: ["fac", "maxw"], curve: "graduating", mc: 44900, vol24: 37800, change: 18.9, holders: 388, ageMin: 180, game: { type: "fac", share: 57, rival: "$SQUID" } },
    { name: "Team Squid", ticker: "SQUID", desc: "Squids vs Sharks. Ink them out of the round.", hooks: ["fac", "maxw"], curve: "graduating", mc: 39700, vol24: 35200, change: -4.2, holders: 351, ageMin: 181, game: { type: "fac", share: 43, rival: "$SHARK" } },
    { name: "Captain Hook", ticker: "CAPT", desc: "The biggest buy of every round gets crowned and paid.", hooks: ["kob", "sniper"], curve: "graduating", mc: 70300, vol24: 91000, change: 51.7, holders: 640, ageMin: 360, game: { type: "kob", pot: 2.4, ends: 140 } },
    { name: "Blobfish", ticker: "BLOB", desc: "Ugliest fish in the sea. Whales sell in small pieces.", hooks: ["maxw", "sliding"], curve: "graduating", mc: 17800, vol24: 6400, change: -8.3, holders: 120, ageMin: 18 },
    { name: "Anglerfish", ticker: "ANGLR", desc: "Hold $LURE and the first five minutes are yours.", hooks: ["pass", "devlock"], curve: "graduating", mc: 9900, vol24: 3100, change: 5.4, holders: 44, ageMin: 4 },
    { name: "BTC 150K", ticker: "BTC150K", desc: "Sells unlock the moment Pyth says Bitcoin hit $150k.", hooks: ["price"], curve: "permanent", mc: 233000, vol24: 41700, change: 2.2, holders: 2014, ageMin: 7200 },
    { name: "Salmon Run", ticker: "SALMON", desc: "Swam upstream all the way to graduation.", hooks: ["sliding", "bundle"], curve: "graduated", mc: 1840000, vol24: 412000, change: 7.7, holders: 5630, ageMin: 2880 },
    { name: "Pufferfish", ticker: "PUFF", desc: "Sell caps loosen when SOL pumps and tighten when it dumps.", hooks: ["mood", "maxw"], curve: "permanent", mc: 88000, vol24: 15400, change: -1.9, holders: 702, ageMin: 5760 },
    { name: "Koi Pond", ticker: "KOI", desc: "Members only: hold a Koi NFT to buy.", hooks: ["gated"], curve: "permanent", mc: 51300, vol24: 2900, change: 0.8, holders: 260, ageMin: 15840 },
    { name: "Reel Money", ticker: "REEL", desc: "Clock's ticking. Don't be the second-to-last buyer.", hooks: ["lbw", "maxw"], curve: "graduating", mc: 73900, vol24: 120500, change: 22.4, holders: 802, ageMin: 480, game: { type: "lbw", pot: 11.2, ends: 95, timer: 300 } },
    { name: "Tide", ticker: "TIDE", desc: "Comes in, goes out. Nobody takes more than 2% in one block.", hooks: ["bundle"], curve: "graduating", mc: 19600, vol24: 8800, change: 9.9, holders: 151, ageMin: 52 },
    { name: "Catch of the Day", ticker: "CATCH", desc: "A new king every five minutes.", hooks: ["kob"], curve: "graduating", mc: 52800, vol24: 44400, change: 15.6, holders: 470, ageMin: 120, game: { type: "kob", pot: 1.3, ends: 230 } },
    { name: "Mackerel", ticker: "MACK", desc: "Snipers stay out for the first ten minutes.", hooks: ["sniper", "pass", "maxw"], curve: "graduating", mc: 6100, vol24: 900, change: 1.2, holders: 12, ageMin: 1 },
    { name: "Moby", ticker: "MOBY", desc: "Whale-proof all the way to graduation.", hooks: ["sliding", "devlock"], curve: "graduated", mc: 3120000, vol24: 780000, change: -6.5, holders: 9120, ageMin: 8640 },
    { name: "Deep Sea Degen", ticker: "DSD", desc: "Last buyer wins, forever. The curve never ends.", hooks: ["lbw"], curve: "permanent", mc: 310000, vol24: 66000, change: 4.6, holders: 2870, ageMin: 4320, game: { type: "lbw", pot: 23.5, ends: 1720, timer: 1800 } },
  ];

  const now = Date.now();
  const demo = DEMO.map((t, i) => ({
    id: `demo-${i}`, creator: wallet(), startMc: START, gradMc: GRAD, ...t,
    game: t.game && { ...t.game, endsAt: t.game.ends ? now + t.game.ends * 1000 : null },
  }));
  const mine = loadMine().map((t) => ({ ...t, mine: true }));
  const tokens = [...mine, ...demo];

  /* ---------------- Filters ---------------- */
  const params = new URLSearchParams(location.search);
  const launched = params.get("launched");
  let tab = launched ? "new" : "trending";
  let cat = "all";
  let query = "";

  const hasPot = (t) => t.game && (t.game.type === "lbw" || t.game.type === "kob");
  const matchCat = (t) => cat === "all" || t.hooks.some((id) => hookById[id].cat === cat);
  const matchQuery = (t) => !query || `${t.name} ${t.ticker}`.toLowerCase().includes(query);

  function visible() {
    const list = tokens.filter((t) => matchCat(t) && matchQuery(t));
    switch (tab) {
      case "new": return list.sort((a, b) => ageMin(a) - ageMin(b));
      case "pots": return list.filter(hasPot).sort((a, b) => b.game.pot - a.game.pot);
      case "graduating": return list.filter((t) => t.curve === "graduating" && progress(t) >= 70).sort((a, b) => progress(b) - progress(a));
      case "graduated": return list.filter((t) => t.curve === "graduated").sort((a, b) => b.mc - a.mc);
      default: return list.filter((t) => t.curve !== "graduated").sort((a, b) => b.vol24 - a.vol24);
    }
  }

  const board = document.getElementById("board");
  const empty = document.getElementById("empty");
  const meta = document.getElementById("board-meta");

  function render() {
    const list = visible();
    board.innerHTML = list.map(tokenCard).join("");
    empty.hidden = list.length > 0;
    meta.textContent = `${list.length} token${list.length === 1 ? "" : "s"}`;
  }

  function renderStats() {
    const vol = tokens.reduce((s, t) => s + t.vol24, 0);
    const pots = tokens.filter(hasPot).reduce((s, t) => s + t.game.pot, 0);
    document.getElementById("stats").innerHTML = [
      ["Tokens", String(tokens.length)],
      ["Volume 24h", fmtUsd(vol)],
      ["In game pots now", fmtSol(pots), true],
      ["Fees paid 24h", fmtUsd((vol * FEES.total) / 100)],
    ].map(([k, v, accent]) => `<div class="stat${accent ? " is-accent" : ""}"><dt>${k}</dt><dd>${v}</dd></div>`).join("");
  }

  function selectTab(name) {
    tab = name;
    document.querySelectorAll(".tab").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.tab === name);
      b.setAttribute("aria-selected", String(b.dataset.tab === name));
    });
    render();
  }

  document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => selectTab(b.dataset.tab)));
  document.querySelectorAll("#cat-filters .chip").forEach((chip) =>
    chip.addEventListener("click", () => {
      cat = chip.dataset.cat;
      document.querySelectorAll("#cat-filters .chip").forEach((c) => {
        c.classList.toggle("is-active", c === chip);
        c.setAttribute("aria-pressed", String(c === chip));
      });
      render();
    }),
  );
  document.getElementById("search").addEventListener("input", (e) => {
    query = e.target.value.trim().toLowerCase();
    render();
  });

  renderStats();
  selectTab(tab);

  if (launched) {
    const card = board.querySelector(`[data-id="${CSS.escape(launched)}"]`);
    if (card) {
      card.classList.add("is-new");
      card.scrollIntoView({ block: "center" });
      L.toast("Your token is on the board. Demo only, in this browser.");
    }
    history.replaceState(null, "", location.pathname);
  }

  /* ---------------- Live demo: clocks, pots and prices move ---------------- */
  const cardOf = (t) => board.querySelector(`[data-id="${CSS.escape(t.id)}"]`);

  function updateCard(t, won) {
    const card = cardOf(t);
    if (!card) return;
    card.querySelector('[data-f="mc"]').textContent = fmtUsd(t.mc);
    const chg = card.querySelector('[data-f="chg"]');
    if (chg) {
      chg.textContent = `${t.change >= 0 ? "+" : "−"}${Math.abs(t.change).toFixed(1)}%`;
      chg.className = `tchg ${t.change >= 0 ? "up" : "down"}`;
    }
    const bar = card.querySelector('[data-f="bar"]');
    if (bar) {
      const p = progress(t);
      bar.style.width = `${p.toFixed(1)}%`;
      card.querySelector('[data-f="prog"]').textContent = `${Math.floor(p)}%`;
    }
    const pot = card.querySelector('[data-f="pot"]');
    if (pot) pot.textContent = fmtSol(t.game.pot);
    if (won) {
      const box = card.querySelector(".tgame");
      box.classList.remove("is-won");
      void box.offsetWidth;
      box.classList.add("is-won");
    }
  }

  // Clocks tick every second. When one runs out, the round is won and a new one starts.
  setInterval(() => {
    const t0 = Date.now();
    for (const t of tokens) {
      const g = t.game;
      if (!g || !g.endsAt) continue;
      if (g.endsAt <= t0) {
        g.endsAt = t0 + rand(120, 900) * 1000;
        g.pot = g.type === "lbw" ? rand(0.2, 1) : g.pot * 0.8; // last buyer takes it all; a king takes a slice
        updateCard(t, true);
      }
      const clock = cardOf(t)?.querySelector(".tclock");
      if (clock) clock.textContent = fmtClock((g.endsAt - t0) / 1000);
    }
  }, 1000);

  // Every few seconds some tokens trade: prices drift, pots grow, buys reset Last Buyer Wins clocks.
  setInterval(() => {
    const live = tokens.filter((t) => t.curve !== "graduated" && !t.mine);
    for (let i = 0; i < 4; i++) {
      const t = pick(live);
      const f = 1 + rand(-0.02, 0.03);
      t.mc = t.curve === "graduating" ? Math.min(t.mc * f, t.gradMc * 0.995) : t.mc * f;
      t.change += (f - 1) * 100;
      if (hasPot(t)) {
        t.game.pot += rand(0.01, 0.06);
        if (t.game.type === "lbw" && Math.random() < 0.3) t.game.endsAt = Date.now() + (t.game.timer || 600) * 1000;
      }
      updateCard(t, false);
    }
    renderStats();
  }, 2500);
})();
