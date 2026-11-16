// Pure logic (no DOM, no Capacitor). Ported from the Python scripts in kairothq/claude-photo-sorter
// (scan, dupes, apply, sheets, label_claude, label_jev) so it can be tested in Node.

export const IMG = new Set([".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".gif", ".bmp", ".tif", ".tiff"]);
export const VID = new Set([".mov", ".mp4", ".m4v", ".3gp", ".avi", ".mkv", ".webm"]);
export const TOKENS_PER_FILE = 980; // Jev: measured by the original project (~870 image + question + ~108 output)
export const SHEET_TOKENS = 2300; // Claude: estimate for one 1380x1150 contact sheet (~2,100 image tokens) plus its share of the prompt and answer
export const SHEET_SIZE = 30;
export const SHEETS_PER_BATCH = 3;

export const DEFAULT_CATEGORIES = [
  { key: "selfies", kind: "photo", label: "Selfies", emoji: "🤳", rule: "front-camera and mirror selfies of one person" },
  { key: "people", kind: "photo", label: "People & family", emoji: "👨‍👩‍👧", rule: "photos of other people, groups, family, friends, portraits taken by someone else" },
  { key: "pets", kind: "photo", label: "Pets & animals", emoji: "🐶", rule: "dogs, cats, any animal is the main subject" },
  { key: "food", kind: "photo", label: "Food & drinks", emoji: "🍜", rule: "meals, snacks, drinks, cafes, the food is the subject" },
  { key: "travel", kind: "photo", label: "Travel & nature", emoji: "🏔️", rule: "mountains, beaches, landscapes, monuments, trips, sky and sunsets" },
  { key: "city", kind: "photo", label: "City & nights out", emoji: "🌃", rule: "streets, buildings, malls, cars, concerts, events, night city" },
  { key: "home", kind: "photo", label: "Home & everyday", emoji: "🏠", rule: "rooms, desk setups, objects, shopping, products, anything everyday" },
  { key: "docs", kind: "photo", label: "Documents & receipts", emoji: "🧾", rule: "photos of paper (IDs, bills, notes, whiteboards) and screenshots of payments, bookings, tickets, orders" },
  { key: "memes", kind: "photo", label: "Memes & saved posts", emoji: "💡", rule: "screenshots of other people's posts, reels, tweets, articles, memes, ideas saved for later" },
  { key: "screenshots", kind: "photo", label: "Other screenshots", emoji: "📱", rule: "any other screenshot: chats, apps, settings, maps, emails" },
  { key: "vtalk", kind: "video", label: "Talking & selfie videos", emoji: "🎙️", rule: "a person talking to the camera, vlogs, selfie videos" },
  { key: "vtravel", kind: "video", label: "Travel clips", emoji: "🚗", rule: "trips, landscapes, roads, outdoor scenery" },
  { key: "vscreen", kind: "video", label: "Screen recordings", emoji: "🖥️", rule: "recordings of a phone or computer screen" },
  { key: "vclips", kind: "video", label: "Everyday clips", emoji: "🎬", rule: "every other video: friends, family, pets, food, events" },
];

/* ---------- small helpers ---------- */
export const fmt = n => Math.round(n).toLocaleString("en-IN");
export const size = b => (b >= 1e9 ? (b / 1e9).toFixed(1) + " GB" : Math.round(b / 1e6) + " MB");
export const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
export const roughly = s => (s < 50 ? "under a minute" : s < 90 ? "about a minute" : `about ${Math.round(s / 60)} min`);
export const extOf = name => { const i = name.lastIndexOf("."); return i < 0 ? "" : name.slice(i).toLowerCase(); };
export function kindOf(name, mime = "") {
  const e = extOf(name);
  if (VID.has(e) || mime.startsWith("video/")) return "video";
  if (IMG.has(e) || mime.startsWith("image/")) return "photo";
  return null;
}

/* ---------- folders (categories) ---------- */
export function validateCategories(cats) {
  const keys = cats.map(c => c.key);
  if (new Set(keys).size !== keys.length) throw new Error("Two folders have the same key.");
  if (!cats.every(c => c.label && c.label.trim() && (c.kind === "photo" || c.kind === "video"))) throw new Error("Every folder needs a name.");
  if (!cats.some(c => c.kind === "photo") || !cats.some(c => c.kind === "video")) throw new Error("Keep at least one photo folder and one video folder.");
  return cats;
}
export const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "folder";
export function uniqueKey(label, taken) {
  let k = slug(label), i = 2;
  while (taken.has(k)) k = slug(label) + "-" + i++;
  return k;
}
export const folderName = label => label.replace(/&/g, "and").replace(/[\/\\]/g, "-");
export const fallbackKey = (cats, kind) => cats.filter(c => c.kind === kind).at(-1).key; // last folder of a kind is its catch-all
export function catsFingerprint(cats) { // labels are only reusable while the folders (and their rules) are unchanged
  const s = JSON.stringify(cats.map(c => [c.key, c.kind, c.label, c.rule]));
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}

/* ---------- perceptual hash (same recipe as imagehash.phash: 32x32 grey, DCT, top-left 8x8, median) ---------- */
const N = 32, LOW = 8;
const COS = Array.from({ length: LOW }, (_, u) => Float64Array.from({ length: N }, (_, x) => Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N))));
export function phashFromGray(g) { // g: N*N luminance values, row-major
  const low = [];
  for (let u = 0; u < LOW; u++) for (let v = 0; v < LOW; v++) {
    let s = 0;
    for (let y = 0; y < N; y++) {
      let row = 0;
      for (let x = 0; x < N; x++) row += g[y * N + x] * COS[v][x];
      s += row * COS[u][y];
    }
    low.push(s);
  }
  const sorted = [...low].sort((a, b) => a - b);
  const med = (sorted[31] + sorted[32]) / 2;
  let hi = 0, lo = 0;
  low.forEach((val, i) => { const bit = val > med ? 1 : 0; if (i < 32) hi = ((hi << 1) | bit) >>> 0; else lo = ((lo << 1) | bit) >>> 0; });
  return { hi, lo };
}
const pop = x => {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
};
export const hamming = (a, b) => pop((a.hi ^ b.hi) >>> 0) + pop((a.lo ^ b.lo) >>> 0);

