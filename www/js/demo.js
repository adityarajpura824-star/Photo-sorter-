// A fake camera roll of drawn shapes (not real photos) so the app can be seen without picking anything. Port of demo.py.
import { DEFAULT_CATEGORIES } from "./core.js";

const WEIGHTS = { selfies: 110, people: 95, pets: 40, food: 60, travel: 85, city: 70, home: 120, docs: 55, memes: 150, screenshots: 140, vtalk: 45, vtravel: 25, vscreen: 12, vclips: 50 };
const scale = 0.4; // fewer than the original so it opens quickly on a phone
const blob = (c, q) => new Promise(r => c.toBlob(r, "image/jpeg", q));

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export async function makeDemo(onProgress = () => {}) {
  const rnd = rng(7), r = (a, b) => a + Math.floor(rnd() * (b - a + 1)), pick = a => a[Math.floor(rnd() * a.length)];
  const jit = (c, n = 26) => `rgb(${c.map(v => Math.max(0, Math.min(255, v + r(-n, n)))).join(",")})`;
  const cats = DEFAULT_CATEGORIES.map(c => ({ ...c })), recs = [], labels = {}, thumbs = new Map(), minis = new Map();
  const total = cats.reduce((s, c) => s + Math.round((WEIGHTS[c.key] || 40) * scale), 0);
  let id = 0;

  function draw(key, S = 256) {
    const c = Object.assign(document.createElement("canvas"), { width: S, height: S }), d = c.getContext("2d");
    const rect = (x, y, w, h, f) => { d.fillStyle = f; d.fillRect(x, y, w, h); };
    const ell = (x, y, w, h, f) => { d.fillStyle = f; d.beginPath(); d.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, 7); d.fill(); };
    const poly = (pts, f) => { d.fillStyle = f; d.beginPath(); pts.forEach(([x, y], i) => (i ? d.lineTo(x, y) : d.moveTo(x, y))); d.fill(); };
    if (["screenshots", "memes", "docs", "vscreen"].includes(key)) {
      const dark = rnd() < 0.5 && key !== "docs";
      rect(0, 0, S, S, dark ? "rgb(24,24,28)" : "rgb(246,246,248)");
      let ink = dark ? "rgb(70,70,80)" : "rgb(205,205,212)", y = 26;
      if (key === "memes") { rect(18, 22, S - 36, 128, jit([200, 120, 90], 60)); y = 170; }
      if (key === "docs") { rect(26, 18, S - 52, S - 28, "rgb(252,250,244)"); ink = "rgb(180,172,160)"; y = 44; }
      while (y < S - 20) { rect(30, y, r(70, 190), 10, ink); y += r(18, 30); }
      if (key === "screenshots" && rnd() < 0.5) rect(30, S - 60, S - 60, 30, "rgb(52,120,246)");
    } else if (key === "travel" || key === "vtravel") {
      rect(0, 0, S, S, jit(pick([[150, 190, 230], [250, 170, 120], [200, 215, 235]]), 15));
      for (let k = 0; k < 3; k++) { const x = r(-60, 120); poly([[x, S], [x + r(80, 140), r(70, 140)], [x + r(220, 300), S]], jit([90 - k * 20, 110 - k * 20, 130 - k * 15], 15)); }
    } else if (key === "city") {
      rect(0, 0, S, S, jit([22, 26, 48], 10));
      for (let x = 0; x < S;) { const w = r(28, 60), h = r(80, 210); rect(x, S - h, w, h, jit([40, 44, 70], 12)); for (let wy = S - h + 10; wy < S - 8; wy += 16) for (let wx = x + 6; wx < x + w - 6; wx += 12) if (rnd() < 0.45) rect(wx, wy, 5, 7, "rgb(250,214,120)"); x += w + 4; }
    } else if (key === "food") {
      rect(0, 0, S, S, jit([180, 130, 90], 30)); ell(30, 30, S - 60, S - 60, "rgb(245,245,240)");
      for (let k = 0; k < 7; k++) { const cx = r(80, 176), cy = r(80, 176), rr = r(14, 30); ell(cx - rr, cy - rr, rr * 2, rr * 2, jit(pick([[200, 80, 50], [90, 150, 70], [230, 180, 60]]), 25)); }
    } else if (key === "pets") {
      rect(0, 0, S, S, jit([150, 190, 140], 30)); const fur = jit(pick([[190, 140, 90], [60, 50, 45], [230, 220, 200]]), 20);
      ell(60, 90, 136, 140, fur); poly([[70, 120], [80, 50], [118, 100]], fur); poly([[186, 120], [176, 50], [138, 100]], fur);
      for (const ex of [102, 154]) ell(ex - 8, 140, 16, 16, "rgb(25,25,25)");
    } else {
      rect(0, 0, S, S, jit(pick([[225, 215, 200], [190, 205, 225], [160, 160, 175], [235, 200, 190]]), 20));
      if (key === "home") { rect(0, 170, S, 86, jit([150, 120, 95], 20)); rect(r(20, 60), 60, 100, 90, jit([70, 90, 120], 30)); rect(r(150, 190), 120, 60, 55, jit([200, 190, 170], 20)); }
      else {
        const n = key === "selfies" || key === "vtalk" ? 1 : r(2, 4);
        for (let k = 0; k < n; k++) {
          const cx = n === 1 ? S / 2 : 40 + k * (176 / Math.max(1, n - 1)), sc = n === 1 ? 1 : 0.6;
          ell(cx - 90 * sc, S - 70 * sc, 180 * sc, 190 * sc, jit([r(40, 220), r(40, 200), r(40, 220)], 0));
          ell(cx - 45 * sc, S - 190 * sc, 90 * sc, 110 * sc, jit(pick([[235, 200, 170], [200, 150, 110], [150, 105, 75]]), 12));
        }
      }
    }
    return c;
  }

  for (const c of cats) {
    for (let k = 0; k < Math.round((WEIGHTS[c.key] || 40) * scale); k++) {
      const cv = draw(c.key), m = Object.assign(document.createElement("canvas"), { width: 72, height: 72 });
      m.getContext("2d").drawImage(cv, 0, 0, 72, 72);
      thumbs.set(id, await blob(cv, 0.78)); minis.set(id, await blob(m, 0.72));
      const video = c.kind === "video";
      recs.push({ id, name: `IMG_${4000 + id}.${video ? "MOV" : "JPG"}`, kind: c.kind, ext: video ? ".mov" : ".jpg", bytes: video ? r(20, 90) * 1e6 : r(18, 60) * 1e5, duration: video ? r(4, 40) : undefined, taken: 1700000000 + id * 86400 });
      labels[id] = c.key;
      onProgress(++id, total);
    }
  }
  const dupes = [], seen = new Set();
  for (let n = 0; n < 15; n++) { // pretend a few are burst shots
    const k = r(1, recs.length - 1);
    if (recs[k].kind === "photo" && recs[k - 1].kind === "photo" && !seen.has(k) && !seen.has(k - 1)) { seen.add(k); seen.add(k - 1); dupes.push({ keep: k - 1, dupes: [k], type: "near", freed: recs[k].bytes * 6 }); }
  }
  return { cats, recs, labels, dupes, thumbs, minis };
}
