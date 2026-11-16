// Step 3, the "who looks at the photos" part. Three ways, same folder rules:
//   device  a small image model that runs on the phone (free; downloads once, then works offline)
//   claude  contact sheets of 30 previews sent to the Claude API with your own key (port of label_claude.py)
//   jev     TypeSafe's Jev image model, one question per file, your own key (port of label_jev.py)
// Each calls onResult(rec, value) as answers arrive, so the dashboard can fly photos into folders live.
import { claudeBatches, claudePrompt, parseLabelJson, sheetTag, softmaxPick } from "./core.js";
import { pool } from "./scan.js";
import { isNative, plugin } from "./platform.js";

export class FatalError extends Error {}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const toBase64 = b => new Promise((res, rej) => { const f = new FileReader(); f.onload = () => res(String(f.result).split(",")[1]); f.onerror = () => rej(f.error); f.readAsDataURL(b); });
const toBlob = (c, q) => new Promise(r => c.toBlob(r, "image/jpeg", q));
export { toBase64 };

// Native HTTP on the phone (no browser CORS limits); plain fetch when testing on a computer.
export async function httpJson(url, headers, body) {
  if (isNative()) {
    const r = await plugin("CapacitorHttp").request({ url, method: "POST", headers, data: body });
    let json = r.data;
    if (typeof json === "string") { try { json = JSON.parse(json); } catch { json = null; } }
    return { status: r.status, json };
  }
  const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
}

/* ---------- Claude ---------- */
async function makeSheet(chunk, getThumb) { // 6 x 5 previews, each tagged in yellow with its id (port of sheets.py)
  const C = 230, c = Object.assign(document.createElement("canvas"), { width: 6 * C, height: 5 * C }), x = c.getContext("2d");
  x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height);
  x.font = "bold 22px sans-serif"; x.textBaseline = "top";
  for (const [k, r] of chunk.entries()) {
    const px = (k % 6) * C, py = Math.floor(k / 6) * C, bmp = await createImageBitmap(await getThumb(r.id));
    x.drawImage(bmp, px + 4, py + 4, C - 8, C - 8); bmp.close?.();
    const tag = sheetTag(r);
    x.fillStyle = "#000"; x.fillRect(px + 4, py + 4, x.measureText(tag).width + 12, 28);
    x.fillStyle = "#ff0"; x.fillText(tag, px + 8, py + 7);
  }
  return toBase64(await toBlob(c, 0.82));
}
async function askClaude(sheets, prompt, key, model) {
  const content = [...sheets.map(data => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } })), { type: "text", text: prompt }];
  const { status, json } = await httpJson("https://api.anthropic.com/v1/messages", {
    "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true",
  }, { model, max_tokens: 4096, messages: [{ role: "user", content }] });
  const msg = json?.error?.message || `error ${status}`;
  if (status === 200) return (json.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  if ([400, 401, 403, 404].includes(status)) throw new FatalError(`Claude said no: ${msg}`);
  throw new Error(msg); // busy / rate limit / server trouble: the caller waits and asks again
}
export async function labelClaude({ recs, cats, getThumb, key, model, onResult, onProgress, onLog, workers = 4 }) {
  if (!key) throw new FatalError("Add your Claude API key in Settings first.");
  const batches = claudeBatches(recs), byId = new Map(recs.map(r => [String(r.id), r])), failed = [];
  let stop = false;
  onProgress(0, batches.length);
  await pool(batches, workers, async (batch, n) => {
    if (stop) return;
    const want = batch.flat().map(r => String(r.id)), sheets = [];
    for (const chunk of batch) sheets.push(await makeSheet(chunk, getThumb));
    const prompt = claudePrompt(cats, sheets.length);
    let why = "";
    for (let attempt = 0; attempt < 4 && !stop; attempt++) {
      if (attempt) await sleep(8000 * attempt);
      try {
        const text = await askClaude(sheets, prompt, key, model);
        const labels = parseLabelJson(text, want);
        if (Object.keys(labels).length >= 0.9 * want.length) { for (const [id, k] of Object.entries(labels)) onResult(byId.get(id), k); return; }
        why = text.replace(/\s+/g, " ").slice(0, 160) || "empty answer";
      } catch (e) { if (e instanceof FatalError) { stop = true; throw e; } why = e.message; }
      onLog(`batch ${n + 1}: try ${attempt + 1} gave no usable labels (${why}), retrying`);
    }
    failed.push(`batch ${n + 1} failed after 4 tries: ${why}`);
  }, onProgress);
  return failed;
}