/* ---------- duplicates ----------
   Exact = same fingerprint. Near = perceptual hash distance <= 4 (bursts, re-saved screenshots, resized copies).
   For two different PNGs the preview pixels must also be almost identical (pixelsDiffer), because screenshots
   of the same app look alike to a perceptual hash. The biggest file of each group is kept. */
export async function findDuplicates(recs, { pixelsDiffer = async () => false, onProgress = () => {}, yieldNow = async () => {} } = {}) {
  const parent = new Map(recs.map(r => [r.id, r.id]));
  const find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => parent.set(find(b), find(a));
  const bySha = new Map();
  for (const r of recs) { if (!bySha.has(r.sha)) bySha.set(r.sha, []); bySha.get(r.sha).push(r.id); }
  for (const ids of bySha.values()) for (const x of ids.slice(1)) union(ids[0], x);

  const hashed = recs.filter(r => r.phash && !r.error);
  for (let i = 0; i < hashed.length; i++) {
    if (i % 50 === 0) { onProgress(i, hashed.length); await yieldNow(); }
    const a = hashed[i];
    for (let j = i + 1; j < hashed.length; j++) {
      const b = hashed[j];
      if (a.kind !== b.kind || hamming(a.phash, b.phash) > 4) continue;
      if (a.ext === ".png" && b.ext === ".png" && a.sha !== b.sha && (await pixelsDiffer(a.id, b.id))) continue;
      union(a.id, b.id);
    }
  }
  onProgress(hashed.length, hashed.length);

  const groups = new Map();
  for (const r of recs) { const k = find(r.id); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  const out = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => b.bytes - a.bytes || a.name.length - b.name.length);
    out.push({
      keep: g[0].id, dupes: g.slice(1).map(r => r.id),
      type: new Set(g.map(r => r.sha)).size === 1 ? "exact" : "near",
      freed: g.slice(1).reduce((s, r) => s + r.bytes, 0),
    });
  }
  return out;
}

/* ---------- labels ---------- */
// ai: {id: key} from Claude or the on-device model. jev: {id: {key, confidence}}. overrides: {id: key} made by hand.
export function resolveLabels(recs, cats, ai = {}, jev = {}, overrides = {}) {
  const byKey = Object.fromEntries(cats.map(c => [c.key, c]));
  const labels = {};
  let fixed = 0, missing = 0;
  for (const r of recs) {
    const k = String(r.id), j = jev[k] || {};
    let pick = (j.confidence || 0) >= 0.7 || !(k in ai) ? j.key : ai[k];
    pick = pick || ai[k];
    if (pick == null) missing++;
    if (!(pick in byKey) || byKey[pick].kind !== r.kind) { // photos only in photo folders, videos only in video folders
      if (pick != null) fixed++;
      pick = fallbackKey(cats, r.kind);
    }
    labels[k] = pick;
  }
  for (const [k, v] of Object.entries(overrides)) if (k in labels && v in byKey) labels[k] = v;
  return { labels, fixed, missing };
}

