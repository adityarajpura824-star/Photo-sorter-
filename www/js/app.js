/* Photo Sorter for the phone. Plain JS, no build step.
   Screens: setup (one Sort button) -> running (live sort) -> done (results, replay).  ?demo opens the fake camera roll. */
import {
  DEFAULT_CATEGORIES, TOKENS_PER_FILE, SHEET_TOKENS, SHEET_SIZE, fmt, size, mmss, roughly, kindOf, validateCategories, uniqueKey, folderName, fallbackKey,
  catsFingerprint, findDuplicates, resolveLabels, planOutput, folderCounts, overallProgress, secondsLeft, sampleFiles,
} from "./core.js";
import * as store from "./store.js";
import { scanFile, pool, pixelsDiffer, peek } from "./scan.js";
import { labelDevice, labelClaude, labelJev, FatalError } from "./label.js";
import { saveAll, viewBase, moveFile, rewriteCsvs, cleanDest } from "./fsout.js";
import { makeDemo } from "./demo.js";
import { isNative } from "./platform.js";
import * as library from "./library.js";

const params = new URLSearchParams(location.search);
const $ = id => document.getElementById(id);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k.startsWith("aria-")) e.setAttribute(k, String(v));
    else if (k === "value") e.value = v;
    else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* lucide icons, inlined */
