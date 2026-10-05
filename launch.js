(() => {
  const L = window.LURE;
  const { CATEGORIES, EXCLUSIVE, HOOKS, hookById, defaults, tokenCard, highlight, fmtUsd, fmtNum, fmtSol, isAddress, shortAddr, esc, toast, loadMine, saveMine } = L;
  const $ = (sel, root = document) => root.querySelector(sel);
  const NETWORK_COST = 0.05; // SOL, estimate: mint, metadata, pool, hook accounts and fees

  const state = {
    name: "", ticker: "", desc: "", x: "", web: "", image: null,
    hooks: {}, // hook id -> settings
    curve: "graduating", startMc: 5000, gradMc: 75000,
    potShare: 50, devBuy: 0,
  };
  const selected = () => HOOKS.filter((h) => state.hooks[h.id]);
  const num = (v) => (v === "" || v == null ? NaN : Number(v));
  const val = (x, fallback) => (Number.isFinite(x) ? x : fallback);
  const show = (n) => (n >= 1000 ? fmtNum(n) : String(n));

  /* ---------------- Errors ---------------- */
  function setError(el, msg) {
    const field = el.closest(".field");
    field.classList.add("is-invalid");
    const out = field.querySelector(".field-error");
    if (out) {
      out.textContent = msg;
      out.hidden = false;
    }
  }
  function clearError(el) {
    const field = el.closest(".field");
    if (!field) return;
    field.classList.remove("is-invalid");
    const out = field.querySelector(".field-error");
    if (out) out.hidden = true;
  }

  /* ---------------- Step 1: token ---------------- */
  function bindText(id, key, transform) {
    const el = $(id);
    el.addEventListener("input", () => {
      if (transform) {
        const v = transform(el.value);
        if (v !== el.value) el.value = v;
      }
      state[key] = el.value;
      clearError(el);
      refresh();
    });
  }
  bindText("#f-name", "name");
  bindText("#f-ticker", "ticker", (v) => v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10));
  bindText("#f-desc", "desc");
  bindText("#f-x", "x");
  bindText("#f-web", "web");
  $("#f-desc").addEventListener("input", (e) => { $("#desc-count").textContent = e.target.value.length; });

  const dropzone = $("#dropzone"), fileInput = $("#f-image"), dzImg = $("#dz-img");
  dropzone.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => fileInput.files[0] && useImage(fileInput.files[0]));
  dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("is-over"); });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("is-over"));
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("is-over");
    if (e.dataTransfer.files[0]) useImage(e.dataTransfer.files[0]);
  });

  // Square-crop to 256px so the preview (and the demo board) stays light.
  async function useImage(file) {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return setError(dropzone, "Use a PNG, JPG, GIF or WebP.");
    if (file.size > 5 * 1024 * 1024) return setError(dropzone, "That image is over 5 MB.");
    try {
      const bmp = await createImageBitmap(file);
      const size = 256, side = Math.min(bmp.width, bmp.height);
      const c = document.createElement("canvas");
      c.width = c.height = size;
      c.getContext("2d").drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, size, size);
      let url = c.toDataURL("image/webp", 0.85);
      if (!url.startsWith("data:image/webp")) url = c.toDataURL("image/jpeg", 0.85);
      state.image = url;
      dzImg.src = url;
      dzImg.hidden = false;
      dropzone.classList.add("has-img");
      clearError(dropzone);
      refresh();
    } catch {
      setError(dropzone, "Couldn't read that image.");
    }
  }

  /* ---------------- Step 2: hooks ---------------- */
  const GROUPS = {
    games: ["Games", "Pick one. The pot comes out of your fee."],
    access: ["Access", "Who can buy, and when."],
    guards: ["Guards", "Caps against snipers, bundles and dumps."],
    oracle: ["Oracle", "Pick one. Driven by live Pyth prices."],
  };
  const picker = $("#hook-picker");
  picker.innerHTML = Object.keys(CATEGORIES).map((cat) => `
    <div class="hgroup">
      <div class="hgroup-head"><span class="hchip cat-${cat}">${GROUPS[cat][0]}</span><span class="hgroup-note">${GROUPS[cat][1]}</span></div>
      <div class="hgroup-grid">${HOOKS.filter((h) => h.cat === cat).map(pickCard).join("")}</div>
    </div>`).join("");

  function pickCard(h) {
    return `<div class="hpick" data-hook="${h.id}">
      <label class="hpick-label">
        <input type="checkbox" class="hpick-input" value="${h.id}">
        <span class="hpick-check" aria-hidden="true"></span>
        <span class="hpick-text">
          <span class="hpick-name">${h.name}${h.orig ? '<span class="hook-orig">Lure original</span>' : ""}</span>
          <span class="hpick-desc">${h.desc}</span>
        </span>
      </label>
      <div class="hset" hidden>${h.settings.map((f) => settingField(h, f)).join("")}</div>
    </div>`;
  }

  function settingField(h, f) {
    const data = `data-hook="${h.id}" data-key="${f.key}"`;
    if (f.type === "select") {
      const opts = f.options.map(([v, t]) => `<option value="${v}"${v === f.def ? " selected" : ""}>${t}</option>`).join("");
      return `<label class="field"><span class="field-label">${f.label}</span><select ${data}>${opts}</select></label>`;
    }
    if (f.type === "address") {
      return `<label class="field field-wide"><span class="field-label">${f.label}</span><input type="text" ${data} placeholder="Mint address" spellcheck="false" autocomplete="off"><span class="field-error" hidden></span></label>`;
    }
    return `<label class="field"><span class="field-label">${f.label}</span><span class="input-unit"><input type="number" ${data} min="${f.min}" max="${f.max}" step="${f.step}" value="${f.def}"><span class="unit">${f.unit}</span></span><span class="field-error" hidden></span></label>`;
  }

  const pickEl = (id) => picker.querySelector(`.hpick[data-hook="${id}"]`);

  function setHook(id, on) {
    const card = pickEl(id), h = hookById[id];
    card.classList.toggle("is-on", on);
    card.querySelector(".hpick-input").checked = on;
    card.querySelector(".hset").hidden = !on;
    if (on) {
      state.hooks[id] = defaults(h);
      card.querySelectorAll("[data-key]").forEach((el) => {
        el.value = h.settings.find((f) => f.key === el.dataset.key).def;
        clearError(el);
      });
    } else {
      delete state.hooks[id];
    }
  }

  function toggleHook(id, on) {
    const h = hookById[id];
    if (on && EXCLUSIVE.has(h.cat)) {
      for (const other of selected()) {
        if (other.cat !== h.cat) continue;
        setHook(other.id, false);
        toast(`One ${h.cat === "games" ? "game" : "oracle hook"} per token: swapped ${other.name} for ${h.name}.`);
      }
    }
    setHook(id, on);
    refresh();
  }

  function setSetting(el) {
    const h = hookById[el.dataset.hook];
    const f = h.settings.find((x) => x.key === el.dataset.key);
    if (!state.hooks[h.id]) return;
    state.hooks[h.id][f.key] = f.type ? el.value.trim() : num(el.value);
    clearError(el);
    refresh();
  }

  picker.addEventListener("change", (e) => {
    if (e.target.classList.contains("hpick-input")) toggleHook(e.target.value, e.target.checked);
    else if (e.target.dataset.key) setSetting(e.target);
  });
  picker.addEventListener("input", (e) => {
    if (e.target.tagName === "INPUT" && e.target.dataset.key) setSetting(e.target);
  });

  /* ---------------- Steps 3 to 5 ---------------- */
  const CURVE_NOTES = {
    graduating: "At graduation Meteora moves the token to a regular pool and removes the hook, so every rule and game stops there.",
    permanent: "The token trades on its bonding curve for good, so rules and games never stop.",
  };
  document.querySelectorAll('input[name="curve"]').forEach((r) =>
    r.addEventListener("change", () => {
      state.curve = r.value;
      $("#grad-field").hidden = r.value === "permanent";
      refresh();
    }),
  );

  function bindNumber(id, key) {
    const el = $(id);
    el.addEventListener("input", () => {
      state[key] = num(el.value);
      clearError(el);
      refresh();
    });
  }
  bindNumber("#f-start", "startMc");
  bindNumber("#f-grad", "gradMc");
  bindNumber("#f-dev", "devBuy");
  $("#f-pot").addEventListener("input", (e) => {
    state.potShare = Number(e.target.value);
    refresh();
  });

  /* ---------------- Live preview ---------------- */
  function gameState(h, live) {
    const s = state.hooks[h.id];
    const now = Date.now();
    if (h.id === "lbw") return { type: "lbw", pot: 0, timer: s.timer * 60, endsAt: live ? now + s.timer * 60000 : null };
    if (h.id === "kob") return { type: "kob", pot: 0, endsAt: live ? now + s.round * 60000 : null };
    if (h.id === "dh") return { type: "dh", streak: 0, period: s.period };
    return { type: "fac", share: 50, rival: shortAddr(s.rival) || "rival" };
  }

  function buildRule(sel, gradMc) {
    const tick = state.ticker || "TICKER";
    const lines = [`# $${tick}: checked on every transfer`, `rule ${tick.toLowerCase()} {`];
    if (!sel.length) lines.push("  # no hooks yet: pick some in step 2");
    for (const h of sel) {
      const s = Object.fromEntries(Object.entries(state.hooks[h.id]).map(([k, v]) => [k, v === "" || Number.isNaN(v) ? "?" : v]));
      for (const line of h.dsl(s, state).split("\n")) lines.push(`  ${line}`);
    }
    lines.push(state.curve === "permanent" ? "  # permanent curve: these rules never switch off" : `  # graduates at ${fmtUsd(gradMc)}: rules switch off there`);
    lines.push("}");
    return lines.join("\n");
  }

  function refresh() {
    const sel = selected();
    const game = sel.find((h) => h.cat === "games");
    const startMc = val(state.startMc, 5000), gradMc = val(state.gradMc, 75000);

    $("#pot-row").hidden = !game;
    $("#pot-label").textContent = `${state.potShare}% of your fee`;
    $("#curve-note").textContent = CURVE_NOTES[state.curve];

    $("#preview").innerHTML = tokenCard({
      id: "preview", name: state.name.trim() || "Your token", ticker: state.ticker || "TICKER",
      desc: state.desc.trim(), image: state.image, mine: true, createdAt: Date.now(),
      mc: startMc, vol24: 0, change: 0, holders: 1,
      curve: state.curve, startMc, gradMc, hooks: sel.map((h) => h.id),
      game: game ? gameState(game, false) : null,
    });
    $("#rule-code").innerHTML = highlight(buildRule(sel, gradMc));

    const dev = Math.max(0, val(state.devBuy, 0));
    $("#cost-dev").textContent = fmtSol(dev);
    $("#cost-total").textContent = `≈ ${fmtSol(NETWORK_COST + dev)}`;
  }

  /* ---------------- Launch (preview only) ---------------- */
  function validate() {
    const bad = [];
    const check = (ok, el, msg) => {
      if (ok) return;
      setError(el, msg);
      bad.push(el);
    };
    check(state.name.trim().length > 0, $("#f-name"), "Give your token a name.");
    check(/^[A-Z0-9]{2,10}$/.test(state.ticker), $("#f-ticker"), "2 to 10 letters or numbers.");
    check(Boolean(state.image), dropzone, "Add an image.");
    for (const h of selected()) {
      for (const f of h.settings) {
        if (f.type === "select") continue;
        const el = pickEl(h.id).querySelector(`[data-key="${f.key}"]`);
        const v = state.hooks[h.id][f.key];
        if (f.type === "address") check(isAddress(v), el, "Paste a valid Solana mint address.");
        else check(Number.isFinite(v) && v >= f.min && v <= f.max, el, `Between ${show(f.min)} and ${show(f.max)}.`);
      }
    }
    const start = state.startMc, grad = state.gradMc;
    check(Number.isFinite(start) && start >= 1000 && start <= 100000, $("#f-start"), "Between $1,000 and $100,000.");
    if (state.curve === "graduating") {
      check(Number.isFinite(grad) && grad >= start * 2 && grad <= 1e8, $("#f-grad"), "At least 2× the starting market cap.");
    }
    check(Number.isFinite(state.devBuy) && state.devBuy >= 0 && state.devBuy <= 10, $("#f-dev"), "Between 0 and 10 SOL.");
    return bad;
  }

  const modal = $("#modal");
  let lastFocus = null;

  function openModal() {
    const sel = selected();
    const tick = esc(state.ticker);
    const steps = [
      `Upload the image and metadata for <b>$${tick}</b>`,
      `Create the <b>$${tick}</b> mint (Token-2022) pointed at the Lure hook`,
      state.curve === "permanent"
        ? `Open a <b>permanent</b> Meteora bonding curve starting at <b>${fmtUsd(state.startMc)}</b>`
        : `Open a Meteora bonding curve from <b>${fmtUsd(state.startMc)}</b>, graduating at <b>${fmtUsd(state.gradMc)}</b>`,
      sel.length
        ? `Write ${sel.length} rule${sel.length > 1 ? "s" : ""} to the hook: <b>${sel.map((h) => h.name).join(", ")}</b>`
        : "Switch on the hook with no rules. You can't add them later.",
    ];
    if (state.devBuy > 0) steps.push(`Buy <b>${fmtSol(state.devBuy)}</b> from your own curve`);
    $("#sign-steps").innerHTML = steps.map((s) => `<li><span>${s}</span></li>`).join("");
    $("#modal-error").hidden = true;
    lastFocus = document.activeElement;
    modal.hidden = false;
    $("#m-board").focus();
  }

  function closeModal() {
    modal.hidden = true;
    lastFocus?.focus?.();
  }

  $("#launch-btn").addEventListener("click", () => {
    const bad = validate();
    if (bad.length) {
      bad[0].scrollIntoView({ behavior: "smooth", block: "center" });
      bad[0].focus({ preventScroll: true });
      toast(`Fix ${bad.length} field${bad.length > 1 ? "s" : ""} before launching.`);
      return;
    }
    openModal();
  });
  $("#m-close").addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !modal.hidden) closeModal(); });

  $("#m-board").addEventListener("click", () => {
    const sel = selected();
    const game = sel.find((h) => h.cat === "games");
    const id = `mine-${Date.now().toString(36)}`;
    const token = {
      id, name: state.name.trim(), ticker: state.ticker, desc: state.desc.trim(), image: state.image,
      links: { x: state.x, web: state.web },
      createdAt: Date.now(), creator: "you", mc: state.startMc, vol24: 0, change: 0, holders: 1,
      curve: state.curve, startMc: state.startMc, gradMc: state.gradMc,
      hooks: sel.map((h) => h.id), settings: state.hooks, potShare: game ? state.potShare : 0, devBuy: state.devBuy,
      game: game ? gameState(game, true) : null,
    };
    if (!saveMine([token, ...loadMine()])) {
      const err = $("#modal-error");
      err.textContent = "This browser blocked local storage, so the preview can't be added to the board.";
      err.hidden = false;
      return;
    }
    location.href = `tokens.html?launched=${encodeURIComponent(id)}`;
  });

  refresh();
})();
