/* The launch form (launch.html).
 *
 * Five steps and a live preview, then a real launch on the cluster net.js names: built,
 * checked and sent through window.LureChain (vendor/lure-chain.js). Everything about the
 * cluster comes from window.LURE_NET (net.js). With no wallet, or while net.js still lacks a
 * value, the form works as a preview and says what is missing.
 *
 * The token's image and details are pinned to IPFS by /api/metadata (api/metadata.js) when the
 * review opens, and the launch writes the link it answers into the token. Where that function
 * has no key, or is not there at all, the form goes back to a short text kept inside the token
 * and an image that is a link.
 *
 * Only what the hook program does today can be launched: the wallet cap, the per-block limit
 * with its guard, and Last Buyer Wins, optionally hosted by an agent on a leash. The rest of
 * the catalogue (app.js) stays visible, marked "Not live yet".
 */
(() => {
  "use strict";

  const L = window.LURE;
  const NET = window.LURE_NET || null;
  const chain = window.LureChain || null;
  const wallets = chain ? chain.wallets : null;
  const { CATEGORIES, HOOKS, hookById, highlight, esc, toast } = L;
  const $ = (sel, root = document) => root.querySelector(sel);
  const reduce = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const cluster = NET ? NET.cluster : "the cluster";
  const FEES = (NET && NET.fees) || L.FEES;
  const SUPPLY = 1_000_000_000;
  // Empty when the page can build and send. Otherwise the one sentence that says why not.
  const notReady = !NET || !chain
    ? "This page could not load net.js and vendor/lure-chain.js."
    : NET.notReady(["rpcUrl", "hookProgram", "leashProgram", "configs"]);

  /* ---------------- What can be launched today ---------------- */

  // The settings of the three live rules, as the hook takes them. Names and descriptions stay the catalogue's.
  const LIVE = {
    maxw: [
      { key: "pct", label: "Max per wallet", unit: "% supply", min: 0.01, max: 100, step: 0.01, def: 2 },
    ],
    bundle: [
      { key: "pct", label: "Max bought per block", unit: "% supply", min: 0.01, max: 100, step: 0.01, def: 3 },
      { key: "guard", label: "Guard lasts", unit: "blocks", min: 0, max: 100000000, step: 1, def: 150, whole: true, help: "Counted from the first buy, about 0.4 s a block. 0 means it never comes down." },
    ],
    lbw: [
      { key: "timer", label: "Clock", unit: "min", min: 1, max: 10080, step: 1, def: 10, help: "What a buy that counts puts on the clock." },
      { key: "minBuy", label: "Smallest buy that counts", unit: "% supply", min: 0, max: 100, step: 0.001, def: 0.01 },
    ],
  };
  const AGENT = [
    { key: "budget", label: "Budget", unit: "SOL", min: 0, max: 100000, step: 0.001, def: 0.05, floor: 0.001, help: "Sent to the leash at launch. From there it can only go to the pot." },
    { key: "perSpend", label: "Most per action", unit: "SOL", min: 0, max: 100000, step: 0.001, def: 0.005 },
    { key: "perDay", label: "Most per day", unit: "SOL", min: 0, max: 100000, step: 0.001, def: 0.02 },
    { key: "clockMin", label: "Shortest clock", unit: "min", min: 1, max: 10080, step: 1, def: 2 },
    { key: "clockMax", label: "Longest clock", unit: "min", min: 1, max: 10080, step: 1, def: 30 },
    { key: "step", label: "Biggest turn", unit: "min", min: 0, max: 10080, step: 1, def: 5 },
    { key: "cooldown", label: "Wait between turns", unit: "min", min: 0, max: 10080, step: 1, def: 3 },
    { key: "fees", label: "For its network fees", unit: "SOL", min: 0, max: 10, step: 0.001, def: 0.005, floor: 0.001, help: "Sent to the agent's own address." },
  ];
  const defaultsOf = (fields) => Object.fromEntries(fields.map((f) => [f.key, f.def]));

  const state = {
    name: "", ticker: "", desc: "", website: "", twitter: "", telegram: "",
    file: null, fileUrl: "", fileStamp: "", // the picked image, its address in this page, and what tells it from another
    image: "", imageOk: false, // the image link of the fallback, and whether an image is showing
    hooks: {}, // live hook id -> settings
    agentOn: false, agent: { key: "", ...defaultsOf(AGENT) },
    curve: "graduating", firstBuy: 0,
  };
  const selected = () => HOOKS.filter((h) => state.hooks[h.id]);
  const agentActive = () => !!state.hooks.lbw && state.agentOn;
  // A key made on this page: { address, secret, file, downloaded }. In memory only, wiped as soon as it is not needed.
  let agentKey = null;
  // What the last review measured, and the form it measured it for.
  let measured = null;

  /* ---------------- Words and numbers ---------------- */

  const num = (v) => (v === "" || v == null ? NaN : Number(v));
  const show = (n) => (Number.isFinite(n) ? String(n) : "?");
  const short = (a) => (a && a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a || "");
  const isAddress = (a) => (chain ? chain.isAddress(a) : L.isAddress(a));
  const fmtTokens = (n) => n.toLocaleString("en-US", { maximumFractionDigits: n >= 1000 ? 0 : 2 });
  const fmtPct = (share) => `${(share * 100).toLocaleString("en-US", { maximumFractionDigits: share < 0.001 ? 4 : 2 })}%`;
  // SOL to four significant digits, as the token page writes it: 1, 3.655, 0.00396.
  function fmtSol(n) {
    if (!n) return "0";
    if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: n >= 1000 ? 0 : 3 });
    const digits = Math.min(12, Math.max(4, 3 - Math.floor(Math.log10(n))));
    return n.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
  }
  // Lamports as SOL, exactly: what is charged is not rounded.
  function exact(lamports) {
    const n = BigInt(Math.round(lamports)), abs = n < 0n ? -n : n;
    const fraction = (abs % 1000000000n).toString().padStart(9, "0").replace(/0+$/, "");
    return `${n < 0n ? "-" : ""}${(abs / 1000000000n).toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
  }
  const toLamports = (sol) => Math.round(Number(sol) * 1e9);
  const exactSol = (sol) => exact(toLamports(sol));
  const minutes = (m) => (chain ? chain.clockWords(Math.round(m * 60)) : `${m} min`);
  const mono = (text) => `<code>${esc(text)}</code>`;
  const addr = (a) => `<a href="${esc(NET.addressUrl(a))}" target="_blank" rel="noopener" title="${esc(a)}">${esc(short(a))}</a>`;
  const txLink = (sig) => `<a href="${esc(NET.txUrl(sig))}" target="_blank" rel="noopener">Transaction ${esc(short(sig))} ↗</a>`;

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

  /* ---------------- Before anything else: the cluster ---------------- */

  for (const node of document.querySelectorAll("[data-net]")) node.hidden = !NET || node.getAttribute("data-net") !== NET.cluster;
  if (notReady) {
    $("#lp-status").textContent = `${notReady} Until then this form is a preview: nothing can be built or sent.`;
    $("#lp-status").hidden = false;
  }
  const walletBtn = $("[data-wallet]");
  if (wallets) wallets.button(walletBtn); else walletBtn.hidden = true;

  /* ---------------- Step 1: the token ---------------- */

  const API = "/api/metadata";
  const MAX_IMAGE = 2 * 1024 * 1024; // the function's own cap
  const MAX_DESC = 1000;
  const IMAGE_LINK = /^https?:\/\/\S+$/i;
  // Whether this site can pin files. It can, until the function says otherwise.
  const hosting = { on: true };
  const HOST_NOTES = {
    "not-configured": "Image uploads are not set up on this site yet: the image is a link, and the description is kept short inside the token.",
    unavailable: "Image uploads are not available here: the image is a link, and the description is kept short inside the token.",
  };
  const UPLOAD_NOTE = "The image and these details go to IPFS when you open the review, and are public from then on.";

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

  /* The links, kept as they will be stored: a handle or a bare address becomes the whole
   * https link, and the field shows it on the way out. */
  const LINKS = {
    website: { el: $("#f-website"), bad: "A link like https://example.com, with no spaces." },
    twitter: { el: $("#f-twitter"), hosts: ["x.com", "twitter.com"], bad: "A link to X, like https://x.com/name." },
    telegram: { el: $("#f-telegram"), hosts: ["t.me", "telegram.me"], bad: "A link to Telegram, like https://t.me/name." },
  };
  function fullLink(key, value) {
    let text = value.trim();
    if (!text) return "";
    if (key === "twitter" && /^@?\w{1,15}$/.test(text)) text = `x.com/${text.replace(/^@/, "")}`;
    if (key === "telegram" && /^@?\w{4,32}$/.test(text)) text = `t.me/${text.replace(/^@/, "")}`;
    return /^https?:\/\//i.test(text) ? text.replace(/^http:/i, "https:") : `https://${text}`;
  }
  // The same check the function makes.
  function linkOk(key, link) {
    if (!link) return true;
    if (link.length > 200 || /\s/.test(link) || !/^https:\/\//i.test(link)) return false;
    let url;
    try { url = new URL(link); } catch { return false; }
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return !url.username && !url.password && host.includes(".") && (!LINKS[key].hosts || LINKS[key].hosts.includes(host));
  }
  for (const [key, { el }] of Object.entries(LINKS)) {
    el.addEventListener("input", () => { state[key] = fullLink(key, el.value); clearError(el); });
    el.addEventListener("change", () => { el.value = state[key]; });
  }

  /* The image: a file, dropped on the box or chosen through it, shown at once and pinned when
   * the review opens. Where nothing can be uploaded the box shows the image a link points to. */
  const avatar = $("#avatar"), dzImg = $("#dz-img"), fileInput = $("#f-file"), fileRemove = $("#file-remove");
  const imageInput = $("#f-image"), imageHelp = $("#image-help");
  const IMAGE_HELP = imageHelp.textContent;

  function paintImage() {
    dzImg.hidden = !state.imageOk;
    avatar.classList.toggle("has-img", state.imageOk);
    fileRemove.hidden = !state.file;
    avatar.setAttribute("aria-label", !hosting.on ? "Token image" : state.file ? `Token image: ${state.file.name}. Choose another file` : "Token image: choose a file");
  }

  // What a file is, by its first bytes: the function checks the same and refuses the rest.
  async function isImage(file) {
    const head = String.fromCharCode(...new Uint8Array(await file.slice(0, 12).arrayBuffer()));
    return head.startsWith("\x89PNG\r\n\x1a\n") || head.startsWith("\xff\xd8\xff") || head.startsWith("GIF87a") || head.startsWith("GIF89a")
      || (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP");
  }

  function dropFile() {
    if (state.fileUrl) URL.revokeObjectURL(state.fileUrl);
    Object.assign(state, { file: null, fileUrl: "", fileStamp: "", imageOk: false });
    dzImg.removeAttribute("src");
    fileInput.value = "";
  }

  async function takeFile(file) {
    if (!file || !hosting.on) return;
    clearError(avatar);
    let ok = false;
    try { ok = await isImage(file); } catch { /* it cannot be read: not an image */ }
    if (!ok) return setError(avatar, "That file is not a PNG, JPG, WebP or GIF.");
    if (file.size > MAX_IMAGE) return setError(avatar, `That image is ${(file.size / 1048576).toFixed(2)} MB. 2 MB is the most.`);
    dropFile();
    Object.assign(state, { file, fileUrl: URL.createObjectURL(file), fileStamp: [file.name, file.size, file.lastModified].join("|"), imageOk: true });
    dzImg.src = state.fileUrl;
    paintImage();
    refresh();
  }

  avatar.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => takeFile(fileInput.files[0]));
  fileRemove.addEventListener("click", () => {
    dropFile();
    clearError(avatar);
    paintImage();
    refresh();
    avatar.focus();
  });
  const carriesFiles = (e) => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
  avatar.addEventListener("dragover", (e) => {
    if (!carriesFiles(e) || !hosting.on) return;
    e.preventDefault();
    avatar.classList.add("is-over");
  });
  avatar.addEventListener("dragleave", () => avatar.classList.remove("is-over"));
  avatar.addEventListener("drop", (e) => {
    avatar.classList.remove("is-over");
    if (!carriesFiles(e)) return;
    e.preventDefault();
    takeFile(e.dataTransfer.files[0]);
  });
  // A file dropped beside the box would open in place of this page, and the form would be gone.
  for (const type of ["dragover", "drop"]) window.addEventListener(type, (e) => { if (carriesFiles(e)) e.preventDefault(); });

  dzImg.addEventListener("load", () => {
    state.imageOk = true;
    if (!state.file) imageHelp.textContent = IMAGE_HELP;
    paintImage();
    refresh();
  });
  dzImg.addEventListener("error", () => {
    if (state.file) {
      dropFile();
      setError(avatar, "That file could not be read as an image.");
    } else {
      state.imageOk = false;
      if (state.image.trim()) imageHelp.textContent = "That link did not load as an image in this browser. It is stored as written.";
    }
    paintImage();
    refresh();
  });
  imageInput.addEventListener("input", () => {
    state.image = imageInput.value;
    clearError(imageInput);
    state.imageOk = false;
    imageHelp.textContent = IMAGE_HELP;
    const link = state.image.trim();
    if (!hosting.on && IMAGE_LINK.test(link)) dzImg.src = link; else dzImg.removeAttribute("src");
    paintImage();
    refresh();
  });

  // Nothing can be pinned from here: back to the image as a link and a short text inside the token.
  function noHosting(why) {
    if (!hosting.on) return;
    hosting.on = false;
    dropFile();
    clearError(avatar);
    $("#host-note").textContent = HOST_NOTES[why];
    $("#host-note").hidden = false;
    $("#image-field").hidden = false;
    $("#links-row").hidden = true;
    $("#file-help").hidden = true;
    $("#f-desc").maxLength = 200;
    avatar.disabled = true;
    avatar.classList.add("lp-avatar");
    $("#dz-words").textContent = "No image";
    $("#dz-small").textContent = "Paste a link below";
    paintImage();
    refresh();
  }

  // Asked once, as the page opens: nothing is sent and nothing is pinned. The function answers
  // { ready: true }, or "not-configured" while it has no key. A host with no function answers neither.
  async function askHosting() {
    try {
      const res = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"check":true}' });
      const data = await res.json().catch(() => null);
      if (res.status === 503 && data && data.error === "not-configured") noHosting("not-configured");
      else if ((res.ok && !(data && data.ready === true)) || [403, 404, 405].includes(res.status)) noHosting("unavailable");
    } catch { /* offline, or opened as a file: the review says so when it tries */ }
  }

  // What the token will carry. With uploads, all of it, behind a link. Without, what fits in
  // 200 bytes inside the mint: the description is cut, then dropped.
  function stored() {
    if (hosting.on) return { description: state.desc.trim(), image: state.fileUrl, note: UPLOAD_NOTE };
    const words = { name: state.name.trim(), symbol: state.ticker, description: state.desc, image: IMAGE_LINK.test(state.image.trim()) ? state.image.trim() : "" };
    const clean = state.desc.replace(/\s+/g, " ").trim();
    if (!chain) return { description: clean, image: words.image, note: "" };
    const uri = chain.metadataUri(words);
    const back = chain.metadataFromUri(uri);
    let note = "Name and ticker are written into the token itself.";
    if (clean || words.image) {
      note = `Kept on chain with the token: ${new TextEncoder().encode(uri).length} of 200 bytes.`;
      if (clean && !back.description) note += " The description does not fit and is left out.";
      else if (clean && back.description !== clean) note += ` The description is cut to “${back.description}”`;
      if (words.image && !back.image) note += " The image link does not fit and is left out.";
    }
    return { description: back.description, image: back.image, note };
  }

  /* ---------------- Step 2: hooks ---------------- */

  const GROUPS = {
    games: ["Games", "One game per token. Last Buyer Wins is the one that is live."],
    access: ["Access", "Who can buy, and when."],
    guards: ["Guards", "Caps on what a wallet and a block can take."],
    oracle: ["Oracle", "Driven by live Pyth prices."],
  };
  const picker = $("#hook-picker");

  function numberField(attrs, f) {
    return `<label class="field"><span class="field-label">${f.label}</span>`
      + `<span class="input-unit"><input type="number" ${attrs} min="${f.min}" max="${f.max}" step="${f.step}" value="${f.def}" inputmode="decimal"><span class="unit">${f.unit}</span></span>`
      + `${f.help ? `<span class="field-help">${f.help}</span>` : ""}<span class="field-error" hidden></span></label>`;
  }

  const agentBlock = () => `
    <div class="lp-agent" id="agent-wrap" hidden>
      <p class="lp-note">The pot is the SOL sent to this token's rules account. Nothing fills it by itself.</p>
      <label class="lp-check"><input type="checkbox" id="f-agent"><span>Host the game with an agent on a leash</span></label>
      <div id="agent-box" hidden>
        <p class="lp-note" id="agent-can"></p>
        <div class="field">
          <label class="field-label" for="f-agent-key">Agent's address</label>
          <div class="lp-key">
            <input type="text" id="f-agent-key" placeholder="Paste an address" autocomplete="off" autocapitalize="off" spellcheck="false">
            <button type="button" class="btn btn-small btn-ghost" id="agent-make">Generate a key</button>
          </div>
          <div class="lp-keyfile" id="agent-keyfile" hidden>
            <button type="button" class="btn btn-small btn-primary" id="agent-save">Download the key file</button>
            <span class="field-help" id="agent-keynote" aria-live="polite"></span>
          </div>
          <span class="field-error" hidden></span>
        </div>
        <div class="hset">${AGENT.map((f) => numberField(`data-agent="${f.key}"`, f)).join("")}</div>
        <p class="lp-note">You run the agent yourself: Lure's reference agent is a Node script for any machine that stays on, started with the token's address, yours and the agent's key file.</p>
      </div>
    </div>`;

  // What is not live stays on the shelf: visible, marked, and impossible to pick.
  function pickCard(h) {
    const fields = LIVE[h.id];
    return `<div class="hpick${fields ? "" : " is-soon"}" data-hook="${h.id}">
      <label class="hpick-label">
        <input type="checkbox" class="hpick-input" value="${h.id}"${fields ? "" : " disabled"}>
        <span class="hpick-check" aria-hidden="true"></span>
        <span class="hpick-text">
          <span class="hpick-name">${h.name}${fields ? "" : '<span class="tag tag-muted lp-soon">Not live yet</span>'}</span>
          <span class="hpick-desc">${h.desc}</span>
        </span>
      </label>
      ${fields ? `<div class="hset" hidden>${fields.map((f) => numberField(`data-hook="${h.id}" data-key="${f.key}"`, f)).join("")}</div>` : ""}
      ${h.id === "lbw" ? agentBlock() : ""}
    </div>`;
  }

  picker.innerHTML = Object.keys(CATEGORIES).map((cat) => `
    <div class="hgroup">
      <div class="hgroup-head"><span class="hchip cat-${cat}">${GROUPS[cat][0]}</span><span class="hgroup-note">${GROUPS[cat][1]}</span></div>
      <div class="hgroup-grid">${HOOKS.filter((h) => h.cat === cat).map(pickCard).join("")}</div>
    </div>`).join("");

  const pickEl = (id) => picker.querySelector(`.hpick[data-hook="${id}"]`);
  const settingEl = (id, key) => picker.querySelector(`[data-hook="${id}"][data-key="${key}"]`);
  const agentEl = (key) => picker.querySelector(`[data-agent="${key}"]`);
  const keyInput = $("#f-agent-key");

  function setHook(id, on) {
    const card = pickEl(id);
    card.classList.toggle("is-on", on);
    card.querySelector(".hpick-input").checked = on;
    card.querySelector(".hset").hidden = !on;
    if (id === "lbw") $("#agent-wrap").hidden = !on;
    if (on) {
      state.hooks[id] = defaultsOf(LIVE[id]);
      for (const f of LIVE[id]) {
        const el = settingEl(id, f.key);
        el.value = f.def;
        clearError(el);
      }
    } else {
      delete state.hooks[id];
    }
  }

  picker.addEventListener("change", (e) => {
    const t = e.target;
    if (t.classList.contains("hpick-input")) {
      if (!LIVE[t.value]) { t.checked = false; return; }
      setHook(t.value, t.checked);
      refresh();
    } else if (t.id === "f-agent") {
      state.agentOn = t.checked;
      $("#agent-box").hidden = !t.checked;
      refresh();
    }
  });
  picker.addEventListener("input", (e) => {
    const t = e.target;
    if (t.dataset.key && state.hooks[t.dataset.hook]) state.hooks[t.dataset.hook][t.dataset.key] = num(t.value);
    else if (t.dataset.agent) state.agent[t.dataset.agent] = num(t.value);
    else if (t === keyInput) {
      state.agent.key = t.value.trim();
      // Typing another address lets go of a key made here.
      if (agentKey && agentKey.address !== state.agent.key) dropKey();
      paintKey();
    } else return;
    clearError(t);
    refresh();
  });

  /* ---------------- The agent's key, made here and handed over ---------------- */

  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  function base58(bytes) {
    let n = 0n, out = "";
    for (const b of bytes) n = (n << 8n) | BigInt(b);
    for (; n > 0n; n /= 58n) out = B58[Number(n % 58n)] + out;
    for (const b of bytes) { if (b !== 0) break; out = `1${out}`; }
    return out;
  }

  // An Ed25519 key from the browser itself, in the shape of a Solana keypair file: 32 secret bytes, then the 32 public ones.
  async function makeKey() {
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    if (pkcs8.length !== 48 || pub.length !== 32) throw new Error("unexpected key shape");
    const secret = new Uint8Array(64);
    secret.set(pkcs8.subarray(16), 0);
    secret.set(pub, 32);
    pkcs8.fill(0);
    return { address: base58(pub), secret };
  }

  function dropKey() {
    if (agentKey) agentKey.secret.fill(0);
    agentKey = null;
  }

  function paintKey() {
    const mine = !!agentKey && agentKey.address === state.agent.key;
    $("#agent-keyfile").hidden = !mine;
    if (!mine) return;
    $("#agent-keynote").textContent = agentKey.downloaded
      ? `Downloaded as ${agentKey.file}. Keep it: it is the only copy.`
      : "Download it before you go on. This page does not keep the key, and without the file nobody can run this agent.";
  }

  $("#agent-make").addEventListener("click", async () => {
    try {
      const made = await makeKey();
      dropKey();
      agentKey = { ...made, file: `lure-agent-${made.address.slice(0, 8)}.json`, downloaded: false };
      state.agent.key = keyInput.value = made.address;
      clearError(keyInput);
    } catch {
      setError(keyInput, "This browser cannot make a key. Make one elsewhere (solana-keygen new) and paste its address.");
    }
    paintKey();
    refresh();
  });

  $("#agent-save").addEventListener("click", () => {
    if (!agentKey) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(Array.from(agentKey.secret))], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = agentKey.file;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    agentKey.downloaded = true;
    clearError(keyInput);
    paintKey();
  });
  window.addEventListener("pagehide", dropKey);

  /* ---------------- Step 3: the curve, read from its config ---------------- */

  // Where Meteora keeps three numbers in a config for hook tokens (ConfigWithTransferHook, 1128 bytes).
  const CONFIG = { LEN: 1128, TAG: [40, 220, 194, 251, 41, 199, 123, 253], DECIMALS: 235, THRESHOLD: 264, END_PRICE: 280, START_PRICE: 392 };
  const curves = { reading: !notReady, graduating: null, infinite: null };

  function decodeConfig(data) {
    if (!data || data.length !== CONFIG.LEN || CONFIG.TAG.some((byte, i) => data[i] !== byte)) return null;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const u128 = (at) => view.getBigUint64(at, true) | (view.getBigUint64(at + 8, true) << 64n);
    // A price is kept as its square root, in 64.64 fixed point, in lamports per base unit.
    const cap = (root) => { const r = Number(root) / 2 ** 64; return r * r * 10 ** (data[CONFIG.DECIMALS] - 9) * SUPPLY; };
    const startCap = cap(u128(CONFIG.START_PRICE)), endCap = cap(u128(CONFIG.END_PRICE));
    const threshold = Number(view.getBigUint64(CONFIG.THRESHOLD, true)) / 1e9;
    return startCap > 0 && endCap > startCap && threshold > 0 ? { startCap, endCap, threshold } : null;
  }

  async function readCurves(again) {
    try {
      const PublicKey = chain.poolAuthority().constructor;
      const kinds = ["graduating", "infinite"];
      const accounts = await chain.connection().getMultipleAccountsInfo(kinds.map((kind) => new PublicKey(NET.configs[kind])));
      kinds.forEach((kind, i) => { curves[kind] = decodeConfig(accounts[i] && accounts[i].data); });
    } catch {
      if (again) return void setTimeout(() => readCurves(false), 8000);
    }
    curves.reading = false;
    refresh();
  }

  function curveWords(kind) {
    const c = curves[kind];
    const start = c ? `Starts at ${fmtSol(c.startCap)} SOL of market cap. ` : curves.reading ? `Reading this curve from ${cluster}… ` : "";
    if (kind === "infinite") return `${start}Never graduates. The hook stays for the life of the token.`;
    return c
      ? `${start}At ${fmtSol(c.endCap)} SOL, with ${fmtSol(c.threshold)} SOL in the curve, it moves to a Meteora pool and the hook is removed.`
      : `${start}When the curve fills, the token moves to a Meteora pool and the hook is removed.`;
  }

  function curveNote() {
    const rules = selected().length > 0;
    const parts = [];
    if (state.curve === "graduating") {
      if (rules) parts.push("At graduation every rule stops.");
      if (state.hooks.lbw) parts.push("Whoever leads the round then takes the pot, and no new round starts.");
      if (agentActive()) parts.push("What is left of the agent's budget cannot be taken back.");
    } else if (rules) {
      parts.push("The rules run for the life of the token.");
    }
    parts.push("While its hook is on, a token trades on its page here: Jupiter does not route it.");
    parts.push(`Supply ${SUPPLY.toLocaleString("en-US")}, 6 decimals.`);
    return parts.join(" ");
  }

  document.querySelectorAll('input[name="curve"]').forEach((radio) =>
    radio.addEventListener("change", () => {
      state.curve = radio.value;
      refresh();
    }),
  );

  /* ---------------- Steps 4 and 5 ---------------- */

  const feeParts = [["creator", "creator", "seg-1"], ["treasury", "Lure treasury", "seg-3"], ["protocol", "Meteora", "seg-4"]];
  $("#fee-line").textContent = `Every trade on the curve pays ${FEES.total}% in SOL, split the same way for every token.`;
  $("#fee-bar").innerHTML = feeParts.map(([key, , cls]) => `<span style="--w:${Math.round((FEES[key] / FEES.total) * 1000) / 10}%" class="seg ${cls}">${FEES[key]}%</span>`).join("");
  $("#fee-legend").innerHTML = feeParts.map(([key, name, cls]) => `<li><i class="dot ${cls}"></i>${FEES[key]}% ${name}</li>`).join("");

  const devInput = $("#f-dev");
  devInput.addEventListener("input", () => {
    state.firstBuy = num(devInput.value);
    clearError(devInput);
    refresh();
  });

  /* ---------------- What the form says, as the chain layer takes it ---------------- */

  function rulesInput() {
    const h = state.hooks;
    return {
      maxWalletPct: h.maxw ? h.maxw.pct : 0,
      blockLimitPct: h.bundle ? h.bundle.pct : 0,
      guardSlots: h.bundle ? h.bundle.guard : 0,
      ...(h.lbw ? { game: { minBuyPct: h.lbw.minBuy, timerSeconds: Math.round(h.lbw.timer * 60) } } : {}),
    };
  }
  function agentInput(key) {
    const a = state.agent, seconds = (m) => Math.round(m * 60);
    return {
      key,
      clock: { value: seconds(state.hooks.lbw.timer), min: seconds(a.clockMin), max: seconds(a.clockMax), step: seconds(a.step), cooldown: seconds(a.cooldown) },
      maxPerSpend: a.perSpend, maxPerDay: a.perDay, budget: a.budget, feeMoney: a.fees,
    };
  }
  function launchParams(creator) {
    return {
      creator, name: state.name.trim(), symbol: state.ticker,
      // With uploads the token carries a link, added at review. Without, the words themselves.
      ...(hosting.on ? {} : { description: state.desc, image: state.image.trim() }),
      curve: state.curve,
      rules: rulesInput(),
      ...(agentActive() ? { agent: agentInput(state.agent.key) } : {}),
      ...(state.firstBuy > 0 ? { firstBuy: { sol: state.firstBuy } } : {}),
    };
  }
  // What the hook or the leash would answer BadConfig to, said in the layer's own plain words. "" when the rules hold together.
  function rulesProblem() {
    if (!chain) return "";
    try {
      // Any valid address stands in for the agent's while it is being typed: its own field checks it.
      chain.planRules({ rules: rulesInput(), agent: agentActive() ? agentInput(isAddress(state.agent.key) ? state.agent.key : NET.hookProgram) : null });
      return "";
    } catch (error) {
      return error && error.kind === "bad-launch" ? error.message : "";
    }
  }

  /* ---------------- Live preview ---------------- */

  function previewCard(meta) {
    const name = state.name.trim() || "Your token", tick = state.ticker || "TICKER";
    const image = state.imageOk && meta.image
      ? `<img src="${esc(meta.image)}" alt="">`
      : `<span class="tav-gen" style="background:#fd4b00;color:#000">${esc((state.ticker || state.name.trim() || "?").charAt(0).toUpperCase())}</span>`;
    const chips = selected().map((h) => `<span class="hchip cat-${h.cat}">${h.name}</span>`);
    if (agentActive()) chips.push(`<span class="hchip cat-access">Agent on a leash</span>`);
    const game = state.hooks.lbw;
    const c = curves[state.curve];
    const stats = [["Starts at", c ? `${fmtSol(c.startCap)} SOL` : curves.reading ? "…" : "not read"], ["Supply", "1B"], ["Fee", `${FEES.total}%`]];
    const curve = state.curve === "infinite"
      ? `<div class="tcurve is-perm"><span class="tcurve-k">∞ Infinite bonding</span><span class="tcurve-note">the hook stays</span></div>`
      : `<div class="tcurve"><div class="tbar"><i style="width:0%"></i></div><span><b>0%</b> to graduation</span>${c ? `<span class="tcurve-note">at ${fmtSol(c.threshold)} SOL in the curve</span>` : ""}</div>`;
    return `<article class="tcard is-mine">
      <header class="tcard-head">
        <div class="tav">${image}</div>
        <div class="tid">
          <h3><span class="tname">${esc(name)}</span> <span class="ttick">$${esc(tick)}</span></h3>
          <p class="tby"><span class="tmine">Yours</span> · not launched</p>
        </div>
        <span class="tchg is-fresh">Preview</span>
      </header>
      ${meta.description ? `<p class="tdesc">${esc(meta.description)}</p>` : ""}
      <div class="thooks">${chips.join("") || `<span class="hchip cat-none">No rules</span>`}</div>
      ${game ? `<div class="tgame"><span class="tgame-k">Last Buyer Wins</span><span>Pot <b>0 SOL</b></span><span class="tclock">${Number.isFinite(game.timer) ? esc(minutes(game.timer)) : "?"} a buy</span></div>` : ""}
      <dl class="tstats">${stats.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>
      ${curve}
    </article>`;
  }

  function ruleCode() {
    const tick = state.ticker || "TICKER", h = state.hooks, a = state.agent;
    const lines = [`# $${tick}: checked on every transfer`, `rule ${tick.toLowerCase()} {`];
    if (h.maxw) lines.push(`  always -> max_wallet ${show(h.maxw.pct)}%`);
    if (h.bundle) {
      lines.push(h.bundle.guard === 0
        ? `  always -> max_buy_per_block ${show(h.bundle.pct)}%`
        : `  when guard_up -> max_buy_per_block ${show(h.bundle.pct)}%  # ${show(h.bundle.guard)} blocks from the first buy`);
    }
    if (h.lbw) lines.push(`  game last_buyer_wins { clock ${show(h.lbw.timer)}m, min_buy ${show(h.lbw.minBuy)}% }`);
    if (agentActive()) {
      lines.push(`  agent ${isAddress(a.key) ? short(a.key) : "?"} {`);
      lines.push(`    spend ${show(a.perSpend)} SOL per action, ${show(a.perDay)} SOL per day -> pot`);
      lines.push(`    clock ${show(a.clockMin)}m to ${show(a.clockMax)}m, step ${show(a.step)}m, every ${show(a.cooldown)}m`);
      lines.push("  }");
    }
    if (!selected().length) lines.push("  # no rules: the hook only counts transfers");
    lines.push(state.curve === "infinite" ? "  # infinite bonding: these rules never switch off" : "  # graduates: the hook is removed there and these rules stop");
    lines.push("}");
    return lines.join("\n");
  }

  // One line: what the agent will be able to do, and nothing else.
  function agentWords() {
    const a = state.agent;
    return `This agent can put up to ${show(a.perSpend)} SOL into the pot per action and ${show(a.perDay)} SOL per day, out of a budget of ${show(a.budget)} SOL; `
      + `turn the clock between ${show(a.clockMin)} and ${show(a.clockMax)} min, by ${show(a.step)} min at most, once every ${show(a.cooldown)} min; and pay the winner. Nothing else.`;
  }

  function sideCost() {
    const a = state.agent, agent = agentActive();
    const buy = Math.max(0, Number.isFinite(state.firstBuy) ? state.firstBuy : 0);
    const spends = buy + (agent ? (a.budget || 0) + (a.fees || 0) : 0);
    const m = measured && measured.form === JSON.stringify(launchParams("")) ? measured : null;
    const rows = [["Rent and network fees", m ? `${exact(m.rentAndFees)} SOL` : "measured at review"], ["First buy", `${show(buy)} SOL`]];
    if (agent) rows.push(["Agent's budget", `${show(a.budget)} SOL`], ["Agent's network fees", `${show(a.fees)} SOL`]);
    const total = m ? `${exact(m.total)} SOL` : spends > 0 ? `${exactSol(spends)} SOL + rent` : "rent only";
    return rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("") + `<div class="cost-total"><dt>Total</dt><dd>${esc(total)}</dd></div>`;
  }

  // What is missing for a real launch, in one line.
  function sideMissing() {
    if (notReady) return "Preview only.";
    const wallet = wallets.current();
    if (wallet) return `Launching from ${short(wallet.address)} on ${cluster}.`;
    return wallets.list().some((w) => w.installed)
      ? "Preview: no wallet is connected."
      : "Preview: no wallet found in this browser. Install Phantom, Solflare or Backpack, or open this page inside your wallet's browser.";
  }

  function refresh() {
    const meta = stored();
    $("#meta-note").textContent = meta.note;
    $("#preview").innerHTML = previewCard(meta);
    $("#rule-code").innerHTML = highlight(ruleCode());
    $("#curve-graduating").textContent = curveWords("graduating");
    $("#curve-infinite").textContent = curveWords("infinite");
    $("#curve-note").textContent = curveNote();
    $("#agent-can").textContent = agentWords();
    $("#cost").innerHTML = sideCost();
    $("#side-missing").textContent = sideMissing();
    const problem = rulesProblem(), out = $("#rules-problem");
    out.textContent = problem;
    out.hidden = !problem;
  }

  /* ---------------- Checking the form ---------------- */

  function validate() {
    const bad = [];
    const check = (ok, el, msg) => {
      if (ok) return true;
      if (!bad.includes(el)) { setError(el, msg); bad.push(el); }
      return false;
    };
    const inRange = (f, v) => Number.isFinite(v) && v >= f.min && v <= f.max && (!f.whole || Number.isInteger(v)) && (!f.floor || v === 0 || v >= f.floor);
    const rangeWords = (f) => (f.floor ? `0, or ${f.floor} ${f.unit} or more.` : f.whole ? `A whole number from ${f.min} to ${f.max.toLocaleString("en-US")}.` : `Between ${f.min} and ${f.max.toLocaleString("en-US")}.`);

    const nameBytes = new TextEncoder().encode(state.name.trim()).length;
    if (check(nameBytes > 0, $("#f-name"), "Give your token a name.")) check(nameBytes <= 32, $("#f-name"), "Too long: a name is 32 bytes at most.");
    check(/^[A-Z0-9]{2,10}$/.test(state.ticker), $("#f-ticker"), "2 to 10 letters or numbers.");
    if (hosting.on) {
      check(state.desc.trim().length <= MAX_DESC, $("#f-desc"), "1,000 characters at most.");
      for (const [key, { el: input, bad: words }] of Object.entries(LINKS)) check(linkOk(key, state[key]), input, words);
    } else {
      check(!state.image.trim() || IMAGE_LINK.test(state.image.trim()), imageInput, "A link that starts with https://, with no spaces.");
    }

    for (const id of Object.keys(state.hooks)) {
      for (const f of LIVE[id]) check(inRange(f, state.hooks[id][f.key]), settingEl(id, f.key), rangeWords(f));
    }
    if (agentActive()) {
      const a = state.agent, timer = state.hooks.lbw.timer;
      if (check(isAddress(a.key), keyInput, "Paste a Solana address, or generate a key.")) {
        check(!agentKey || agentKey.address !== a.key || agentKey.downloaded, keyInput, "Download the key file first: this page does not keep it.");
      }
      for (const f of AGENT) check(inRange(f, a[f.key]), agentEl(f.key), rangeWords(f));
      check(a.perSpend <= a.perDay, agentEl("perSpend"), "No more than the cap per day.");
      check(a.clockMin <= a.clockMax, agentEl("clockMin"), "No longer than the longest clock.");
      check(timer >= a.clockMin && timer <= a.clockMax, settingEl("lbw", "timer"), `Inside the agent's range: ${show(a.clockMin)} to ${show(a.clockMax)} min.`);
    }
    check(Number.isFinite(state.firstBuy) && (state.firstBuy === 0 || state.firstBuy >= 0.0001), devInput, "0, or 0.0001 SOL or more.");
    // Rules that contradict each other: said under the hooks, where the answer is.
    if (!bad.length && rulesProblem()) bad.push($("#rules-problem"));
    return bad;
  }

  /* ================= The review, and the launch ================= */

  const modal = $("#modal"), card = $("#modal-card");
  const el = {
    kicker: $("#m-kicker"), title: $("#modal-title"), status: $("#m-status"), upload: $("#m-upload"), steps: $("#sign-steps"), cost: $("#m-cost"),
    error: $("#modal-error"), tryForm: $("#m-try"), tryInput: $("#m-address"), done: $("#m-done"), go: $("#m-go"), close: $("#m-close"),
    stamp: $("#stamp"),
  };
  // stage: closed | idle (nothing to sign) | uploading | building | ready | sending | failed | done
  // retry: the upload did not go through, and the button tries the review again.
  const flow = { stage: "closed", run: 0, creator: "", tryAddress: "", params: null, built: null, steps: [], cost: null, failedAt: 0, landed: 0, retry: false };
  let lastFocus = null;

  const PROGRAMS = {
    "11111111111111111111111111111111": "System",
    ComputeBudget111111111111111111111111111111: "Compute budget",
    TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "Token",
    TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: "Token-2022",
    ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "Associated token",
    dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN: "Meteora DBC",
  };
  if (NET) { PROGRAMS[NET.hookProgram] = "Lure hook"; PROGRAMS[NET.leashProgram] = "Lure leash"; }

  function say(html, busy) {
    el.status.innerHTML = html;
    if (busy) el.status.setAttribute("aria-busy", "true"); else el.status.removeAttribute("aria-busy");
  }
  function trouble(html) {
    el.error.innerHTML = html;
    el.error.hidden = !html;
  }
  // Where the token's details went, under the status line.
  function uploadLine(html) {
    el.upload.innerHTML = html;
    el.upload.hidden = !html;
  }

  /* ---------------- The image and the details, pinned before anything is built ---------------- */

  // What was pinned last, and for which image and details: the same ones are not sent twice.
  let pinned = null;  // { key, uri, image }
  let pinning = null; // { key, promise }: an upload on its way
  const details = () => ({ name: state.name.trim(), symbol: state.ticker, description: state.desc.trim(), website: state.website, twitter: state.twitter, telegram: state.telegram });
  const detailsKey = () => JSON.stringify([details(), state.fileStamp]);

  const base64 = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^[^,]*,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const uploadError = (kind, message) => Object.assign(new Error(message), { kind });

  // One call to the function. Answers { uri, image }, or throws what went wrong in plain words.
  async function sendDetails(words, file) {
    let res;
    try {
      const image = file ? { type: file.type, data: await base64(file) } : null;
      res = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...words, image }) });
    } catch {
      throw uploadError("network", "This page could not reach the upload. Check your connection and try again.");
    }
    const data = await res.json().catch(() => null);
    const code = data && data.error;
    if (res.ok && data && /^https:\/\/\S+$/.test(data.uri || "")) return { uri: data.uri, image: data.image || "" };
    if (code === "not-configured") throw uploadError("not-configured", "");
    if (code === "bad-origin" || res.status === 404 || res.status === 405) throw uploadError("unavailable", "");
    if (code === "bad-request") throw uploadError("refused", data.message || "The upload was refused.");
    if (code === "slow-down") {
      const wait = Number(data.retryAfter) || 60;
      throw uploadError("refused", `Too many uploads from this connection. Try again in ${wait > 90 ? `${Math.ceil(wait / 60)} minutes` : `${wait} seconds`}.`);
    }
    if (code === "too-large" || res.status === 413) throw uploadError("refused", "The image is too large to send. 2 MB is the most.");
    if (code === "upload-failed") {
      throw uploadError("failed", `The pinning service did not take the ${data.step === "metadata" ? "details" : "image"}${data.status ? ` (it answered ${data.status})` : ""}. Try again in a moment.`);
    }
    throw uploadError("failed", `The upload did not go through (${res.status}). Try again in a moment.`);
  }

  function pin() {
    const key = detailsKey();
    if (pinned && pinned.key === key) return Promise.resolve(pinned);
    if (pinning && pinning.key === key) return pinning.promise;
    const promise = sendDetails(details(), state.file)
      .then((got) => (pinned = { key, ...got }))
      .finally(() => { if (pinning && pinning.promise === promise) pinning = null; });
    pinning = { key, promise };
    return promise;
  }

  // What one transaction does, in a sentence. `b` is what the builder returned, once there is one.
  function stepWords(label, b) {
    const symbol = esc(b ? b.symbol : state.ticker), a = state.agent;
    const curve = (b ? b.curve : state.curve) === "infinite" ? "an Infinite bonding curve" : "a curve that graduates";
    const at = b ? ` at ${mono(short(b.mint))}` : "";
    const first = b && b.firstBuy;
    const buy = first
      ? `${exactSol(first.sol)} SOL of it: about ${fmtTokens(first.tokens)} ${symbol}, ${fmtPct(first.share)} of supply, and no less than ${fmtTokens(first.minTokens)}`
      : `${show(state.firstBuy)} SOL of it`;
    if (label === "Leash and rules") return `Creates the agent's leash${b ? ` at ${mono(short(b.leash))}` : ""} and writes the token's rules. The rules and the leash's limits can never be changed.`;
    if (label === "Rules") return selected().length ? "Writes the token's rules. They can never be changed." : "Writes the token's rules: none. None can be added later.";
    if (label === "Token, curve and first buy") return `Creates $${symbol}${at} on ${curve} and, in the same transaction, buys ${buy}.`;
    if (label === "Token and curve") return `Creates $${symbol}${at} on ${curve}.`;
    if (label === "First buy") return `Buys ${buy}.`;
    if (label === "Agent's budget") {
      const budget = b ? b.spends.budget : a.budget, fee = b ? b.spends.feeMoney : a.fees;
      const parts = [];
      if (budget > 0) parts.push(`${exactSol(budget)} SOL to the leash, the agent's budget`);
      if (fee > 0) parts.push(`${exactSol(fee)} SOL to the agent's own address, for its network fees`);
      return `Sends ${parts.join(" and ")}.`;
    }
    return "";
  }

  // Before anything is built: the steps as the form has them.
  function plannedSteps() {
    const labels = [agentActive() ? "Leash and rules" : "Rules", state.firstBuy > 0 ? "Token, curve and first buy" : "Token and curve"];
    if (agentActive() && (state.agent.budget > 0 || state.agent.fees > 0)) labels.push("Agent's budget");
    return labels.map((label) => ({ label, text: stepWords(label, null), meta: "", cls: "", state: "" }));
  }

  // The programs a transaction calls, its size, and who signs it: read from the transaction itself.
  function stepMeta(entry) {
    const names = [];
    for (const ix of entry.tx.instructions) {
      const id = ix.programId.toBase58(), name = PROGRAMS[id] || short(id);
      if (!names.includes(name)) names.push(name);
    }
    const bytes = entry.tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
    const count = entry.tx.instructions.length;
    return `${count} instruction${count === 1 ? "" : "s"}: ${names.join(", ")} · ${bytes} bytes · signed by you${entry.signers.length ? " and the new token's key" : ""}`;
  }

  function paintSteps() {
    el.steps.innerHTML = flow.steps.map((s) => `<li${s.cls ? ` class="is-${s.cls}"` : ""}><span><b>${esc(s.label)}</b>`
      + `<span class="lp-step-text">${s.text}</span>`
      + (s.meta ? `<span class="lp-step-meta">${esc(s.meta)}</span>` : "")
      + (s.state ? `<span class="lp-step-state">${s.state}</span>` : "")
      + `</span></li>`).join("");
  }
  function setStep(i, cls, html) {
    Object.assign(flow.steps[i], { cls, state: html });
    paintSteps();
  }

  function buttons() {
    const wallet = wallets && wallets.current();
    const s = flow.stage, c = flow.cost;
    const left = flow.steps.length - flow.failedAt;
    el.go.hidden = s === "done" || !!notReady;
    el.go.textContent = s === "sending" ? "Working…"
      : s === "uploading" ? "Uploading…"
      : s === "building" ? "Checking…"
      : s === "failed" ? (flow.landed ? `Try the ${left === 1 ? "last step" : `last ${left} steps`} again` : "Try again")
      : flow.retry ? "Try again"
      : !wallet ? "Connect wallet"
      : "Sign and launch";
    el.go.disabled = s === "sending" || s === "building" || s === "uploading"
      || (!flow.retry && !!wallet && s !== "failed" && !(s === "ready" && c && c.ok && c.enough && wallet.address === flow.creator));
    el.close.disabled = s === "sending";
    el.close.textContent = s === "done" ? "Close" : s === "failed" && flow.landed ? "Close" : "Keep editing";
  }

  /* ---------------- What it costs, asked of the cluster ---------------- */

  /* Simulates what can be simulated before anything lands and adds up what leaves the wallet.
   * Each transaction is simulated on its own from the wallet's balance now; what it takes is the
   * difference. A first buy cannot be simulated yet (it reads rules that the first transaction
   * creates), so the pool is simulated without it and the buy is added: its SOL, and the rent of
   * the token account it opens, as the cluster quotes it. */
  const TOKEN_ACCOUNT_BYTES = 175; // a Token-2022 account of a mint with a transfer hook
  const WRAPPED_SOL_BYTES = 165;   // opened and closed inside the buy: needed for a moment, then returned
  const SIGNATURE_FEE = 5000;

  async function measure(b, params) {
    const conn = chain.connection();
    const entries = b.transactions;
    const payer = entries[0].tx.feePayer;
    const first = b.firstBuy;
    const poolAt = entries.findIndex((entry) => entry.label.startsWith("Token"));
    const together = !!first && !first.ownTransaction;
    // The same token without its first buy: same mint key, same metadata, so the same rent.
    const alone = together
      ? (await chain.buildLaunch({ ...params, firstBuy: null, uri: b.uri, mintKeypair: entries[0].signers[0] })).transactions.find((entry) => entry.label === "Token and curve")
      : null;
    const [before, rents, ...sims] = await Promise.all([
      conn.getBalance(payer, "confirmed"),
      first ? Promise.all([conn.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_BYTES), conn.getMinimumBalanceForRentExemption(WRAPPED_SOL_BYTES)]) : [0, 0],
      ...entries.map((entry, i) => (entry.label === "First buy" ? null : chain.simulate(i === poolAt && alone ? alone.tx : entry.tx))),
    ]);
    const buyLamports = first ? toLamports(first.sol) : 0;
    const priority = (units) => Math.ceil((units * ((NET && NET.priorityMicroLamports) || 0)) / 1e6);
    let total = 0, ok = true, known = true;
    const checks = entries.map((entry, i) => {
      if (entry.label === "First buy") {
        total += buyLamports + rents[0] + SIGNATURE_FEE + priority(300000);
        return { cls: "", state: `Checked by ${esc(cluster)} when the token exists.` };
      }
      const sim = sims[i];
      if (!sim.ok) {
        ok = false;
        return { cls: "no", state: `${esc(cluster)} would refuse it. ${esc(chain.refusalText(sim.refusal))}`, refusal: sim.refusal };
      }
      if (sim.payerAfter === null) known = false; else total += before - sim.payerAfter;
      if (i === poolAt && together) total += buyLamports + rents[0];
      return {
        cls: "",
        state: i === poolAt && together
          ? `Checked without its buy: ${esc(cluster)} would take it. The buy is checked once the rules exist, before it is sent.`
          : `Checked: ${esc(cluster)} would take it.`,
      };
    });
    const budget = toLamports(b.spends.budget), feeMoney = toLamports(b.spends.feeMoney);
    const needed = total + (first ? rents[1] : 0);
    return { checks, ok, known: ok && known, before, total, buy: buyLamports, budget, feeMoney, rentAndFees: total - buyLamports - budget - feeMoney, needed, enough: before >= needed };
  }

  function paintCost() {
    const c = flow.cost;
    el.cost.hidden = !c || !c.known;
    if (!c || !c.known) return;
    const rows = [["Rent and network fees", c.rentAndFees]];
    if (c.buy) rows.push(["First buy", c.buy]);
    if (c.budget) rows.push(["Agent's budget", c.budget]);
    if (c.feeMoney) rows.push(["Agent's network fees", c.feeMoney]);
    el.cost.innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${exact(v)} SOL</dd></div>`).join("")
      + `<div class="cost-total"><dt>Total</dt><dd>${exact(c.total)} SOL</dd></div>`
      + `<div><dt>${esc(short(flow.creator))} holds</dt><dd>${exact(c.before)} SOL</dd></div>`;
  }

  /* ---------------- Review ---------------- */

  function head(kicker, title) {
    el.kicker.textContent = kicker;
    el.title.textContent = title;
  }

  async function prepare() {
    const run = ++flow.run;
    const wallet = wallets && wallets.current();
    const creator = wallet ? wallet.address : flow.tryAddress;
    Object.assign(flow, { stage: "idle", creator: creator || "", params: null, built: null, cost: null, failedAt: 0, landed: 0, retry: false, steps: plannedSteps() });
    head("Review", "What you will sign.");
    el.done.hidden = true;
    el.tryForm.hidden = !!wallet || !!notReady;
    trouble("");
    uploadLine("");
    paintSteps();
    paintCost();
    buttons();
    if (notReady) return say(`${esc(notReady)} Nothing can be built or sent until then.`);
    if (!creator) {
      return say(wallets.list().some((w) => w.installed)
        ? "No wallet connected. Connect one to see what this costs and to sign."
        : "No wallet found in this browser. Install Phantom, Solflare or Backpack, or open this page inside your wallet's browser.");
    }

    // First the image and the details: the launch is built around the link they get.
    let uri = "";
    if (hosting.on) {
      // The same image and details as last time are already there: nothing is sent again.
      if (!(pinned && pinned.key === detailsKey())) {
        flow.stage = "uploading";
        buttons();
        say(state.file ? "Uploading the image and the token's details…" : "Uploading the token's details…", true);
      }
      try {
        const got = await pin();
        if (run !== flow.run) return;
        uri = got.uri;
        uploadLine(`${got.image ? "The image and the details are" : "The details are"} on IPFS: <a href="${esc(uri)}" target="_blank" rel="noopener">${esc(uri)}</a>`);
      } catch (error) {
        if (run !== flow.run) return;
        if (error.kind !== "not-configured" && error.kind !== "unavailable") {
          flow.stage = "idle";
          flow.retry = true;
          say(`<span class="no">Not uploaded.</span> ${esc(error.message)} Nothing was built or sent.`);
          return buttons();
        }
        // No uploads here after all: the form says so, and this launch keeps its words in the token.
        const picked = !!state.file;
        noHosting(error.kind);
        flow.steps = plannedSteps();
        paintSteps();
        uploadLine(`${esc(HOST_NOTES[error.kind])}${picked ? " The image you picked is not used." : ""}`);
      }
    }

    flow.stage = "building";
    buttons();
    say(`Building the transactions for ${addr(creator)}…`, true);
    try {
      const params = { ...launchParams(creator), ...(uri ? { uri } : {}) };
      const built = await chain.buildLaunch(params);
      if (run !== flow.run) return;
      Object.assign(flow, { params, built });
      flow.steps = built.transactions.map((entry) => ({ label: entry.label, text: stepWords(entry.label, built), meta: stepMeta(entry), cls: "", state: "" }));
      paintSteps();
      say(`Asking ${esc(cluster)} what it would answer…`, true);
      const cost = await measure(built, params);
      if (run !== flow.run) return;
      flow.cost = cost;
      cost.checks.forEach((check, i) => Object.assign(flow.steps[i], { cls: check.cls, state: check.state, checked: check }));
      flow.stage = "ready";
      if (cost.known) measured = { form: JSON.stringify(launchParams("")), rentAndFees: cost.rentAndFees, total: cost.total };
      paintSteps();
      paintCost();
      $("#cost").innerHTML = sideCost();
      const count = built.transactions.length;
      const token = `The token will live at ${mono(built.mint)}.`;
      if (!cost.ok) {
        say(`<span class="no">Not ready to sign.</span> ${esc(cluster)} would refuse a step, so nothing would be sent. ${wallet ? "" : "Nothing was signed or sent."}`);
      } else if (!cost.enough) {
        say(`<span class="no">Not enough SOL.</span> This launch needs ${exact(cost.needed)} SOL in the wallet and it holds ${exact(cost.before)}.`);
      } else if (!wallet) {
        say(`<span class="ok">Checked for ${addr(creator)}.</span> ${token} Nothing was signed or sent: connect that wallet to launch.`);
      } else {
        const asks = count === 1 ? "once" : typeof wallet.signAllTransactions === "function" ? `once, for all ${count} transactions` : `${count} times, once for each transaction`;
        say(`<span class="ok">Ready.</span> ${token} Your wallet will ask ${asks}.${count > 1 ? " It may say it cannot preview the later ones: they depend on the first." : ""}`);
      }
    } catch (error) {
      if (run !== flow.run) return;
      flow.stage = "idle";
      flow.cost = null;
      say(`<span class="no">Not built.</span> ${esc((error && error.message) || String(error))}`);
    }
    buttons();
  }

  function openReview() {
    lastFocus = document.activeElement;
    modal.hidden = false;
    el.tryInput.value = flow.tryAddress;
    card.focus();
    prepare();
  }

  // Some steps landed and the rest did not: the launch can still be finished, from this page only.
  const unfinished = () => flow.stage === "failed" && flow.landed > 0;

  function closeReview() {
    if (flow.stage === "sending") return;
    modal.hidden = true;
    if (!unfinished()) {
      flow.run++;
      flow.stage = "closed";
    }
    $("#launch-btn").textContent = unfinished() ? "Finish the launch" : "Review and launch";
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  /* ---------------- Signing and sending ---------------- */

  let stampTimer = 0;
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
  }

  async function sign() {
    const wallet = wallets.current();
    if (!wallet || (flow.stage !== "ready" && flow.stage !== "failed")) return;
    // Built for another wallet: build it again for this one, and let its owner read it first.
    if (wallet.address !== flow.creator) return flow.landed ? trouble("This launch was started from another wallet. Connect that one to finish it.") : prepare();

    const from = flow.stage === "failed" ? flow.failedAt : 0;
    const count = flow.steps.length;
    const thing = from ? { transactions: flow.built.transactions.slice(from) } : flow.built;
    flow.stage = "sending";
    trouble("");
    for (let i = from; i < count; i++) Object.assign(flow.steps[i], { cls: "", state: i === from ? "" : "Waits for the step before it." });
    paintSteps();
    buttons();

    let at = from;
    try {
      await chain.send(thing, wallet, {
        onStep: (step) => {
          at = from + step.index;
          const link = step.signature ? ` ${txLink(step.signature)}` : "";
          const n = `Step ${at + 1} of ${count}`;
          if (step.phase === "simulating") { setStep(at, "busy", `Asking ${esc(cluster)} what it would answer…`); say(`${n}: checking.`, true); }
          else if (step.phase === "signing") { setStep(at, "busy", "Waiting for your wallet…"); say("Waiting for your wallet…", true); }
          else if (step.phase === "sending") { setStep(at, "busy", "Sending…"); say(`${n}: sending.`, true); }
          else if (step.phase === "confirming") { setStep(at, "busy", `Sent. Waiting for ${esc(cluster)} to confirm.${link}`); say(`${n}: sent, waiting for ${esc(cluster)}.`, true); }
          else if (step.phase === "confirmed") { flow.landed = at + 1; setStep(at, "ok", `Landed.${link}`); say(`${n}: landed.`, true); }
        },
      });
      finish();
    } catch (error) {
      stopped(error, at, from);
    }
    buttons();
  }

  // A step did not go through. Says which, shows the program's reason, and claims nothing about the rest.
  function stopped(error, at, from) {
    const kind = error && error.kind, count = flow.steps.length;
    const message = esc((error && error.message) || String(error));
    if (kind === "rejected") {
      // Nothing is sent before the wallet has signed everything it was asked for.
      for (let i = from; i < count; i++) { const c = flow.steps[i].checked; Object.assign(flow.steps[i], { cls: c ? c.cls : "", state: c ? c.state : "" }); }
      flow.stage = flow.landed ? "failed" : "ready";
      paintSteps();
      return say(`You said no in the wallet. ${flow.landed ? "Nothing more was sent." : "Nothing was sent."}`);
    }
    flow.stage = "failed";
    flow.failedAt = at;
    const reached = error && error.landed && error.signature;
    setStep(at, "no", `${kind === "refused" ? "Refused." : "Did not go through."} ${message}${reached ? ` It reached ${esc(cluster)} and failed there: ${txLink(error.signature)}` : kind === "refused" ? " It was not sent." : ""}`);
    for (let i = at + 1; i < count; i++) setStep(i, "", "Not sent.");
    const before = flow.landed
      ? `The ${flow.landed === 1 ? "step" : `${flow.landed} steps`} before it landed and ${flow.landed === 1 ? "stays" : "stay"} on ${esc(cluster)}. Keep this page open to try the rest again: the new token's key lives only here.`
      : "Nothing landed.";
    say(`<span class="no">Step ${at + 1} of ${count}, “${esc(flow.steps[at].label)}”, did not go through.</span> ${before}`);
    if (kind === "refused") stamp(el.go);
  }

  function finish() {
    const b = flow.built;
    flow.stage = "done";
    head("Done", "Launched.");
    say(`<span class="ok">$${esc(b.symbol)} is on ${esc(cluster)}.</span> Its address is ${mono(b.mint)}.`);
    const keyFile = agentKey && agentKey.address === b.agent ? agentKey.file : "<its key file>";
    const run = b.leash
      ? `<p class="lp-note">To start the agent, on a machine that stays on and holds its key file:</p>`
        + `<pre class="rule-pre"><code>${NET.isDevnet ? "" : "RPC_URL=&lt;your RPC&gt; "}MINT=${esc(b.mint)} CREATOR=${esc(b.feePayer)} AGENT_KEYPAIR=${esc(keyFile)} node host-agent.mjs --send --every 60</code></pre>`
      : "";
    el.done.innerHTML = `<div class="cta-row"><a class="btn btn-primary" href="token.html?mint=${encodeURIComponent(b.mint)}">Open the token's page</a>`
      + (b.leash ? `<a class="btn btn-ghost" href="agent.html?leash=${encodeURIComponent(b.leash)}">Its agent's leash</a>` : "")
      + `</div>${run}`;
    el.done.hidden = false;
    el.cost.hidden = true;
    el.tryForm.hidden = true;
    if (agentKey && agentKey.downloaded) { dropKey(); paintKey(); }
    const link = el.done.querySelector("a");
    if (link) link.focus();
  }

  /* ---------------- Buttons and keys ---------------- */

  $("#launch-btn").addEventListener("click", () => {
    if (unfinished()) {
      // Back to the launch that is half done: its transactions are already built.
      lastFocus = document.activeElement;
      modal.hidden = false;
      return el.go.focus();
    }
    const bad = validate();
    if (bad.length) {
      bad[0].scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
      if (bad[0].focus) bad[0].focus({ preventScroll: true });
      toast(bad[0].id === "rules-problem" ? "These rules contradict each other." : `Fix ${bad.length} field${bad.length > 1 ? "s" : ""} first.`);
      return;
    }
    openReview();
  });

  el.go.addEventListener("click", async () => {
    if (flow.retry) return prepare();
    if (wallets.current()) return sign();
    // No wallet yet: connect the one there is. With several, the choice is made in the strip above.
    try {
      await wallets.connect();
    } catch (error) {
      if (error && error.kind === "choose-wallet") {
        closeReview();
        walletBtn.click();
        toast("Choose a wallet, then review again.");
      } else if (!error || error.kind !== "rejected") {
        trouble(esc((error && error.message) || String(error)));
      }
    }
  });
  el.close.addEventListener("click", closeReview);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeReview(); });

  el.tryForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = el.tryInput.value.trim();
    if (!isAddress(text)) { trouble("That is not a Solana address."); return el.tryInput.focus(); }
    flow.tryAddress = text;
    prepare();
  });

  document.addEventListener("keydown", (e) => {
    if (modal.hidden) return;
    if (e.key === "Escape") return closeReview();
    if (e.key !== "Tab") return;
    // The dialog keeps the keyboard while it is open.
    const items = [...card.querySelectorAll("a[href], button:not([disabled]), input:not([disabled])")].filter((node) => node.offsetParent !== null);
    if (!items.length) return e.preventDefault();
    const first = items[0], last = items[items.length - 1], here = document.activeElement;
    if (e.shiftKey && (here === first || !card.contains(here) || here === card)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (here === last || !card.contains(here))) { e.preventDefault(); first.focus(); }
  });

  // Leaving in the middle of a launch loses the new token's key: ask first.
  window.addEventListener("beforeunload", (e) => {
    if (flow.stage === "sending" || (flow.stage === "failed" && flow.landed)) { e.preventDefault(); e.returnValue = ""; }
  });

  if (wallets) {
    wallets.on(() => {
      $("#side-missing").textContent = sideMissing();
      // A review that is open follows the wallet, unless a launch is under way or half landed.
      if (!modal.hidden && (flow.stage === "idle" || flow.stage === "ready" || flow.stage === "uploading" || flow.stage === "building" || (flow.stage === "failed" && !flow.landed))) prepare();
      else if (!modal.hidden) buttons();
    });
  }

  paintImage();
  refresh();
  askHosting();
  if (!notReady) readCurves(true);
})();
