(() => {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ORANGE = "#fd4b00";
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const wallet = () => {
    const s = (n) => Array.from({ length: n }, () => pick(B58)).join("");
    return `${s(4)}…${s(4)}`;
  };
  const MARK_SVG = '<svg class="tk-sep" viewBox="730 420 1024 1544" aria-hidden="true"><use href="#lure-path"/></svg>';

  /* ---------------- Hero canvas: fish drawn to the bait ---------------- */
  const canvas = document.getElementById("deep");
  const ctx = canvas.getContext("2d");
  const heroLogo = document.getElementById("hero-logo");
  let W = 0, H = 0;
  let bubbles = [], fish = [];

  // Where the little fish on the hook sits, inside the logo's viewBox (730 0 1024 1964).
  function baitPoint() {
    const c = canvas.getBoundingClientRect();
    const l = heroLogo.getBoundingClientRect();
    return { x: l.left - c.left + l.width * 0.75, y: l.top - c.top + l.height * 0.64 };
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bubbles = Array.from({ length: Math.round((W * H) / 22000) }, () => ({
      x: rand(0, W), y: rand(0, H), r: rand(1, 3.4), v: rand(0.15, 0.5), a: rand(0.12, 0.35), p: rand(0, 6),
    }));
    fish = Array.from({ length: W < 600 ? 5 : 9 }, () => newFish(true));
  }

  function newFish(anywhere) {
    const fromLeft = Math.random() < 0.5;
    return {
      x: anywhere ? rand(0, W) : (fromLeft ? -40 : W + 40),
      y: rand(H * 0.1, H * 0.85),
      vx: (fromLeft ? 1 : -1) * rand(0.3, 0.8),
      vy: rand(-0.15, 0.15),
      size: rand(7, 14),
      state: "swim",
      cooldown: 0,
    };
  }

  function drawFish(f, near) {
    const s = f.size;
    ctx.save();
    ctx.translate(f.x, f.y);
    ctx.rotate(Math.atan2(f.vy, f.vx));
    ctx.globalAlpha = 0.22 + near * 0.6;
    ctx.fillStyle = ORANGE;
    ctx.beginPath();
    ctx.ellipse(0, 0, s, s * 0.45, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-s * 0.8, 0);
    ctx.lineTo(-s * 1.7, -s * 0.62);
    ctx.lineTo(-s * 1.35, 0);
    ctx.lineTo(-s * 1.7, s * 0.62);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.arc(s * 0.5, -s * 0.08, s * 0.13, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function frame(t) {
    ctx.clearRect(0, 0, W, H);

    ctx.strokeStyle = ORANGE;
    ctx.lineWidth = 1.2;
    for (const b of bubbles) {
      b.y -= b.v;
      b.x += Math.sin(t * 0.001 + b.p) * 0.15;
      if (b.y < -6) { b.y = H + 6; b.x = rand(0, W); }
      ctx.globalAlpha = b.a;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    const bait = baitPoint();
    for (let i = 0; i < fish.length; i++) {
      const f = fish[i];
      const dx = bait.x - f.x, dy = bait.y - f.y;
      const d = Math.hypot(dx, dy) || 1;
      if (f.cooldown > 0) f.cooldown--;
      if (f.state === "swim" && d < 300 && f.cooldown === 0) f.state = "approach";
      if (f.state === "approach") {
        f.vx += (dx / d) * 0.04;
        f.vy += (dy / d) * 0.04;
        const sp = Math.hypot(f.vx, f.vy);
        if (sp > 1.4) { f.vx *= 1.4 / sp; f.vy *= 1.4 / sp; }
        if (d < 34) {
          f.state = "dart";
          const a = rand(0, Math.PI * 2);
          f.vx = Math.cos(a) * 3.2;
          f.vy = Math.sin(a) * 3.2;
          f.cooldown = 260;
        }
      } else if (f.state === "dart") {
        f.vx *= 0.985; f.vy *= 0.985;
        if (Math.hypot(f.vx, f.vy) < 0.7) f.state = "swim";
      }
      f.x += f.vx;
      f.y += f.vy;
      if (f.x < -60 || f.x > W + 60 || f.y < -60 || f.y > H + 60) fish[i] = newFish(false);
      drawFish(f, Math.max(0, 1 - d / 280));
    }
  }

  // One loop at a time; it stops while the hero is off screen.
  let visible = true, looping = false;
  function loop(t) {
    frame(t);
    if (visible) requestAnimationFrame(loop);
    else looping = false;
  }
  function start() {
    if (looping || reduceMotion) return;
    looping = true;
    requestAnimationFrame(loop);
  }

  resize();
  window.addEventListener("resize", () => { resize(); if (reduceMotion) frame(0); });
  if (reduceMotion) frame(0);
  else start();

  if ("IntersectionObserver" in window) {
    new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) start();
    }).observe(canvas);
  }

  /* ---------------- Ticker band ---------------- */
  const events = [
    () => ["▲ Buy", `${wallet()} +${rand(0.05, 0.9).toFixed(2)}%`, "clock reset"],
    () => ["★ Win", `${wallet()} claims ${rand(2, 18).toFixed(2)} SOL`, "last buyer wins"],
    () => ["✕ Refused", `${wallet()}`, "Lure Pass: hold $LURE to buy early"],
    () => ["◆ Streak", `${wallet()} held ${Math.floor(rand(3, 21))} days`, "diamond hands"],
    () => ["✕ Refused", `${wallet()} paid ${rand(0.02, 0.4).toFixed(3)} SOL tip`, "sniper-fee cap"],
    () => ["● King", `${wallet()} biggest buy of the block`, `+${rand(0.1, 1.5).toFixed(2)} SOL`],
    () => ["▼ Sell", `${wallet()} −${rand(0.05, 0.3).toFixed(2)}%`, "streak reset"],
    () => ["■ Faction", `Team ${pick(["Shark", "Squid"])} leads by ${rand(1, 9).toFixed(1)}%`, "round ends in 14m"],
  ];
  const ticker = document.getElementById("ticker");
  const items = [];
  for (let i = 0; i < 10; i++) {
    const [kind, detail, sub] = (i < events.length ? events[i] : pick(events))();
    items.push(`<span class="tk-item"><b>${kind}</b> ${detail} <span class="tk-sub">· ${sub}</span></span>${MARK_SVG}`);
  }
  ticker.innerHTML = items.join("") + items.join(""); // twice, so the loop is seamless
  ticker.style.animationDuration = `${Math.round(ticker.scrollWidth / 2 / 70)}s`;

  /* ---------------- Hook catalog ---------------- */
  const hooks = [
    { cat: "games", name: "Last Buyer Wins", orig: true, d: "Every qualifying buy resets a countdown. When it hits zero, the last buyer claims the pot." },
    { cat: "games", name: "King of the Block", orig: true, d: "The biggest buy in each round takes a slice of the pot. The hook counts the rounds, not a server." },
    { cat: "games", name: "Diamond Hands", orig: true, d: "The hook stamps when each wallet started holding. Selling resets the streak; the longest streaks earn rewards." },
    { cat: "games", name: "Factions", orig: true, d: "Two tokens, one war. The hook tallies net buys per round and the winning side's holders split the pot." },
    { cat: "access", name: "Lure Pass", orig: true, d: "Every launch opens with an early window where only wallets holding $LURE can buy." },
    { cat: "access", name: "Dev Lock", orig: true, d: "The creator's own wallet is locked by the hook: no sells during the cliff, then a daily cap." },
    { cat: "access", name: "Holder-gated", d: "Only wallets holding a token or NFT you pick can receive. Communities launch for their own." },
    { cat: "guards", name: "Sniper-fee cap", d: "Buys paying giant priority fees or Jito tips during the launch window are refused." },
    { cat: "guards", name: "Max per wallet", d: "No wallet can hold more than your cap. The pool is exempt, so trading never breaks." },
    { cat: "guards", name: "Sliding caps", d: "Per-trade caps tighten as market cap grows, so whales exit in ever smaller pieces." },
    { cat: "guards", name: "Anti-bundle", d: "Only a few trades per block. A bundler can't buy up the launch in one shot." },
    { cat: "oracle", name: "Price trigger", orig: true, d: "Sells stay locked until a Pyth price feed crosses your target, like BTC above $150k. Then it unlocks for good." },
    { cat: "oracle", name: "Market mood", orig: true, d: "Sell caps loosen while SOL pumps and tighten while it dumps, read live from Pyth on every trade." },
  ];
  const catLabel = { games: "Game", access: "Access", guards: "Guard", oracle: "Oracle" };
  const grid = document.getElementById("hook-grid");

  function renderHooks(filter) {
    grid.innerHTML = "";
    hooks
      .filter((h) => filter === "all" || h.cat === filter)
      .forEach((h, i) => {
        const el = document.createElement("article");
        el.className = "hook";
        el.style.animationDelay = `${i * 40}ms`;
        el.innerHTML = `
          <div class="hook-top">
            <span class="hook-cat cat-${h.cat}">${catLabel[h.cat]}</span>
            ${h.orig ? '<span class="hook-orig">Lure original</span>' : ""}
          </div>
          <h3>${h.name}</h3>
          <p>${h.d}</p>`;
        grid.appendChild(el);
      });
  }
  renderHooks("all");

  document.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".chip").forEach((c) => {
        c.classList.toggle("is-active", c === chip);
        c.setAttribute("aria-selected", String(c === chip));
      });
      renderHooks(chip.dataset.filter);
    });
  });

  /* ---------------- Last Buyer Wins demo ---------------- */
  const ROUND_SECONDS = 30;
  const CIRC = 2 * Math.PI * 52;
  const $ = (id) => document.getElementById(id);
  const potEl = $("g-pot"), clockEl = $("g-clock"), ringEl = $("g-ring");
  const leaderEl = $("g-leader"), roundEl = $("g-round"), logEl = $("g-log"), buyBtn = $("g-buy");

  let round = 1, pot = 3.2, deadline = 0, leader = wallet(), nextBot = 0, botsQuietAt = 0;

  function log(html, cls) {
    const li = document.createElement("li");
    if (cls) li.className = cls;
    li.innerHTML = html;
    logEl.prepend(li);
    while (logEl.children.length > 4) logEl.lastElementChild.remove();
  }

  function setLeader(name, isYou) {
    leader = name;
    leaderEl.textContent = name;
    leaderEl.classList.toggle("is-you", !!isYou);
  }

  function buy(name, amount, isYou) {
    pot += amount * 0.1;
    deadline = performance.now() + ROUND_SECONDS * 1000;
    setLeader(name, isYou);
    potEl.textContent = pot.toFixed(2);
    log(`<b>${name}</b> bought ${amount.toFixed(2)} SOL · clock reset`);
  }

  function startRound() {
    const now = performance.now();
    deadline = now + ROUND_SECONDS * 1000;
    nextBot = now + rand(2000, 7000);
    botsQuietAt = now + rand(20000, 60000);
    roundEl.textContent = round;
  }

  function tick() {
    const now = performance.now();
    const left = Math.max(0, (deadline - now) / 1000);
    clockEl.textContent = Math.ceil(left);
    ringEl.style.strokeDashoffset = String(CIRC * (1 - left / ROUND_SECONDS));
    ringEl.classList.toggle("is-low", left < 8);

    if (left <= 0) {
      log(`<b>${leader}</b> won round ${round} · ${pot.toFixed(2)} SOL`, "win");
      round += 1;
      pot = 1.0;
      potEl.textContent = pot.toFixed(2);
      setLeader("—", false);
      startRound();
      return;
    }

    if (now >= nextBot && now < botsQuietAt) {
      buy(wallet(), rand(0.1, 3), false);
      nextBot = now + rand(2500, 11000);
    }
  }

  buyBtn.addEventListener("click", () => {
    buy("You", 0.1, true);
    botsQuietAt = Math.max(botsQuietAt, performance.now() + rand(4000, 20000));
  });

  potEl.textContent = pot.toFixed(2);
  setLeader(leader, false);
  startRound();
  setInterval(tick, 250);

  /* ---------------- Rule builder examples ---------------- */
  const examples = [
`# Fair open: small bags first, then it opens up
rule fair_open {
  when age < 30m      -> max_wallet 0.5%
  when age < 2h       -> max_wallet 1%
  when mcap > $500k   -> max_sell   0.25%
  always              -> max_trades_per_block 3
}`,
`# Lure Pass window + creator lock
rule launch_day {
  when age < 5m and holds($LURE) < 50000 -> refuse buy
  when age < 5m                           -> max_buy 0.2%
  creator -> lock 7d then sell 1% per day
}`,
`# Event token: sells unlock when BTC hits $150k
rule btc_150k {
  feed btc = pyth("BTC/USD")
  when btc.price < 150000  -> refuse sell
  when btc.price >= 150000 -> unlock forever
  game last_buyer_wins { timer 10m, min_buy 0.05%, pot 10% }
}`,
  ];

  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const TOKEN = /(#[^\n]*)|("[^"]*")|\b(rule|when|always|and|or|then|feed|game|refuse|unlock|lock|creator|forever|per)\b|(\$[A-Z]+)|(?<![\w$])(\$?\d[\d,.]*(?:%|m|h|d|k)?)|\b([a-z_]+)(?=\()|(->|>=|<|>)/g;

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

  const codeEl = document.getElementById("code-ex");
  const showExample = (i) => { codeEl.innerHTML = highlight(examples[i]); };
  showExample(0);

  document.querySelectorAll(".code-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".code-tab").forEach((t) => {
        t.classList.toggle("is-active", t === tab);
        t.setAttribute("aria-selected", String(t === tab));
      });
      showExample(Number(tab.dataset.ex));
    });
  });
})();
