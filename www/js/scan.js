// Step 1, on the phone: read each picked file (never changed), fingerprint it, make a 256px preview and a 72px copy
// for the animation, and a perceptual hash for finding look-alikes.
import { extOf, isScreenCapture, kindOf, phashFromGray } from "./core.js";
import * as library from "./library.js";

const PREVIEW = 256, MINI = 72;
const blob = (c, q) => new Promise(r => c.toBlob(r, "image/jpeg", q));
const canvas = s => Object.assign(document.createElement("canvas"), { width: s, height: s });

function square(src, w, h, s) { // centre-crop to a square, like the original's PIL crop
  const c = canvas(s), x = c.getContext("2d"), m = Math.min(w, h);
  x.imageSmoothingQuality = "high";
  x.drawImage(src, (w - m) / 2, (h - m) / 2, m, m, 0, 0, s, s);
  return c;
}
function grey(c, color) { const x = c.getContext("2d"); x.fillStyle = color; x.fillRect(0, 0, c.width, c.height); return c; }
function grayOf(c) { // 32x32 luminance (ITU-R 601, same as PIL "L") for the perceptual hash
  const s = canvas(32); s.getContext("2d").drawImage(c, 0, 0, 32, 32);
  const d = s.getContext("2d").getImageData(0, 0, 32, 32).data, g = new Array(1024);
  for (let i = 0; i < 1024; i++) g[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
  return g;
}

async function fingerprint(file) {
  // shortcut: files over 16 MB (videos) hash their size plus 3 x 4 MB samples (start, middle, end) instead of every byte; upgrade if exact-match of huge files ever matters
  const LIMIT = 16 << 20, CH = 4 << 20;
  const parts = file.size <= LIMIT ? [file] : [String(file.size), file.slice(0, CH), file.slice((file.size - CH) >> 1, ((file.size - CH) >> 1) + CH), file.slice(file.size - CH)];
  const buf = await new Blob(parts).arrayBuffer();
  if (!crypto.subtle) return `weak-${file.size}-${file.lastModified}-${file.name}`; // insecure page (desktop testing only)
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function photoPreview(file) {
  const bmp = await createImageBitmap(file); // applies the photo's rotation
  try { return { c: square(bmp, bmp.width, bmp.height, PREVIEW), w: bmp.width, h: bmp.height }; } finally { bmp.close?.(); }
}
async function nativePreview(file) { // the phone makes the preview (a video gives a frame), so even HEIC and huge files are cheap
  const bmp = await createImageBitmap(await library.thumb(file));
  try { return { c: square(bmp, bmp.width, bmp.height, PREVIEW), w: file.w || bmp.width, h: file.h || bmp.height, duration: file.kind === "video" ? file.duration : undefined }; } finally { bmp.close?.(); }
}
function videoPreview(file) {
  return new Promise((res, rej) => {
    const v = document.createElement("video"), url = URL.createObjectURL(file);
    v.muted = true; v.playsInline = true; v.preload = "metadata"; v.src = url;
    const end = (fn, a) => { clearTimeout(timer); URL.revokeObjectURL(url); v.removeAttribute("src"); v.load(); fn(a); };
    const timer = setTimeout(() => end(rej, new Error("video took too long to open")), 15000);
    v.onerror = () => end(rej, new Error("this phone cannot open this video"));
    v.onloadedmetadata = () => { v.currentTime = v.duration > 2 ? 1 : 0.01; };
    v.onseeked = () => { try { end(res, { c: square(v, v.videoWidth, v.videoHeight, PREVIEW), w: v.videoWidth, h: v.videoHeight, duration: isFinite(v.duration) ? v.duration : 0 }); } catch (e) { end(rej, e); } };
  });
}

// -> { rec, thumb: Blob, mini: Blob }. A file that cannot be read stays in the list, flagged, with a grey preview.
export async function scanFile(file, id) {
  const kind = file.kind || kindOf(file.name, file.type) || "photo";
  const rec = { id, name: file.name, ext: extOf(file.name) || (kind === "video" ? ".mp4" : ".jpg"), kind, bytes: file.size, taken: file.lastModified ? Math.round(file.lastModified / 1000) : null,
    screen: isScreenCapture(file.name, file.rel), ...(file.native ? { uri: file.uri, rel: file.rel } : {}) }; // screen: a screenshot or screen recording, by its name and folder
  try { rec.sha = file.native ? await library.sha(file) : await fingerprint(file); } catch { rec.sha = `unreadable-${id}`; }
  let c;
  try {
    const p = file.native ? await nativePreview(file) : kind === "video" ? await videoPreview(file) : await photoPreview(file);
    c = p.c; rec.w = p.w; rec.h = p.h; if (p.duration != null) rec.duration = p.duration;
    rec.phash = phashFromGray(grayOf(c));
  } catch (e) {
    rec.error = String(e.message || e).slice(0, 200);
    c = grey(canvas(PREVIEW), kind === "video" ? "#3c3c42" : "#e6e4de");
  }
  const m = canvas(MINI); m.getContext("2d").drawImage(c, 0, 0, MINI, MINI);
  return { rec, thumb: await blob(c, 0.8), mini: await blob(m, 0.72) };
}

// Runs fn over items, `n` at a time, calling onProgress(done, total) as they finish.
export async function pool(items, n, fn, onProgress = () => {}) {
  const out = new Array(items.length);
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); onProgress(++done, items.length); }
  }));
  return out;
}

// Decodes two stored previews and compares them: true when more than 0.4% of the pixels changed.
export async function pixelsDiffer(thumbA, thumbB) {
  const read = async b => { const bmp = await createImageBitmap(b), c = canvas(PREVIEW), x = c.getContext("2d"); x.drawImage(bmp, 0, 0, PREVIEW, PREVIEW); bmp.close?.(); return x.getImageData(0, 0, PREVIEW, PREVIEW).data; };
  const [a, b] = [await read(thumbA), await read(thumbB)];
  let changed = 0;
  for (let i = 0; i < a.length; i += 4) {
    const ga = a[i] * 0.299 + a[i + 1] * 0.587 + a[i + 2] * 0.114, gb = b[i] * 0.299 + b[i + 1] * 0.587 + b[i + 2] * 0.114;
    if (Math.abs(ga - gb) > 40) changed++;
  }
  return changed / (PREVIEW * PREVIEW) > 0.004;
}

// A handful of tiny random previews shown right after picking, like the original's "peek".
export async function peek(files, n = 12) {
  const pics = files.filter(f => (f.kind || kindOf(f.name, f.type)) === "photo").slice(0, 400).sort(() => Math.random() - 0.5).slice(0, n * 2);
  const out = [];
  for (const f of pics) {
    if (out.length >= n) break;
    try { const b = await createImageBitmap(f.native ? await library.thumb(f, 96) : f); const c = square(b, b.width, b.height, 64); b.close?.(); out.push(URL.createObjectURL(await blob(c, 0.7))); } catch {}
  }
  return out;
}