/* ---------- output plan, CSV ---------- */
const safeName = n => n.replace(/[\/\\]/g, "_");
export function planOutput(recs, labels, cats, dupes) {
  const byKey = Object.fromEntries(cats.map(c => [c.key, c]));
  const dupeOf = new Map();
  for (const g of dupes) for (const d of g.dupes) dupeOf.set(d, g);
  const used = new Set(), plan = [];
  for (const r of recs) {
    const g = dupeOf.get(r.id);
    const folder = g ? "_Review/duplicates" : folderName(byKey[labels[r.id]].label);
    let name = safeName(r.name), rel = `${folder}/${name}`;
    if (used.has(rel.toLowerCase())) { // same name from another folder or year
      const i = name.lastIndexOf(".");
      name = i < 0 ? `${name}__${r.id}` : `${name.slice(0, i)}__${r.id}${name.slice(i)}`;
      rel = `${folder}/${name}`;
    }
    used.add(rel.toLowerCase());
    plan.push({ id: r.id, folder, rel, keep: g ? g.keep : null, type: g ? g.type : null });
  }
  return plan;
}
export const csvCell = v => (/[",\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
export const csv = rows => rows.map(r => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
export function buildCsvs(recs, plan) {
  const byId = new Map(recs.map(r => [r.id, r]));
  const sorted = [["file", "folder", "original_name"]], dupes = [["duplicate", "kept_copy", "type"]];
  for (const p of plan) {
    const r = byId.get(p.id);
    sorted.push([p.rel, p.folder, r.name]);
    if (p.keep != null) dupes.push([r.name, byId.get(p.keep).name, p.type]);
  }
  return { sortedCsv: csv(sorted), duplicatesCsv: csv(dupes) };
}
export function folderCounts(recs, labels, dupes) {
  const dupeIds = new Set(dupes.flatMap(g => g.dupes)), counts = { _dupes: dupeIds.size };
  for (const r of recs) if (!dupeIds.has(r.id)) counts[labels[r.id]] = (counts[labels[r.id]] || 0) + 1;
  return counts;
}

/* ---------- Claude: contact sheets and answers ---------- */
export const sheetTag = r => String(r.id) + (r.kind === "video" ? ` VIDEO ${Math.round(r.duration || 0)}s` : r.ext === ".png" ? " PNG" : "");
export const sheetChunks = recs => Array.from({ length: Math.ceil(recs.length / SHEET_SIZE) }, (_, i) => recs.slice(i * SHEET_SIZE, (i + 1) * SHEET_SIZE));
export function claudeBatches(recs) { // 3 sheets (about 90 files) per request, same grouping as label_claude.py
  const sheets = sheetChunks(recs), out = [];
  for (let i = 0; i < sheets.length; i += SHEETS_PER_BATCH) out.push(sheets.slice(i, i + SHEETS_PER_BATCH));
  return out;
}
export function claudePrompt(cats, nSheets) {
  const folders = cats.map(c => `- ${c.key} (${c.kind}): ${c.rule}`).join("\n");
  return (
    "You sort a camera roll into folders. These are the folders, as key (kind): what goes in it\n" + folders + "\n\n" +
    `Look at each of the ${nSheets} contact sheet images above, in order. Each sheet shows up to 30 square previews, each tagged in yellow with a number (its id). ` +
    "A tag with VIDEO is a video and must get a (video) folder. Every other tile is a photo and must get a (photo) folder. PNG usually means a screenshot. " +
    "Give every id you see exactly one folder key from the list.\n\n" +
    'Reply with only a JSON object mapping id to folder key, like {"12": "food", "13": "selfies"}. No other text.'
  );
}
export function parseLabelJson(text, want) { // want: array of id strings; returns only ids we asked about
  const m = /\{[^{}]*\}/s.exec(text || "");
  if (!m) return {};
  try {
    const ok = new Set(want.map(String)), out = {};
    for (const [k, v] of Object.entries(JSON.parse(m[0]))) if (ok.has(String(k)) && typeof v === "string") out[String(k)] = v;
    return out;
  } catch { return {}; }
}

/* ---------- on-device model: pick the best folder from image/text similarity ---------- */
export function softmaxPick(sims, keys, scale = 100) {
  const mx = Math.max(...sims), e = sims.map(s => Math.exp((s - mx) * scale)), sum = e.reduce((a, b) => a + b, 0);
  const i = e.indexOf(Math.max(...e));
  return { key: keys[i], confidence: e[i] / sum };
}

/* ---------- sampling and progress ---------- */
export function sampleFiles(items, n, seed = 0) { // same random picks every time for the same seed, returned in original order
  if (!n || n >= items.length) return items;
  let a = (seed + 0x6d2b79f5) >>> 0;
  const rnd = () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const idx = items.map((_, i) => i);
  for (let i = 0; i < n; i++) { const j = i + Math.floor(rnd() * (idx.length - i)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  return idx.slice(0, n).sort((x, y) => x - y).map(i => items[i]);
}
const WEIGHT = { scan: 0.3, dupes: 0.05, label: 0.45, apply: 0.2 };
export function overallProgress(phases, phase, done, total) {
  if (phase === "done") return 1;
  const sum = phases.reduce((s, p) => s + WEIGHT[p], 0);
  let acc = 0;
  for (const p of phases) { if (p === phase) { acc += WEIGHT[p] * (total ? done / total : 0); break; } acc += WEIGHT[p]; }
  return Math.min(1, acc / sum);
}
export function secondsLeft(spent, done, total) { // measured, not guessed: only after 10% of the step is done
  const f = total ? done / total : 0;
  return f < 0.1 ? null : Math.max(0, spent / f - spent);
}