const ICONS = {
  images: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>', x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>', plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  left: '<path d="m15 18-6-6 6-6"/>', right: '<path d="m9 18 6-6-6-6"/>', down: '<path d="m6 9 6 6 6-6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>', clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  sparkles: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/>',
};
const svg = n => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`;
const icon = n => { const s = el("span", { "data-icon": n, style: "display:inline-flex" }); s.innerHTML = svg(n); return s; };
const paintIcons = (root = document) => root.querySelectorAll("[data-icon]").forEach(e => { if (!e.firstChild) e.innerHTML = svg(e.dataset.icon); });
function toast(t) { const e = $("toast"); e.textContent = t; e.classList.add("on"); clearTimeout(e.t); e.t = setTimeout(() => e.classList.remove("on"), 3600); }

/* ---------- settings, theme ---------- */
const settings = store.loadSettings();
const saveSet = () => store.saveSettings(settings);
function setTheme(t) {
  settings.theme = t; saveSet();
  document.documentElement.dataset.theme = t;
  $("theme").innerHTML = svg(t === "dark" ? "sun" : "moon");
  $("theme").setAttribute("aria-label", t === "dark" ? "Switch to light mode" : "Switch to dark mode");
}
setTheme(settings.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
$("theme").onclick = () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");

/* ---------- state ---------- */
let cats = [], catBy = {};
function setCats(c) { cats = c; catBy = Object.fromEntries(c.map(x => [x.key, x])); catBy._dupes = { key: "_dupes", label: "Duplicates", emoji: "🗂️", kind: "review" }; }
function loadCats() { try { return validateCategories(JSON.parse(localStorage.getItem("cats"))); } catch { return DEFAULT_CATEGORIES.map(c => ({ ...c })); } }
function saveCats(next) {
  const clean = next.map(({ key, kind, label, emoji, rule }) => ({ key, kind, label, emoji, rule }));
  try { validateCategories(clean); } catch (e) { toast(e.message); return false; }
  setCats(clean);
  try { localStorage.setItem("cats", JSON.stringify(clean)); } catch {}
  return true;
}
setCats(loadCats());

let lastLibrary = null;              // the finished sort saved by an earlier session
let mode = "loading";               // setup | running | done
let demo = false;
let items = [], byId = new Map(), labels = {}, dupes = [], dupeIds = new Set(), overrides = {};
let aiMap = {}, jevMap = {};
const files = new Map();            // id -> File, only while the app stays open
let thumbMem = new Map(), minis = new Map(); // demo previews live in memory; real ones in IndexedDB
let out = { base: null, rels: {}, view: null, failed: [] };
const pick = { files: [], sum: null, peek: [], advanced: false };
const job = { running: false, phases: [], phase: null, done: 0, total: 0, started: 0, phaseStarted: 0, note: "", error: null, log: [] };

const getThumb = async id => thumbMem.get(id) || (await store.get("thumbs", id));
const urls = new Map();
const blobUrl = (key, blob) => { if (!blob) return ""; if (!urls.has(key)) urls.set(key, URL.createObjectURL(blob)); return urls.get(key); };
const EMPTY = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
const miniUrl = it => blobUrl("m" + it.id, minis.get(it.id)) || EMPTY;
const thumbUrl = async it => blobUrl("t" + it.id, await getThumb(it.id)) || EMPTY;
const clearUrls = () => { urls.forEach(u => URL.revokeObjectURL(u)); urls.clear(); };

/* ---------- header ---------- */
function setPill(kind, text) { $("pill").querySelector(".dot").className = "dot" + (kind ? " " + kind : ""); $("pilltext").textContent = text ? text + (demo ? " · demo" : "") : ""; }

/* ---------- animation state ---------- */
const cards = new Map();            // folder key -> { el, badge, slots, queued, landed }
let tiles = [], run = "idle", order = [], released = 0, landed = 0, t0 = 0, rot = 0, finishing = false;
const queue = [], queued = new Set(), flown = new Set(), stats = { photos: 0, videos: 0, dupes: 0, saved: 0 };
const REPLAY_MS = (+params.get("d") || 12) * 1000;
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const ease = x => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

/* ---------- screens ---------- */
function renderApp() {
  document.body.dataset.mode = mode;
  const app = $("app");
  if (mode === "setup") { stopSphere(); app.replaceChildren(setupView()); }
  else app.replaceChildren(boardView());
  paintIcons(app);
  if (mode !== "setup") { buildCards(); renderPanel(); }
}

const kindFor = f => f.kind || kindOf(f.name, f.type); // gallery items already know their kind
function summary() {
  if (pick.sum) return pick.sum;
  const f = pick.files, photos = f.filter(x => kindFor(x) === "photo").length;
  return (pick.sum = { total: f.length, photos, videos: f.length - photos, bytes: f.reduce((s, x) => s + x.size, 0) });
}
const effectiveCount = () => (settings.sample ? Math.min(200, summary().total) : summary().total);

function setupView() {
  const box = el("div", { class: "setup rise" });
  const gallery = library.hasLibrary();
  box.append(el("div", {}, el("h1", {}, "Sort my camera roll"), el("p", { class: "sub" }, (gallery ? "Photo Sorter looks through every photo and video on your phone by itself. " : "Pick your photos and videos. ") + "Nothing is moved, renamed or deleted. Sorted copies are saved on your phone.")));
  if (!pick.files.length) {
    if (gallery) {
      box.append(el("button", { class: "btn solid big", onclick: sortGallery }, icon("play"), "Sort all my photos"));
      box.append(el("p", { class: "hint" }, `The first time, Android asks to let Photo Sorter see your photos and videos. Choose "Allow". ${labelerBlurb()}`));
    } else {
      box.append(el("button", { class: "btn solid big", onclick: () => $("picker").click() }, icon("images"), "Choose photos & videos"));
      box.append(el("p", { class: "hint" }, "Tip: in the picker, open a folder such as Camera and use Select all."));
    }
    if (lastLibrary) box.append(el("button", { class: "btn big", onclick: restoreLast }, icon("check"), `View last sort (${fmt(lastLibrary.recs.length)} files)`));
    if (gallery) box.append(el("div", { class: "row", style: "justify-content:center" }, el("button", { class: "linkish", onclick: () => $("picker").click() }, "Or choose photos myself")));
  } else {
    const s = summary();
    box.append(el("div", { class: "card picked" },
      el("div", {}, el("b", {}, `${fmt(s.photos)} photos · ${fmt(s.videos)} videos`), el("p", { class: "meta" }, `${size(s.bytes)} in total` + (settings.sample ? ` · trying ${fmt(effectiveCount())} random files first` : ""))),
      pick.peek.length ? el("div", { class: "strip" }, pick.peek.map(u => el("img", { src: u, alt: "" }))) : null,
      el("div", { class: "row" }, el("button", { class: "linkish", onclick: () => $("picker").click() }, "Change selection"))));
    box.append(el("button", { class: "btn solid big", onclick: startSorting }, icon("play"), "Start sorting"));
    box.append(el("p", { class: "meta", style: "text-align:center" }, `Keep this screen open while it sorts. ${labelerBlurb()}`));
  }
  box.append(el("button", { class: "adv-toggle", "aria-expanded": pick.advanced, onclick: () => { pick.advanced = !pick.advanced; renderApp(); } }, "Settings", icon("down")));
  if (pick.advanced) box.append(settingsBox());
  box.append(el("div", { class: "row", style: "justify-content:center" }, el("button", { class: "linkish", onclick: startDemo }, "Try the demo (drawn pictures, not your photos)")));
  return box;
}
const labelerBlurb = () => ({ device: "Sorted on this phone, free.", claude: "Claude will look at small previews (your API key, billed by Anthropic).", jev: "Jev will look at small previews (your Jev key, billed per file)." }[settings.labeler]);

function settingsBox() {
  const chips = kind => cats.filter(c => c.kind === kind).map(c => el("span", { class: "fchip" }, `${c.emoji || "📁"} ${c.label}`,
    el("button", { "aria-label": `Remove ${c.label}`, onclick: () => { if (saveCats(cats.filter(x => x !== c))) renderApp(); } }, icon("x"))));
  const adder = kind => {
    const holder = el("span", { class: "fchip add" });
    holder.append(el("button", { "aria-label": `Add a ${kind} folder`, onclick: () => {
      const name = el("input", { class: "field", placeholder: "Folder name", "aria-label": "Folder name" });
      const rule = el("input", { class: "field", placeholder: "What goes in it, in plain words", "aria-label": "What goes in it" });
      const add = () => {
        const label = name.value.trim(); if (!label) return name.focus();
        const at = cats.map(c => c.kind).lastIndexOf(kind); // keep the catch-all folder last
        const next = cats.slice(); next.splice(Math.max(0, at), 0, { key: uniqueKey(label, new Set(cats.map(c => c.key))), kind, label, emoji: kind === "photo" ? "📁" : "🎬", rule: rule.value.trim() || label });
        if (saveCats(next)) renderApp();
      };
      holder.replaceWith(el("span", { class: "newf" }, name, rule, el("div", { class: "row" }, el("button", { class: "btn small solid", onclick: add }, "Add"), el("button", { class: "btn small ghost", onclick: renderApp }, "Cancel"))));
      name.focus();
    } }, icon("plus")));
    return holder;
  };
  const opt = (k, title, text, extra, keys) => el("label", { class: "opt" + (settings.labeler === k ? " on" : "") },
    el("input", { type: "radio", name: "labeler", checked: settings.labeler === k, onchange: () => { settings.labeler = k; saveSet(); renderApp(); } }),
    el("span", {}, el("b", {}, title, extra || ""), el("small", {}, text), settings.labeler === k && keys ? el("span", { class: "keys" }, keys) : null));
  const keyField = (prop, ph, label) => el("input", { class: "field", type: "password", autocomplete: "off", placeholder: ph, "aria-label": label, value: settings[prop], oninput: e => { settings[prop] = e.target.value.trim(); saveSet(); } });
  const paid = el("span", { class: "paid" }, "PAID");
  return el("div", { class: "card rise" },
    el("h4", { style: "margin-top:0" }, "Photo folders"), el("div", { class: "fchips" }, chips("photo"), adder("photo")),
    el("h4", {}, "Video folders"), el("div", { class: "fchips" }, chips("video"), adder("video")),
    el("p", { class: "meta", style: "margin-top:8px" }, "The last folder of each kind catches everything that fits nowhere else."),
    el("div", { class: "row", style: "margin-top:8px" }, el("button", { class: "btn small", onclick: openFolders }, icon("pencil"), "Edit folders and rules")),
    el("h4", {}, "Who looks at the photos"),
    opt("device", "On this phone", "Free. Downloads a small image model once (roughly 150 MB), then works offline. Nothing leaves your phone.", null, null),
    opt("claude", "Claude ", "Smarter, uses your own Claude API key (separate from the Claude app plan). Sends small previews to Anthropic; originals never leave the phone.", paid, [
      keyField("claudeKey", "Claude API key (sk-ant-…)", "Claude API key"),
      el("input", { class: "field", value: settings.claudeModel, "aria-label": "Claude model", placeholder: "claude-sonnet-5-5", oninput: e => { settings.claudeModel = e.target.value.trim(); saveSet(); } }),
      el("small", {}, "The key stays on this phone."),
    ]),
    opt("jev", "Jev by TypeSafe ", "Fast image model, billed per file (about " + fmt(TOKENS_PER_FILE) + " tokens each). Sends a 280px preview of each file.", paid, [keyField("jevKey", "Jev key", "Jev key"), el("small", {}, "The key stays on this phone.")]),
    el("h4", {}, "More"),
    el("label", { class: "check-row" }, el("input", { type: "checkbox", checked: settings.sample, onchange: e => { settings.sample = e.target.checked; saveSet(); pick.sum = null; renderApp(); } }), "Try 200 random files first"),
    el("div", {}, el("label", { class: "meta", for: "dest" }, "Save sorted copies in Documents / …"),
      el("input", { id: "dest", class: "field", value: settings.dest, placeholder: "Photo Sorter", oninput: e => { settings.dest = e.target.value; saveSet(); } })));
}

function boardView() {
  const kpi = (id, title, sub = " ") => el("div", { class: "kpi" }, el("h3", {}, title), el("b", { id }, "0"), el("small", {}, sub));
  return el("div", { class: "rise" },
    el("div", { class: "stage", id: "stage" }, el("div", { class: "center" },
      el("div", { class: "check" }, icon("check")), el("div", { class: "big" }, el("span", { id: "bigN" }, "0"), " sorted"),
      el("div", { class: "sub" }, "into ", el("b", { id: "bigF" }, "0 folders")),
      el("div", { class: "chips" }, el("span", { class: "chip", id: "chipD" }), el("span", { class: "chip", id: "chipS" })))),
    el("div", { id: "panel" }),
    el("section", { class: "kpis" },
      kpi("k-checked", "Files checked"), kpi("k-photos", "Photos sorted"), kpi("k-videos", "Videos sorted"),
      el("div", { class: "kpi" }, el("h3", {}, "Folders made"), el("b", {}, el("span", { id: "k-folders" }, "0"), el("span", { class: "of" }, " / ", el("span", { id: "k-ftotal" }, "0"))), el("small", {}, " ")),
      kpi("k-dupes", "Duplicates", "to review"), kpi("k-saved", "Space to save", "if deleted")),
    el("div", { class: "progress" }, el("i", { id: "bar" })),
    el("div", { class: "sec" }, el("h3", {}, "Photos"), el("em", { id: "pcount" }, "0")), el("div", { class: "folders", id: "photos" }),
    el("div", { class: "sec" }, el("h3", {}, "Videos"), el("em", { id: "vcount" }, "0")), el("div", { class: "folders", id: "videos" }));
}

/* ---------- folder cards ---------- */
function card(c) {
  const wide = c.key === "_dupes";
  const badge = el("span", { class: "count" }, "0"), slots = Array.from({ length: wide ? 24 : 12 }, () => el("div", { class: "slot" }));
  const e = el("button", { class: "fcard" + (wide ? " wide" : ""), onclick: () => openFolder(c) },
    el("div", { class: "ch" }, el("span", {}, c.emoji || "📁"), el("span", { class: "name" }, c.label), badge), el("div", { class: "grid" }, slots));
  cards.set(c.key, { el: e, badge, slots, queued: 0, landed: [] });
  return e;
}
function buildCards() {
  cards.clear();
  $("photos").replaceChildren(...cats.filter(c => c.kind === "photo").map(card));
  $("videos").replaceChildren(...cats.filter(c => c.kind === "video").map(card), card(catBy._dupes));
  $("k-ftotal").textContent = cats.length;
  Object.assign(stats, { photos: 0, videos: 0, dupes: 0, saved: 0 });
  released = landed = 0; flown.clear();
}
const targetOf = it => cards.get(it.dupe ? "_dupes" : catBy[it.cat] ? it.cat : "_dupes");

/* ---------- sphere ---------- */
function buildSphere(srcs) { // srcs: functions that make an <img>; a phone draws at most 150 tiles
  $("sphere").replaceChildren(); tiles = [];
  const T = Math.min(srcs.length, 150), golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < T; i++) {
    const y = 1 - (i / Math.max(1, T - 1)) * 2, r = Math.sqrt(1 - y * y), th = golden * i, img = srcs[i]();
    $("sphere").append(img);
    tiles.push({ el: img, x: Math.cos(th) * r, y, z: Math.sin(th) * r, left: 0, sx: 0, sy: 0, s: 1, alive: true });
  }
}
function stopSphere() { $("sphere").replaceChildren(); tiles = []; }
const miniImg = it => { const img = el("img", { src: miniUrl(it), alt: "" }); return img; };
function sphereFromItems() {
  order = shuffle(items.map((_, i) => i));
  buildSphere(order.map(i => () => miniImg(items[i])));
  order.forEach((idx, k) => { if (tiles.length) { tiles[k % tiles.length].left++; items[idx].tile = tiles[k % tiles.length]; } });
}
function geom() {
  const st = $("stage"); if (!st) return { cx: innerWidth / 2, cy: innerHeight / 3, R: 90, on: false };
  const r = st.getBoundingClientRect();
  return { cx: r.left + r.width / 2, cy: r.top + r.height * (mode === "running" ? 0.5 : 0.45), R: Math.min(r.width, r.height) * 0.34, on: r.bottom > 0 && r.top < innerHeight };
}
function drawSphere(dt) {
  if (!tiles.length) return;
  rot += dt * 0.00035;
  const tilt = Math.sin(performance.now() / 4000) * 0.35, { cx, cy, R, on } = geom();
  const ca = Math.cos(rot), sa = Math.sin(rot), cb = Math.cos(tilt), sb = Math.sin(tilt);
  for (const t of tiles) {
    if (!t.alive) continue;
    const x = t.x * ca + t.z * sa; let z = -t.x * sa + t.z * ca;
    const y = t.y * cb - z * sb; z = t.y * sb + z * cb;
    const depth = (z + 1) / 2;
    t.s = 0.45 + depth * 0.75; t.sx = cx + x * R; t.sy = cy + y * R;
    t.el.style.transform = `translate3d(${(t.sx - 14).toFixed(1)}px,${(t.sy - 14).toFixed(1)}px,0) scale(${t.s.toFixed(3)})`;
    t.el.style.opacity = on ? (0.2 + depth * 0.8).toFixed(2) : 0;
    t.el.style.zIndex = Math.round(depth * 100);
  }
}

/* ---------- photos flying into folders ---------- */
function release(it) {
  if (flown.has(it.id)) return;
  const c = targetOf(it); if (!c) return;
  flown.add(it.id); released++;
  const slot = c.slots[c.queued++ % c.slots.length].getBoundingClientRect();
  const to = { left: slot.left, top: Math.min(Math.max(slot.top, 60), innerHeight - 24), width: slot.width || 24 }; // folders below the screen: drop toward the bottom edge
  const t = it.tile || { sx: geom().cx, sy: geom().cy, s: 1, left: 1, el: null };
  const s = 28 * (t.s || 1), img = miniImg(it);
  img.style.width = img.style.height = s + "px";
  $("fly").append(img);
  if (t.el && --t.left <= 0) { t.alive = false; t.el.style.opacity = 0; }
  const mx = (t.sx + to.left) / 2 + (Math.random() - 0.5) * 80, my = (t.sy + to.top) / 2 - 40 - Math.random() * 60;
  const a = img.animate([
    { transform: `translate3d(${t.sx - s / 2}px,${t.sy - s / 2}px,0) scale(1)` },
    { transform: `translate3d(${mx - s / 2}px,${my - s / 2}px,0) scale(1.2) rotate(${(Math.random() - 0.5) * 50}deg)`, offset: 0.45 },
    { transform: `translate3d(${to.left}px,${to.top}px,0) scale(${to.width / s})` },
  ], { duration: 650 + Math.random() * 400, easing: "cubic-bezier(.55,0,.25,1)" });
  a.onfinish = () => { img.remove(); land(it, c, true); };
}
function land(it, c, live) {
  c.landed.push(it);
  if (live) {
    const recent = c.landed.slice(-c.slots.length).reverse();
    c.slots.forEach((s, i) => { const w = recent[i]; if (w && s.dataset.id !== String(w.id)) { s.dataset.id = w.id; s.replaceChildren(miniImg(w)); } });
    c.badge.classList.remove("pop"); void c.badge.offsetWidth; c.badge.classList.add("pop");
    c.el.classList.add("hit"); clearTimeout(c.hitT); c.hitT = setTimeout(() => c.el.classList.remove("hit"), 260);
  }
  c.badge.textContent = fmt(c.landed.length); c.badge.classList.add("on");
  if (it.dupe) { stats.dupes++; stats.saved += it.bytes; } else if (it.kind === "video") stats.videos++; else stats.photos++;
  landed++;
  if (live && run === "replay" && landed === items.length) celebrate();
  if (live && run === "live" && finishing && landed >= items.length) celebrate();
}
function fillStatic() { // results without animation
  buildCards();
  tiles.forEach(t => { t.alive = false; t.el.style.opacity = 0; });
  items.forEach(it => { flown.add(it.id); released++; const c = targetOf(it); if (c) land(it, c, false); });
  for (const c of cards.values()) {
    const recent = c.landed.slice(-c.slots.length).reverse();
    c.slots.forEach((s, i) => s.replaceChildren(...(recent[i] ? [miniImg(recent[i])] : [])));
  }
}
function showDone(withConfetti) {
  document.body.classList.add("is-done");
  $("bigF").textContent = `${cats.length} folders`;
  $("chipD").textContent = `🗂️ ${fmt(stats.dupes)} duplicates`;
  $("chipS").textContent = `💾 ${size(stats.saved)} to free`;
  if (withConfetti) { countUp($("bigN"), items.length, 900); confetti(); } else $("bigN").textContent = fmt(items.length);
  setPill("live", "Sorted");
}
function celebrate() {
  run = "idle"; finishing = false; mode = "done"; document.body.dataset.mode = mode;
  renderPanel(); showDone(true); persist();
  if (out.failed.length) toast(`${fmt(out.failed.length)} files could not be copied. See "My files".`);
}
function replay() {
  document.body.classList.remove("is-done");
  buildCards(); sphereFromItems();
  run = "replay"; t0 = performance.now(); released = 0;
  setPill("busy", "Sorting every photo & video");
}
function countUp(e, to, ms) { const s = performance.now(); (function f(n) { const p = Math.min(1, (n - s) / ms); e.textContent = fmt(to * ease(p)); if (p < 1) requestAnimationFrame(f); })(s); }
function confetti() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const cv = $("confetti"), ctx = cv.getContext("2d"), dpr = devicePixelRatio || 1;
  cv.width = innerWidth * dpr; cv.height = innerHeight * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const css = getComputedStyle(document.documentElement), cols = ["--brand", "--green", "--accent", "--faint", "--ink"].map(v => css.getPropertyValue(v).trim());
  const { cx, cy } = geom(), s = performance.now();
  const ps = Array.from({ length: 160 }, () => ({ x: cx, y: cy - 40, vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 13 - 3, w: 5 + Math.random() * 5, h: 3 + Math.random() * 4, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3, c: cols[Math.floor(Math.random() * cols.length)] }));
  (function f(n) {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    const a = Math.max(0, 1 - (n - s) / 3200);
    ps.forEach(p => { p.vy += 0.32; p.vx *= 0.985; p.x += p.vx; p.y += p.vy; p.r += p.vr; ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.globalAlpha = a; ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore(); });
    if (a > 0) requestAnimationFrame(f);
  })(s);
}

/* ---------- KPIs and the frame loop ---------- */
function updateStats() {
  if (!$("k-checked")) return;
  const scanning = mode === "running" && job.phase === "scan";
  $("k-checked").textContent = fmt(scanning ? job.done : Math.max(released, mode === "running" ? items.length : 0));
  $("k-photos").textContent = fmt(stats.photos); $("k-videos").textContent = fmt(stats.videos);
  $("k-folders").textContent = [...cards.entries()].filter(([k, c]) => k !== "_dupes" && c.landed.length).length;
  $("k-dupes").textContent = fmt(stats.dupes); $("k-saved").textContent = size(stats.saved);
  $("pcount").textContent = fmt(stats.photos); $("vcount").textContent = fmt(stats.videos);
  const p = mode === "running" ? overallProgress(job.phases, job.phase, job.done, job.total) * 100 : items.length ? (landed / items.length) * 100 : 0;
  $("bar").style.width = p + "%";
}
let last = performance.now();
function tick(now) {
  const dt = now - last; last = now;
  drawSphere(dt);
  if (run === "replay") { const want = Math.min(items.length, Math.floor(items.length * ease(Math.min(1, (now - t0) / REPLAY_MS)))); while (released < want) release(items[order[released]]); }
  if (run === "live" && queue.length) { const n = Math.max(1, Math.ceil(queue.length / 45)); for (let i = 0; i < n && queue.length; i++) release(queue.shift()); }
  updateStats();
  requestAnimationFrame(tick);
}

/* ---------- the panel under the stage: run progress, or what to do next ---------- */
const NAMES = { scan: "Looking at every file", dupes: "Finding duplicates", apply: "Copying into folders" };
const phaseName = p => (p === "label" ? { device: "Sorting on this phone", claude: "Claude is sorting your photos", jev: "Jev is sorting your photos" }[settings.labeler] : NAMES[p]) || "Getting ready";
let shownPhase = null;
function renderPanel() {
  const panel = $("panel"); if (!panel) return;
  shownPhase = job.phase;
  if (mode === "running") return panel.replaceChildren(runCard());
  panel.replaceChildren(el("div", { class: "actions rise" },
    el("button", { class: "btn solid", onclick: replay }, icon("play"), "Replay"),
    el("button", { class: "btn", onclick: newSort }, icon("plus"), "New sort"),
    el("button", { class: "btn", onclick: () => whereDialog() }, icon("folder"), "My files"),
    el("button", { class: "btn", onclick: openFolders }, icon("pencil"), "Edit folders")));
  paintIcons(panel);
}
function runCard() {
  const failed = !!job.error;
  const steps = job.phases.map(p => {
    const idx = job.phases.indexOf(p), cur = job.phases.indexOf(job.phase);
    const st = job.phase === "done" || idx < cur ? "ok" : p === job.phase ? (failed ? "bad" : "now") : "";
    return el("li", { class: st }, st === "ok" ? icon("check") : el("i", {}), { scan: "Scan", dupes: "Duplicates", label: "Label", apply: "Folders" }[p]);
  });
  const c = el("div", { class: "card", id: "runcard" },
    el("div", { class: "run-h" }, el("b", { id: "runname" }, failed ? "Something went wrong" : phaseName(job.phase)), el("span", { class: "num", id: "timer" })),
    el("div", { class: "pbar" }, el("i", { id: "stepbar", style: `width:${failed ? 100 : job.total ? Math.round((job.done / job.total) * 100) : 0}%` })),
    el("ol", { class: "phases" }, steps),
    el("p", { class: "note", id: "runnote" }, failed ? job.error : job.note || "Keep this screen open while it sorts."),
    failed && job.log.length ? el("pre", { class: "log" }, job.log.slice(-8).join("\n")) : null,
    failed ? el("div", { class: "row", style: "margin-top:12px" }, el("button", { class: "btn small solid", onclick: startSorting }, "Try again"), el("button", { class: "btn small", onclick: newSort }, "Back")) : null);
  paintIcons(c);
  return c;
}
function paintRun() {
  if (mode !== "running" || !$("timer")) return;
  if (job.phase !== shownPhase) renderPanel(); // the step list changed
  const now = Date.now(), left = job.running ? secondsLeft((now - job.phaseStarted) / 1000, job.done, job.total) : null;
  $("timer").textContent = `${mmss((now - job.started) / 1000)}${job.running && left != null ? " · " + (left > 5 ? roughly(left) + " left in this step" : "almost done with this step") : ""}`;
  $("stepbar").style.width = (job.error ? 100 : job.total ? Math.round((job.done / job.total) * 100) : 0) + "%";
  $("runnote").textContent = job.error || job.note || "Keep this screen open while it sorts.";
  $("runname").textContent = job.error ? "Something went wrong" : phaseName(job.phase);
  setPill(job.error ? "bad" : "busy", job.error ? "Stopped" : phaseName(job.phase));
}
setInterval(paintRun, 500);

/* ---------- the sort itself ---------- */
let wake = null;
async function keepAwake(on) { try { if (on) wake = (await navigator.wakeLock?.request("screen")) || null; else { await wake?.release(); wake = null; } } catch { /* optional */ } }
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && job.running) keepAwake(true); });

async function confirmPaid(n, todo) {
  if (settings.labeler === "device") return true;
  const claude = settings.labeler === "claude";
  if (claude && !settings.claudeKey) { toast("Add your Claude API key in Settings first."); pick.advanced = true; renderApp(); return false; }
  if (!claude && !settings.jevKey) { toast("Add your Jev key in Settings first."); pick.advanced = true; renderApp(); return false; }
  const tokens = claude ? Math.ceil(n / SHEET_SIZE) * SHEET_TOKENS : n * TOKENS_PER_FILE;
  return new Promise(res => {
    const done = v => { closeAll(); res(v); };
    dialog(claude ? "Label with Claude" : "Label with Jev", [
      el("div", { class: "card" }, el("b", {}, `${fmt(n)} files, roughly ${fmt(tokens)} tokens (an estimate)`),
        el("p", { class: "meta", style: "margin-top:6px" }, `Sends small previews of your files to ${claude ? "Anthropic" : "TypeSafe"}, never the originals. It is billed to your ${claude ? "Anthropic" : "TypeSafe"} account, so check the price there first.`)),
      el("p", { class: "meta", style: "margin-top:10px" }, "Files labelled before are skipped, so you can stop and continue later."),
    ], [el("button", { class: "btn ghost", onclick: () => done(false) }, "Cancel"), el("button", { class: "btn solid", onclick: () => done(true) }, "Spend tokens")], () => res(false));
  });
}

async function clearLibrary() {
  files.clear(); thumbMem = new Map(); minis = new Map(); clearUrls();
  items = []; byId = new Map(); labels = {}; dupes = []; dupeIds = new Set(); overrides = {}; aiMap = {}; jevMap = {};
  queue.length = 0; queued.clear(); flown.clear();
  await Promise.all([store.clear("thumbs"), store.clear("minis"), store.put("kv", "overrides", {})]);
}
const phase = p => { job.phase = p; job.done = 0; job.total = 0; job.phaseStarted = Date.now(); };

// One tap: ask Android for access to the gallery (first time only), read the whole list, then sort it all.
function needAccess(text) {
  dialog("Photo Sorter needs to see your photos", [
    el("p", {}, text),
    el("p", { class: "meta", style: "margin-top:8px" }, `In Settings open Permissions, then Photos and videos (or Storage), and choose "Allow all". Then come back and press Sort again.`),
  ], [el("button", { class: "btn ghost", onclick: closeAll }, "Not now"), el("button", { class: "btn solid", onclick: () => { closeAll(); library.openSettings(); } }, "Open settings")]);
}
async function sortGallery() {
  if (job.running) return;
  setPill("busy", "Opening your gallery");
  try {
    if (!(await library.access())) { setPill(null, ""); return needAccess("Without access to your photos and videos there is nothing to sort."); }
    const found = await library.list(cleanDest(settings.dest), n => setPill("busy", `Reading your gallery · ${fmt(n)}`));
    if (!found.length) { setPill(null, ""); return needAccess("No photos or videos were found. If you chose to share only some photos, Photo Sorter can only see those."); }
    pick.files = found; pick.sum = null; pick.peek = await peek(found, 24);
  } catch (e) { setPill(null, ""); return toast(`Could not read your gallery: ${e.message || e}`); }
  setPill(null, "");
  await startSorting();
}

async function startSorting() {
  if (job.running) return;
  const chosen = settings.sample ? sampleFiles(pick.files, 200) : pick.files;
  if (!chosen.length) return toast("Choose your photos first.");
  if (!(await confirmPaid(chosen.length))) return;
  const previous = out.base === cleanDest(settings.dest) ? Object.values(out.rels) : []; // only copies this tool made last time get replaced
  demo = false;
  await clearLibrary();
  Object.assign(job, { running: true, phases: ["scan", "dupes", "label", "apply"], error: null, note: "", log: [], started: Date.now() });
  out = { base: null, rels: {}, view: null, failed: [] };
  mode = "running"; run = "live"; finishing = false;
  document.body.classList.remove("is-done");
  phase("scan"); renderApp(); setPill("busy", phaseName("scan"));
  buildSphere(pick.peek.length ? Array.from({ length: 60 }, (_, i) => () => el("img", { src: pick.peek[i % pick.peek.length], alt: "" })) : []);
  await keepAwake(true);
  try {
    // 1. scan
    const picked = chosen.slice().sort((a, b) => a.name.localeCompare(b.name) || a.lastModified - b.lastModified).filter(kindFor);
    const done = await pool(picked, 3, async (f, i) => {
      const r = await scanFile(f, i);
      files.set(i, f); minis.set(i, r.mini); await store.put("thumbs", i, r.thumb);
      return r.rec;
    }, (d, t) => { job.done = d; job.total = t; });
    items = done.map(r => ({ ...r, cat: null, dupe: false })); byId = new Map(items.map(it => [it.id, it]));
    buildCards(); sphereFromItems();
    // 2. duplicates
    phase("dupes");
    dupes = await findDuplicates(items, {
      pixelsDiffer: async (a, b) => pixelsDiffer(await getThumb(a), await getThumb(b)),
      onProgress: (d, t) => { job.done = d; job.total = t; }, yieldNow: () => sleep(0),
    });
    dupeIds = new Set(dupes.flatMap(g => g.dupes)); items.forEach(it => (it.dupe = dupeIds.has(it.id)));
    // 3. labels
    phase("label"); await runLabel();
    // 4. folders
    phase("apply"); await runApply(previous);
    job.phase = "done"; job.running = false;
    items.forEach(it => { it.cat = labels[it.id]; if (!flown.has(it.id) && !queued.has(it)) { queued.add(it); queue.push(it); } });
    finishing = true; setPill("busy", "Almost there");
    if (landed >= items.length) celebrate();
  } catch (e) {
    job.running = false; job.error = e instanceof FatalError || e.message ? e.message : String(e);
    setPill("bad", "Stopped"); renderPanel(); toast("Sorting stopped. See the details on screen.");
  } finally { keepAwake(false); }
}

async function runLabel() {
  const lab = settings.labeler, fp = catsFingerprint(cats), cacheKey = "labels-" + lab;
  const saved = await store.get("kv", cacheKey), known = saved && saved.fp === fp ? saved.map : {};
  aiMap = {}; jevMap = {};
  const live = (it, key) => { // the folder the photo flies to (a wrong-kind answer goes to the catch-all)
    it.cat = catBy[key] && catBy[key].kind === it.kind ? key : fallbackKey(cats, it.kind);
    if (!flown.has(it.id) && !queued.has(it)) { queued.add(it); queue.push(it); }
  };
  const take = (it, v) => { if (lab === "jev") { jevMap[it.id] = v; if (v.confidence >= 0.7) live(it, v.key); } else { aiMap[it.id] = v; live(it, v); } };
  const todo = [];
  for (const it of items) { const v = known[it.sha]; if (v == null || v.error) todo.push(it); else take(it, v); }
  let since = 0;
  const saveCache = () => store.put("kv", cacheKey, { fp, map: known });
  const onResult = (it, v) => { if (!v || v.error) return; known[it.sha] = v; take(it, v); if (++since >= 50) { since = 0; saveCache(); } };
  const common = { recs: todo, cats, getThumb, onResult, onProgress: (d, t) => { job.done = d; job.total = t; } };
  let failed = [];
  try {
    if (todo.length) {
      if (lab === "device") await labelDevice({ ...common, onStatus: s => { if (s.download != null) job.note = `Downloading the on-device model, one time only: ${Math.round(s.download * 100)}%`; if (s.ready) job.note = ""; } });
      else if (lab === "claude") failed = await labelClaude({ ...common, key: settings.claudeKey, model: settings.claudeModel || "claude-sonnet-5-5", onLog: l => job.log.push(l) });
      else await labelJev({ ...common, key: settings.jevKey });
    }
  } finally { await saveCache(); }
  const got = items.filter(it => (lab === "jev" ? jevMap[it.id]?.key : aiMap[it.id])).length;
  if (got < 0.95 * items.length) throw new Error(failed[0] || `Only ${fmt(got)} of ${fmt(items.length)} files could be labelled. Press Try again; the finished ones are kept.`);
  if (got < items.length) job.log.push("A few files could not be labelled; they go to the catch-all folders.");
}

async function runApply(previous) {
  const r = resolveLabels(items, cats, aiMap, jevMap, overrides);
  labels = r.labels; items.forEach(it => { it.cat = labels[it.id]; });
  const plan = planOutput(items, labels, cats, dupes);
  job.total = plan.length;
  if (isNative()) {
    const res = await saveAll({ dest: settings.dest, recs: items, plan, files, previous, onProgress: (d, t) => { job.done = d; job.total = t; } });
    out = { base: res.base, rels: Object.fromEntries(res.ok.map(p => [p.id, p.rel])), view: await viewBase(res.base).catch(() => null), failed: res.failed };
    if (res.failed.length && !res.ok.length) throw new Error(`Nothing could be saved to Documents/${res.base}. ${res.failed[0]}`);
  } else { out = { base: null, rels: {}, view: null, failed: [] }; job.log.push("Preview mode: copies are only saved by the Android app."); }
}

async function persist() {
  if (demo) return;
  const recs = items.map(({ id, name, ext, kind, bytes, sha, w, h, duration, taken, error, phash }) => ({ id, name, ext, kind, bytes, sha, w, h, duration, taken, error, phash }));
  await store.put("kv", "library", { recs, labels, dupes, out: { base: out.base, rels: out.rels, failed: out.failed }, savedAt: Date.now() });
  await store.put("kv", "overrides", overrides);
  await store.putMany("minis", [...minis]);
}
async function restoreLast() {
  const lib = lastLibrary; if (!lib) return;
  demo = false; clearUrls();
  items = lib.recs.map(r => ({ ...r, cat: lib.labels[r.id], dupe: false })); byId = new Map(items.map(it => [it.id, it]));
  labels = lib.labels; dupes = lib.dupes; dupeIds = new Set(dupes.flatMap(g => g.dupes)); items.forEach(it => (it.dupe = dupeIds.has(it.id)));
  overrides = (await store.get("kv", "overrides")) || {}; minis = await store.getAll("minis"); thumbMem = new Map(); files.clear();
  out = { base: lib.out.base, rels: lib.out.rels || {}, view: null, failed: lib.out.failed || [] };
  if (out.base && isNative()) out.view = await viewBase(out.base).catch(() => null);
  mode = "done"; renderApp(); sphereFromItems(); fillStatic(); showDone(false);
}

async function startDemo() {
  setPill("busy", "Drawing the demo");
  const lib = await makeDemo((d, t) => { $("pilltext").textContent = `Drawing the demo ${d}/${t}`; });
  demo = true; clearUrls(); files.clear();
  setCats(lib.cats); items = lib.recs.map(r => ({ ...r, cat: lib.labels[r.id], dupe: false })); byId = new Map(items.map(it => [it.id, it]));
  labels = lib.labels; dupes = lib.dupes; dupeIds = new Set(dupes.flatMap(g => g.dupes)); items.forEach(it => (it.dupe = dupeIds.has(it.id)));
  thumbMem = lib.thumbs; minis = lib.minis; overrides = {}; out = { base: null, rels: {}, view: null, failed: [] };
  mode = "done"; renderApp(); sphereFromItems(); fillStatic(); showDone(false); setPill("live", "Sorted");
  if (params.has("auto") || !params.has("demo")) setTimeout(replay, 600);
}
function newSort() {
  if (job.running) return;
  if (demo) { demo = false; setCats(loadCats()); }
  mode = "setup"; run = "idle"; document.body.classList.remove("is-done"); $("fly").replaceChildren();
  Object.assign(job, { error: null, phase: null }); pick.files = []; pick.sum = null; pick.peek = [];
  renderApp(); setPill(null, "");
}

/* ---------- dialogs: bottom sheets ---------- */
let lbKeys = () => {};
function closeAll() { $("overlay").replaceChildren(); document.removeEventListener("keydown", lbKeys); }
function dialog(title, body, foot, onClose) {
  closeAll();
  const close = () => { closeAll(); onClose?.(); };
  $("overlay").append(el("div", { class: "scrim", onclick: e => e.target === e.currentTarget && close() },
    el("div", { class: "sheet", role: "dialog", "aria-label": title },
      el("div", { class: "sheet-head" }, el("h2", {}, title), el("button", { class: "icon-btn", "aria-label": "Close", onclick: close }, icon("x"))),
      el("div", { class: "sheet-body" }, body), foot ? el("div", { class: "sheet-foot" }, foot) : null)));
  paintIcons($("overlay"));
  lbKeys = e => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", lbKeys);
}

function whereDialog(folder) {
  const base = out.base ? `Documents / ${out.base}` : null;
  dialog("Where are my files", [
    base ? el("div", { class: "card stack" },
      el("p", {}, "Open the ", el("b", {}, "Files"), " app on your phone and go to:"),
      el("p", { class: "mono" }, base + (folder ? ` / ${folder}` : "")),
      el("p", { class: "meta" }, "Your originals were not touched. Each folder holds copies, duplicates are in _Review / duplicates, and sorted.csv and duplicates.csv list everything."))
      : el("p", { class: "meta" }, demo ? "This is the demo, so nothing was saved." : "Nothing is saved yet. Sort first, then the copies appear in Documents on your phone."),
    out.failed.length ? el("div", { style: "margin-top:12px" }, el("h4", {}, `${fmt(out.failed.length)} files could not be copied`), el("pre", { class: "log" }, out.failed.slice(0, 20).join("\n"))) : null,
  ]);
}

function openFolders() { // edit the folders: names, emoji, rules, photo or video
  const draft = cats.map(c => ({ ...c })), list = el("div");
  const slugOf = s => uniqueKey(s, new Set(draft.map(d => d.key)));
  function row(c) {
    const seg = el("div", { class: "seg" }, ["photo", "video"].map(k => el("button", { "aria-pressed": c.kind === k, onclick: () => { c.kind = k; render(); } }, k === "photo" ? "Photos" : "Videos")));
    return el("div", { class: "frow" },
      el("input", { class: "field emoji", value: c.emoji || "📁", "aria-label": "Emoji", oninput: e => (c.emoji = e.target.value) }),
      el("input", { class: "field", value: c.label, placeholder: "Folder name", "aria-label": "Folder name", oninput: e => (c.label = e.target.value) }),
      el("button", { class: "icon-btn", "aria-label": `Delete ${c.label}`, onclick: () => { draft.splice(draft.indexOf(c), 1); render(); } }, icon("trash")),
      el("input", { class: "field rule", value: c.rule || "", placeholder: "What goes in here, in plain words", "aria-label": "Rule", oninput: e => (c.rule = e.target.value) }), seg);
  }
  function render() { list.replaceChildren(el("h4", { style: "margin-top:0" }, "Photo folders"), ...draft.filter(c => c.kind === "photo").map(row), el("h4", {}, "Video folders"), ...draft.filter(c => c.kind === "video").map(row)); paintIcons(list); }
  const add = kind => () => { draft.push({ key: "", kind, label: "", emoji: kind === "photo" ? "📁" : "🎬", rule: "" }); render(); };
  function saveIt() {
    for (const c of draft) { if (!c.label.trim()) return toast("Every folder needs a name."); c.label = c.label.trim(); c.rule = (c.rule || "").trim() || c.label; if (!c.key) c.key = slugOf(c.label); }
    if (!saveCats(draft)) return;
    closeAll(); if (mode === "setup") renderApp(); else { buildCards(); fillStatic(); showDone(false); }
    if (mode === "done") toast("Saved. Press New sort and sort again so files can use the new folders.");
  }
  render();
  dialog("Folders", [list, el("p", { class: "meta" }, "The rule is what the sorter reads, so describe each folder the way you'd explain it to a friend. Keep one photo and one video folder; the last of each kind catches everything else.")], [
    el("button", { class: "btn", onclick: add("photo") }, icon("plus"), "Photo folder"), el("button", { class: "btn", onclick: add("video") }, icon("plus"), "Video folder"),
    el("button", { class: "btn ghost", onclick: () => { draft.splice(0, draft.length, ...DEFAULT_CATEGORIES.map(c => ({ ...c }))); render(); } }, "Standard folders"),
    el("button", { class: "btn solid", onclick: saveIt }, "Save folders")]);
}

function openFolder(c) {
  if (mode === "running") return;
  const all = items.filter(i => (c.key === "_dupes" ? i.dupe : !i.dupe && i.cat === c.key));
  const grid = el("div", { class: "browse" });
  let shown = 0;
  const more = () => {
    grid.querySelector(".more")?.remove();
    const from = shown;
    all.slice(from, from + 90).forEach((it, k) => {
      const img = el("img", { alt: "", loading: "lazy", src: EMPTY });
      thumbUrl(it).then(u => (img.src = u));
      grid.append(el("button", { "aria-label": it.name, onclick: () => lightbox(all, from + k) }, img, it.kind === "video" ? el("span", { class: "vid" }, "▶ " + (it.duration ? Math.round(it.duration) + "s" : "video")) : null));
    });
    shown += 90;
    if (shown < all.length) grid.append(el("button", { class: "btn more", onclick: more }, `Show ${fmt(Math.min(90, all.length - shown))} more`));
  };
  more();
  dialog(`${c.emoji || "📁"} ${c.label} · ${fmt(all.length)}`, all.length ? grid : el("p", { class: "empty" }, "Nothing in this folder yet."),
    out.base ? [el("button", { class: "btn", onclick: () => whereDialog(c.key === "_dupes" ? "_Review / duplicates" : folderName(c.label)) }, icon("folder"), "Where is this folder?")] : null);
}

function viewUrl(it) { // the saved copy if there is one, else the picked file (this session), else the preview
  if (!demo && out.view && out.rels[it.id]) return out.view(out.rels[it.id]);
  const f = files.get(it.id); if (f && !demo && !f.native) return blobUrl("f" + it.id, f);
  return null;
}
function lightbox(list, i) {
  const it = list[i];
  const full = viewUrl(it), fallback = el("img", { alt: it.name, src: EMPTY });
  thumbUrl(it).then(u => { if (!fallback.dataset.keep) fallback.src = u; });
  let media = fallback;
  if (full && it.kind === "video") media = el("video", { src: full, controls: true, playsinline: true, autoplay: true });
  else if (full) { media = el("img", { alt: it.name, src: full }); media.onerror = () => { media.replaceWith(fallback); }; }
  const select = el("select", { class: "select", "aria-label": "Move to folder", onchange: async e => { await moveItem(it, e.target.value); closeLb(); } },
    cats.filter(c => c.kind === it.kind).map(c => el("option", { value: c.key, selected: !it.dupe && c.key === it.cat }, `${c.emoji || ""} ${c.label}`)));
  if (it.dupe) select.prepend(el("option", { value: "", selected: true, disabled: true }, "Duplicate (in review)"));
  const box = el("div", { class: "lightbox", role: "dialog", "aria-label": it.name },
    el("div", { class: "media" }, media),
    el("div", { class: "bar" }, el("b", {}, it.name),
      el("small", {}, `${size(it.bytes)}${it.taken ? " · " + new Date(it.taken * 1000).toLocaleDateString() : ""} · ${i + 1} of ${fmt(list.length)}`),
      el("div", { class: "row" }, el("small", {}, "Move to"), select)),
    el("button", { class: "nav prev", "aria-label": "Previous", onclick: () => i > 0 && lightbox(list, i - 1) }, icon("left")),
    el("button", { class: "nav next", "aria-label": "Next", onclick: () => i < list.length - 1 && lightbox(list, i + 1) }, icon("right")),
    el("button", { class: "icon-btn close", "aria-label": "Close", onclick: () => closeLb() }, icon("x")));
  const closeLb = () => { box.remove(); document.removeEventListener("keydown", keys); };
  const keys = e => { if (e.key === "ArrowLeft" && i > 0) { closeLb(); lightbox(list, i - 1); } if (e.key === "ArrowRight" && i < list.length - 1) { closeLb(); lightbox(list, i + 1); } if (e.key === "Escape") closeLb(); };
  let x0 = null;
  box.addEventListener("touchstart", e => (x0 = e.touches[0].clientX), { passive: true });
  box.addEventListener("touchend", e => { if (x0 == null) return; const dx = e.changedTouches[0].clientX - x0; x0 = null; if (dx > 60 && i > 0) { closeLb(); lightbox(list, i - 1); } else if (dx < -60 && i < list.length - 1) { closeLb(); lightbox(list, i + 1); } });
  document.querySelector(".lightbox")?.remove();
  document.addEventListener("keydown", keys);
  document.body.append(box);
  paintIcons(box);
}

// A hand move: the saved copy is renamed into the new folder right away and the CSV files are rewritten.
async function moveItem(it, key) {
  if (!key || !catBy[key]) return;
  overrides[it.id] = key; labels[it.id] = key; it.cat = key; it.dupe = false; dupeIds.delete(it.id);
  dupes = dupes.map(g => ({ ...g, dupes: g.dupes.filter(d => d !== it.id) })).filter(g => g.dupes.length);
  let failedMove = "";
  const old = out.rels[it.id];
  if (old && out.base && !demo) {
    try {
      const name = old.slice(old.lastIndexOf("/") + 1), folder = folderName(catBy[key].label), taken = new Set(Object.values(out.rels).map(r => r.toLowerCase()));
      let rel = `${folder}/${name}`;
      if (taken.has(rel.toLowerCase())) rel = `${folder}/${name.replace(/(\.[^.]*)?$/, `__${it.id}$1`)}`;
      await moveFile(out.base, old, rel); out.rels[it.id] = rel;
      const okItems = items.filter(r => out.rels[r.id]), dupeOf = new Map(dupes.flatMap(g => g.dupes.map(d => [d, g])));
      await rewriteCsvs(out.base, okItems, okItems.map(r => ({ id: r.id, rel: out.rels[r.id], folder: out.rels[r.id].slice(0, out.rels[r.id].lastIndexOf("/")), keep: dupeOf.get(r.id)?.keep ?? null, type: dupeOf.get(r.id)?.type ?? null })));
    } catch (e) { failedMove = `Moved in the app, but the saved copy could not be moved: ${e.message || e}`; }
  }
  toast(failedMove || `Moved to ${catBy[key].label}.${demo ? " (Demo: nothing is saved.)" : ""}`);
  fillStatic(); showDone(false); persist();
}

/* ---------- picking files ---------- */
$("picker").addEventListener("change", async e => {
  const f = [...e.target.files].filter(x => kindOf(x.name, x.type));
  e.target.value = "";
  if (!f.length) return toast("No photos or videos in that selection.");
  if (mode !== "setup") newSort();
  pick.files = f; pick.sum = null; pick.peek = [];
  renderApp(); setPill(null, "");
  peek(f, 24).then(p => { pick.peek = p; if (mode === "setup" && pick.files === f) renderApp(); });
});

/* ---------- start ---------- */
async function init() {
  paintIcons();
  lastLibrary = (await store.get("kv", "library")) || null;
  if (params.has("demo")) { mode = "done"; await startDemo(); }
  else { mode = "setup"; renderApp(); }
  requestAnimationFrame(tick);
}
init();