/* ---------- Jev ---------- */
export async function labelJev({ recs, cats, getThumb, key, model = "jev-1.14.0", onResult, onProgress }) {
  if (!key) throw new FatalError("Add your Jev key in Settings first.");
  const crit = Object.fromEntries(["photo", "video"].map(k => [k, Object.fromEntries(cats.filter(c => c.kind === k).map(c => [c.key, c.rule]))]));
  let stop = false;
  const ask = async r => {
    if (stop) return;
    const bmp = await createImageBitmap(await getThumb(r.id)), c = Object.assign(document.createElement("canvas"), { width: 280, height: 280 });
    c.getContext("2d").drawImage(bmp, 0, 0, 280, 280); bmp.close?.();
    const body = {
      model, state: { item: "img", kind: r.kind === "video" ? "a frame from a video" : "a photo", file: r.name },
      assets: { img: { type: "image", format: "jpeg", data_base64: await toBase64(await toBlob(c, 0.85)) } },
      questions: { folder: { type: "choice", criteria: crit[r.kind], instructions: "Which camera-roll folder does `item` belong in?" } },
    };
    let err = "retries exhausted";
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const { status, json } = await httpJson("https://api.typesafe.ai/v1/systemone", {
          "content-type": "application/json", authorization: "Bearer " + key, "TypeSafe-Danger-Zone-Images": "true",
        }, body);
        if (status === 200 && json?.answers?.folder) { const a = json.answers.folder; return onResult(r, { key: a.choice, confidence: a.confidence, tokens: (json.usage?.input_tokens || 0) + (json.usage?.output_tokens || 0) }); }
        err = `${status} ${JSON.stringify(json?.error ?? json ?? "").slice(0, 200)}`;
        if (status === 401 || status === 403) { stop = true; throw new FatalError(`Jev rejected the key: ${err}`); }
        if (![429, 500, 502, 503, 504].includes(status)) break;
      } catch (e) { if (e instanceof FatalError) throw e; err = e.message; }
      await sleep(2 ** attempt * 2000);
    }
    onResult(r, { error: err });
  };
  await pool(recs, 6, ask, onProgress);
}

/* ---------- on the phone ---------- */
let clip;
async function loadClip(onStatus) {
  if (clip) return clip;
  try {
    const T = await import("../vendor/transformers.min.js");
    const { env } = T;
    env.allowLocalModels = false; env.useBrowserCache = true; // downloaded once from Hugging Face, then kept on the phone
    env.backends.onnx.wasm.wasmPaths = new URL("../vendor/", import.meta.url).href;
    env.backends.onnx.wasm.numThreads = 1;
    const id = "Xenova/clip-vit-base-patch32", files = new Map();
    const progress_callback = p => {
      if (p.status !== "progress") return;
      files.set(p.file, { loaded: p.loaded, total: p.total });
      const all = [...files.values()], total = all.reduce((s, f) => s + f.total, 0);
      onStatus({ download: total ? all.reduce((s, f) => s + f.loaded, 0) / total : 0 });
    };
    const opts = { device: "wasm", progress_callback };
    const [tokenizer, processor, text, vision] = await Promise.all([
      T.AutoTokenizer.from_pretrained(id), T.AutoProcessor.from_pretrained(id),
      T.CLIPTextModelWithProjection.from_pretrained(id, opts), T.CLIPVisionModelWithProjection.from_pretrained(id, opts),
    ]);
    clip = { T, tokenizer, processor, text, vision };
    return clip;
  } catch (e) {
    throw new FatalError(`The on-device model could not be loaded (${e.message || e}). It needs the internet once to download; after that it works offline. Or pick Claude or Jev in Settings.`);
  }
}
export async function labelDevice({ recs, cats, getThumb, onResult, onProgress, onStatus }) {
  const m = await loadClip(onStatus);
  onStatus({ ready: true });
  const prompts = cats.map(c => (c.kind === "video" ? "a frame from a video of " : "a photo of ") + c.rule);
  const { text_embeds } = await m.text(m.tokenizer(prompts, { padding: true, truncation: true }));
  const textVecs = text_embeds.normalize().tolist();
  const idx = { photo: [], video: [] };
  cats.forEach((c, i) => idx[c.kind].push(i));
  let n = 0;
  onProgress(0, recs.length);
  for (const r of recs) {
    try {
      const image = await m.T.RawImage.fromBlob(await getThumb(r.id));
      const { image_embeds } = await m.vision(await m.processor(image));
      const v = image_embeds.normalize().tolist()[0];
      const list = idx[r.kind], sims = list.map(i => textVecs[i].reduce((s, x, k) => s + x * v[k], 0));
      onResult(r, softmaxPick(sims, list.map(i => cats[i].key)).key);
    } catch { /* this file gets no label and lands in the catch-all folder */ }
    onProgress(++n, recs.length);
    if (n % 5 === 0) await sleep(0);
  }
}
