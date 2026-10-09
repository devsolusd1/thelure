/* The landing: the logo hung from the top of the window as a rig, and five screens it answers to. */
(() => {
  const { HOOKS, CATEGORIES, defaults, highlight, esc } = window.LURE;
  const root = document.documentElement;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const SVG_NS = "http://www.w3.org/2000/svg";
  const svg = (tag, attrs = {}) => {
    const el = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  };
  const EXPLORER = "https://explorer.solana.com";
  const txLink = (sig) => `<a href="${EXPLORER}/tx/${sig}?cluster=devnet" target="_blank" rel="noopener">tx</a>`;
  root.classList.add("js");

  /* ---------------- The rig ---------------- */
  // Logo units (see the sprite). The line meets the knot at PIVOT, the barb ends at POINT, the
  // bait is tied on at TIE. From the knot to the bottom of the hook is TACKLE units.
  const PIVOT = [1292, 455], POINT = [916, 1276], TIE = [1345, 942], HOOK_LEFT = 742, FISH_RIGHT = 1742, TACKLE = 1500;
  // Where the knot hangs on each screen, as a share of the window's height: [wide, phone].
  const POSE = { top: [0.43, 0.78], hook: [0.43, 0.78], box: [0.38, 0.78], agent: [0.25, 0.6], proof: [0.44, 0.8] };

  const lineEl = $("rig-line"), tackleEl = $("rig-tackle"), baitEl = $("rig-bait"), extras = $("rig-extras");
  let W = 0, H = 0, phone = false, lineX = 0, scale = 1, freeTop = 0, colLeft = 24;
  let depth = "top", agentStep = 0;
  const knot = { x: 0, y: 0, rot: 0 };

  // Damped springs: x chases `to`.
  const spring = (k, c) => ({ x: 0, v: 0, to: 0, k, c });
  const drop = spring(90, 11); // how low the knot hangs, px
  const swing = spring(26, 3); // the line below the last weight, radians from straight down
  const bow = spring(420, 9); // how far the line is pulled sideways, px
  const wag = spring(160, 7); // the bait about its tie, degrees
  let bowAt = 0.5; // where along the free line the pull sits, 0 to 1
  const advance = (s, dt) => {
    s.v += ((s.to - s.x) * s.k - s.v * s.c) * dt;
    s.x += s.v * dt;
  };

  function measure() {
    W = root.clientWidth;
    H = window.innerHeight;
    phone = W < 720;
    scale = (phone ? Math.max(124, H * 0.16) : Math.min(H * 0.5, W * 0.46)) / TACKLE;
    // On a phone the rig keeps to the right edge, and the words never run under it.
    lineX = phone ? Math.round(W - (FISH_RIGHT - PIVOT[0]) * scale - 9) : Math.round(W * 0.7);
    const d0 = phone ? 84 : 88, gap = 26;
    freeTop = d0 + gap * 4 + 16; // the line runs straight down to the last weight
    colLeft = phone ? 16 : Math.max(24, (W - 1160) / 2 + 24);
    const col = Math.min(620, lineX - (PIVOT[0] - HOOK_LEFT) * scale - (phone ? 10 : 48) - colLeft);
    const set = (name, px) => root.style.setProperty(name, `${Math.round(px)}px`);
    set("--line-x", lineX); set("--col", col); set("--col-left", colLeft); set("--d0", d0); set("--dgap", gap);
    lineEl.setAttribute("stroke-width", Math.max(3, 32 * scale).toFixed(1));
  }

  function pose(snap) {
    let share = POSE[depth][phone ? 1 : 0];
    if (depth === "agent") share += agentStep * (phone ? 0.03 : 0.045);
    drop.to = H * share;
    if (snap || reduce) { drop.x = drop.to; drop.v = 0; }
  }

  // A point of the logo, in window pixels, wherever the tackle has swung to.
  function at(u) {
    const dx = (u[0] - PIVOT[0]) * scale, dy = (u[1] - PIVOT[1]) * scale;
    const c = Math.cos(knot.rot), s = Math.sin(knot.rot);
    return [knot.x + dx * c - dy * s, knot.y + dx * s + dy * c];
  }

  const followers = new Set(); // things that ride the rig, redrawn every frame
  const tweens = new Set();
  function tween(ms, onStep, onEnd) {
    if (reduce) { onStep(1); if (onEnd) onEnd(); return; }
    tweens.add({ t0: performance.now(), ms, onStep, onEnd });
  }

  function draw(t) {
    const sway = reduce ? 0 : Math.sin(t / 1900) * 0.02; // it is never quite still
    const a = swing.x + sway;
    const len = Math.max(6, drop.x - freeTop);
    knot.x = lineX + Math.sin(a) * len;
    knot.y = freeTop + Math.cos(a) * len;
    knot.rot = -a * 1.3;
    const cx = (lineX + knot.x) / 2 + bow.x * 2, cy = freeTop + len * bowAt;
    lineEl.setAttribute("d", `M${lineX} -20V${freeTop}Q${cx.toFixed(1)} ${cy.toFixed(1)} ${knot.x.toFixed(1)} ${knot.y.toFixed(1)}`);
    tackleEl.setAttribute(
      "transform",
      `translate(${knot.x.toFixed(1)} ${knot.y.toFixed(1)}) rotate(${((knot.rot * 180) / Math.PI).toFixed(2)}) scale(${scale.toFixed(4)}) translate(${-PIVOT[0]} ${-PIVOT[1]})`,
    );
    const idle = reduce ? 0 : Math.sin(t / 760) * 0.9;
    baitEl.setAttribute("transform", `rotate(${(wag.x + idle).toFixed(2)} ${TIE[0]} ${TIE[1]})`);
    for (const f of followers) f(t);
  }

  let last = 0;
  function frame(t) {
    // Small fixed steps, so the springs stay stable when the browser hands out frames slowly.
    let left = clamp((t - last) / 1000 || 0.016, 0, 0.3);
    last = t;
    for (; left > 0; left -= 1 / 120) {
      const dt = Math.min(left, 1 / 120);
      advance(drop, dt); advance(swing, dt); advance(bow, dt); advance(wag, dt);
    }
    for (const tw of tweens) {
      const p = clamp((t - tw.t0) / tw.ms, 0, 1);
      tw.onStep(p);
      if (p === 1) { tweens.delete(tw); if (tw.onEnd) tw.onEnd(); }
    }
    draw(t);
    requestAnimationFrame(frame);
  }

  /* ---------------- What moves the line: the pointer, a touch, the scroll ---------------- */
  let px = -999;
  window.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch" || reduce) return;
    const vx = e.clientX - px;
    px = e.clientX;
    const dx = e.clientX - lineX, y = e.clientY;
    if (y > freeTop && y < knot.y && Math.abs(dx) < 64) {
      // The line gives way to the pointer; cross it and it snaps to the other side.
      bow.to = -Math.sign(dx || 1) * (64 - Math.abs(dx)) * 0.5;
      bowAt = clamp((y - freeTop) / (knot.y - freeTop), 0.2, 0.8);
    } else {
      bow.to = 0;
    }
    // A fast pass by the tackle sets it swinging.
    const [hx, hy] = at([1240, 1300]);
    if (Math.abs(e.clientX - hx) < 620 * scale && Math.abs(y - hy) < 720 * scale) swing.v += clamp(vx, -40, 40) * 0.0012;
  });
  document.addEventListener("pointerleave", () => { bow.to = 0; });
  window.addEventListener("pointerdown", (e) => {
    if (reduce || Math.abs(e.clientX - lineX) > 36 || e.clientY < freeTop || e.clientY > knot.y) return;
    bowAt = clamp((e.clientY - freeTop) / (knot.y - freeTop), 0.2, 0.8);
    bow.v += (e.clientX < lineX ? 1 : -1) * 620; // plucked
  });

  const screens = [...document.querySelectorAll(".screen")];
  const weights = [...document.querySelectorAll("#depths a")];
  const ptags = document.querySelector(".ptags");

  function markWeights() {
    const i = weights.findIndex((w) => w.dataset.depth === depth);
    weights.forEach((w, n) => {
      w.classList.toggle("is-past", n < i);
      if (n === i) w.setAttribute("aria-current", "true");
      else w.removeAttribute("aria-current");
    });
  }

  function setDepth(next) {
    depth = next;
    markWeights();
    clearExtras();
    pose();
    if (reduce) return;
    bow.v += 520; // every change of screen is felt on the line
    ptags.classList.remove("is-flap");
    void ptags.offsetWidth;
    ptags.classList.add("is-flap");
  }

  let lastScroll = window.scrollY;
  function onScroll() {
    const dy = window.scrollY - lastScroll;
    lastScroll = window.scrollY;
    if (!reduce) {
      bow.v += clamp(dy, -60, 60) * 2.2;
      swing.v += clamp(dy, -60, 60) * 0.0009;
    }
    let cur = screens[0];
    for (const s of screens) if (s.getBoundingClientRect().top < H * 0.5) cur = s;
    if (cur.dataset.depth !== depth) setDepth(cur.dataset.depth);
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", () => { measure(); pose(true); });

  /* ---------------- The mark a refusal leaves ---------------- */
  const stamp = $("stamp");
  let stampTimer = 0, flashed = false;
  function refuse(text, x, y) {
    stamp.textContent = text;
    stamp.style.left = `${clamp(x, 110, W - 110)}px`;
    stamp.style.top = `${clamp(y, 110, H - 70)}px`;
    stamp.className = "stamp";
    void stamp.offsetWidth;
    stamp.classList.add("is-on");
    clearTimeout(stampTimer);
    stampTimer = setTimeout(() => stamp.classList.replace("is-on", "is-off"), 1700);
    if (flashed || reduce) return;
    flashed = true; // once: for a moment the page is the logo inverted
    root.classList.add("is-refused");
    setTimeout(() => root.classList.remove("is-refused"), 380);
  }

  let hooked = null;
  function clearExtras() {
    followers.clear();
    tweens.clear();
    extras.replaceChildren();
    hooked = null;
    stamp.className = "stamp";
  }

  /* ---------------- Screen 2: trades are fish meeting the hook ---------------- */
  // A paper fish, nose at the origin, facing right.
  const FISH = "M0 0C-10-20-45-26-66-6L-100-26-90 0-100 26-66 6C-45 26-10 20 0 0ZM-26.5-7a4.5 4.5 0 1 0 9 0a4.5 4.5 0 1 0-9 0Z";
  const place = (el, x, y, deg, k) => el.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${deg.toFixed(1)}) scale(${k.toFixed(3)})`);
  const bez = (a, c, b, p) => [(1 - p) ** 2 * a[0] + 2 * (1 - p) * p * c[0] + p * p * b[0], (1 - p) ** 2 * a[1] + 2 * (1 - p) * p * c[1] + p * p * b[1]];
  const ease = (p) => (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2);

  function newFish(size) {
    const el = svg("path", { d: FISH, class: "paper", "fill-rule": "evenodd" });
    extras.appendChild(el);
    return { el, k: size * clamp((TACKLE * scale) / 420, 0.55, 1.3) };
  }

  // Swims in from the bottom left to the point of the hook, then `arrive` decides what happens.
  function swimIn(size, ms, arrive) {
    const fish = newFish(size);
    const from = [phone ? -110 : colLeft + 40, H + 70];
    let prev = from;
    tween(ms, (p) => {
      const to = at(POINT);
      const [x, y] = bez(from, [from[0] * 0.35 + to[0] * 0.65, to[1] + 26], to, ease(p));
      const heading = (Math.atan2(y - prev[1], x - prev[0]) * 180) / Math.PI;
      place(fish.el, x, y, (p < 1 ? heading : 0) + Math.sin(p * 20) * 7, fish.k);
      prev = [x, y];
    }, () => arrive(fish));
  }

  // Leaves the way it came, facing left.
  function swimOut(fish, ms) {
    const from = at(POINT), to = [phone ? -140 : colLeft - 60, H + 90];
    tween(ms, (p) => {
      const [x, y] = bez(from, [from[0] - 120, to[1] - 60], to, ease(p));
      fish.el.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${(-32 * p + Math.sin(p * 20) * 7).toFixed(1)}) scale(${-fish.k} ${fish.k})`);
    }, () => fish.el.remove());
  }

  function hang(fish) {
    hooked = fish;
    fish.follow = (t) => {
      const [x, y] = at(POINT);
      place(fish.el, x, y, -90 + (knot.rot * 180) / Math.PI + Math.sin(t / 420) * 4, fish.k);
    };
    followers.add(fish.follow);
  }
  function unhang() {
    const fish = hooked;
    hooked = null;
    if (fish) followers.delete(fish.follow);
    return fish;
  }

  const BUY = "2gyG9dK1napzTPVDZhHp9DqwEeBLzxHu8wRsh5zrvbwyuxgaTEWkS3rk9wKheKnwtyoiMkKxRNUWs7NdaTiXxiEw";
  const SELL = "5fcuWnn3Te2fuUb2Mx3tQBhqfdFNUydeyWu5CCukvQJzZZvGT9awsWXLLSK3GSMuYcZUhvJwaUnHf9nTvjj4f8Cu";
  const hookOut = $("hook-out");
  const PLAYS = {
    under(pill) {
      const old = unhang();
      if (old) swimOut(old, 700);
      swimIn(0.5, 1150, (fish) => {
        hang(fish);
        drop.v += 260; swing.v -= 0.5; wag.v += 60;
        pill.classList.add("is-ok");
        hookOut.innerHTML = `<span class="ok">Landed.</span> A buy of <b>0.003 SOL</b> took <b>0.296%</b> of the supply, under the cap. ${txLink(BUY)}`;
      });
    },
    over(pill) {
      swimIn(1.15, 950, (fish) => {
        const [x, y] = at(POINT);
        swing.v += 0.95; wag.v -= 80;
        tween(650, (p) => {
          place(fish.el, x - 230 * ease(p), y + 40 * p - 90 * Math.sin(p * Math.PI), -160 * p, fish.k);
          fish.el.style.opacity = String(1 - p * p);
        }, () => fish.el.remove());
        refuse("0x1770", x - 30, y - 100);
        pill.classList.add("is-no");
        hookOut.innerHTML = `<span class="no">Refused by the hook, inside the swap.</span> A buy of <b>0.02 SOL</b> would have passed 1%. Error <b>0x1770</b>. Nothing moved.`;
      });
    },
    sell(pill) {
      const fish = unhang() || newFish(0.5);
      swimOut(fish, 1000);
      drop.v -= 160; swing.v += 0.3;
      pill.classList.add("is-ok");
      hookOut.innerHTML = `<span class="ok">Landed.</span> Half the bag went back to the curve. The hook never blocks a sell. ${txLink(SELL)}`;
    },
  };
  document.querySelectorAll("[data-play]").forEach((pill) => {
    pill.addEventListener("click", () => {
      if (depth !== "hook") setDepth("hook");
      PLAYS[pill.dataset.play](pill);
    });
  });

  /* ---------------- Screen 3: the tackle box ---------------- */
  const STATUS = { maxw: "Proven on devnet" };
  const KINDS = { games: "Games", access: "Access", guards: "Guards", oracle: "Oracles" };
  const boxList = $("box-list"), boxCard = $("box-card");
  boxList.innerHTML = Object.entries(CATEGORIES)
    .map(([cat]) => `
      <div class="box-row">
        <span class="box-k">${KINDS[cat]}</span>
        <div class="pills">${HOOKS.filter((h) => h.cat === cat)
          .map((h) => `<button type="button" class="pill pill-s${STATUS[h.id] ? " is-live" : ""}" data-hook="${h.id}" aria-pressed="false">${esc(h.name)}</button>`)
          .join("")}</div>
      </div>`)
    .join("");

  // The hook you pick is tied on as a paper tag.
  function tieTag(text) {
    clearExtras();
    const g = svg("g");
    const label = svg("text", { class: "rig-tagtext", "text-anchor": "middle", y: 51 });
    label.textContent = text;
    g.append(svg("path", { class: "rig-tagline", d: "M0 0V30" }), svg("path", { class: "paper" }), label);
    extras.appendChild(g);
    const w = label.getComputedTextLength() / 2 + 16;
    g.children[1].setAttribute("d", `M${-w + 9} 30H${w - 9}L${w} 39V62H${-w}V39Z`);
    followers.add((t) => {
      const [x, y] = at(POINT);
      const lean = clamp(((knot.rot * 180) / Math.PI) * 2.2 + Math.sin(t / 900) * 2, -24, 24);
      g.setAttribute("transform", `translate(${clamp(x, w + 6, W - w - 6).toFixed(1)} ${y.toFixed(1)}) rotate(${lean.toFixed(1)})`);
    });
    drop.v += 150; wag.v += 45;
  }

  boxList.addEventListener("click", (e) => {
    const pill = e.target.closest("[data-hook]");
    if (!pill) return;
    const h = HOOKS.find((x) => x.id === pill.dataset.hook);
    boxList.querySelectorAll("[data-hook]").forEach((p) => p.setAttribute("aria-pressed", String(p === pill)));
    boxCard.hidden = false;
    boxCard.innerHTML = `
      <div class="card-top">
        <h3>${esc(h.name)}</h3>
        <span class="tag${STATUS[h.id] ? "" : " tag-muted"}">${STATUS[h.id] || "In development"}</span>
      </div>
      <p>${esc(h.desc)}</p>
      <pre><code>${highlight(h.dsl(defaults(h), { potShare: 50 }))}</code></pre>`;
    if (depth !== "box") setDepth("box");
    if (phone) { drop.v += 150; wag.v += 45; } // no room for the tag: the rig just dips
    else tieTag(h.name);
  });

  const CURVES = {
    grad: "<b>Graduates.</b> At the market cap you set, the token moves to a Meteora pool and its hooks switch off.",
    inf: "<b>Infinite bonding.</b> The curve never ends, so the hooks and games run for the life of the token.",
  };
  document.querySelectorAll("[data-curve]").forEach((pill) => {
    pill.addEventListener("click", () => {
      document.querySelectorAll("[data-curve]").forEach((p) => p.setAttribute("aria-pressed", String(p === pill)));
      $("curve-out").innerHTML = CURVES[pill.dataset.curve];
    });
  });

  /* ---------------- Screen 4: an agent on a leash ---------------- */
  // Recorded from programs/examples/devnet-smoke.mjs. Refused tries never became transactions.
  const RUN = [
    [true, "Creator creates the leash", "3a8T7eGnqT8VmcygNGsFqEargzREi4nmP7EhZvwrX47vSq2cKC4t7gp3Dcawm7tMnFg1xTRcZy4VTBVaMXFFFk8P"],
    [true, "Agent sends 0.002 SOL to the pot", "2msaNAWNbDapEfCmUh3axonrMynciqdhv7Y8ndWJicg84oiD6W2hVUffpQu2E4qEYdrYerwCZUZNtGnR7SvpAeEe"],
    [false, "Agent sends 0.003 SOL at once", "over the cap per action"],
    [false, "Agent sends SOL to its own wallet", "not an allowed destination"],
    [false, "A stranger tries to spend", "not the agent"],
    [true, "Agent sends 0.002 SOL to the buyback", "5Xk5bYwnYhgeLcMuRAqZxTyg2ouvY17ghMsLokJwrqYgWHzGB9uxM1p67ettXV9tFHjEHDw3bHKRqCYP25NcRJ5f"],
    [false, "Agent sends 0.001 SOL more", "over the daily cap"],
    [true, "Agent rewards a holder with 0.001 SOL", "3VxM6qg9PJ9URhuw8DdpUFQEPAD9PrKry4SfRcF8avPB4JxuDRN5WLX46JUNTMDHZMoCEE4ZG3wqEoCLRfpfx8Ag"],
    [true, "Agent moves a rule from 600 to 900", "5275TTm88wNqP6MXKbBY5GAAibvYZA3TZmbXNQcCBwSWx2mRtLP1Kzi8eYdy35vCrW8s2uDzG4rduCDpZvuE5BsP"],
    [false, "Agent jumps it to 1500", "more than one step"],
    [true, "Creator revokes the agent", "5X6e1G93nw3b33D38bmyq8guQWYVvP2CV1eJe1g61E1t7quaSo6P13vmzj7gYE7iNg6bAPedFKA33PVmy5RzuWz"],
    [false, "Revoked agent tries to spend", "no longer the agent"],
    [true, "Anyone sweeps what's left to the pot", "2ofvRFC2XdEFJhrfpNRsDQJL1XFbT6CbPxMR4zDwUJsX4MLWebWE5QEFXr8rzE1WpyUhkmfD3jpLQYJ2cLuPTS6z"],
  ];
  // The six worth pressing: a label for the pill, which line of the run it replays, and why.
  const TRIES = [
    ["Send 0.002 SOL to the pot", 1, "Inside the cap per action."],
    ["Send 0.003 SOL at once", 2, "Over the cap per action."],
    ["Pay its own wallet", 3, "Not a destination picked at launch."],
    ["Move a rule from 600 to 900", 8, "One step, inside its range."],
    ["Jump it to 1500", 9, "More than one step at a time."],
    ["Revoke the agent", 10, "The creator can switch the agent off, and never loosen the leash."],
  ];
  const agentPills = $("agent-pills"), agentOut = $("agent-out");
  agentPills.innerHTML = TRIES.map(([label], i) => `<button type="button" class="pill pill-s" data-try="${i}">${label}</button>`).join("");
  agentPills.addEventListener("click", (e) => {
    const pill = e.target.closest("[data-try]");
    if (!pill) return;
    const [, line, note] = TRIES[pill.dataset.try];
    const [ok, , detail] = RUN[line];
    if (depth !== "agent") setDepth("agent");
    pill.classList.add(ok ? "is-ok" : "is-no");
    if (line === 10) {
      agentStep = 0; // revoked: reeled all the way back in
      wag.v -= 60;
      agentOut.innerHTML = `<span class="ok">Revoked.</span> ${note} ${txLink(detail)}`;
    } else if (ok) {
      agentStep = Math.min(agentStep + 1, 3); // allowed: a little more line
      wag.v += 50;
      agentOut.innerHTML = `<span class="ok">Allowed.</span> ${note} ${txLink(detail)}`;
    } else {
      drop.v -= 560; bow.v += 380; wag.v -= 110; // the line snaps taut and jerks the bait back
      const [x] = at(POINT);
      refuse("REFUSED", x - (phone ? 20 : 90), knot.y + (phone ? -70 : 60));
      agentOut.innerHTML = `<span class="no">Refused by the leash.</span> ${note}`;
    }
    pose();
  });

  $("runlog").innerHTML = RUN.map(([ok, text, detail]) => `
    <li class="${ok ? "is-ok" : "is-no"}">
      <span class="run-mark" aria-hidden="true">${ok ? "✓" : "✕"}</span>
      <span class="run-text"><span class="sr-only">${ok ? "Allowed: " : "Refused: "}</span>${text}</span>
      ${ok
        ? `<a class="run-detail" href="${EXPLORER}/tx/${detail}?cluster=devnet" target="_blank" rel="noopener">tx</a>`
        : `<span class="run-detail">${detail}</span>`}
    </li>`).join("");
  const dialog = $("run-dialog");
  $("run-open").addEventListener("click", () => (dialog.showModal ? dialog.showModal() : dialog.setAttribute("open", "")));
  dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });

  /* ---------------- Go ---------------- */
  measure();
  markWeights();
  pose(true);
  if (!reduce) drop.x = -TACKLE * scale * 0.3; // the rig drops in from above the window
  onScroll();
  requestAnimationFrame(frame);
})();
