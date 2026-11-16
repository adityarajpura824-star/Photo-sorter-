// Step 4, on the phone: copy every file into its folder under Documents/<name>/, duplicates into _Review/duplicates,
// and write sorted.csv + duplicates.csv. Originals are only read. Needs the Android app (Capacitor Filesystem plugin).
import { buildCsvs } from "./core.js";
import { toBase64 } from "./label.js";
import { cap, isNative, plugin } from "./platform.js";

export const canSave = isNative;
const FS = () => plugin("Filesystem");
const DIR = "DOCUMENTS";
const CHUNK = 3 << 20; // a multiple of 3 bytes, so every base64 chunk decodes on its own

export const cleanDest = s => (s || "").replace(/[\\:*?"<>|]/g, " ").replace(/^\/+|\/+$/g, "").trim() || "Photo Sorter";

export async function askPermission() { try { await FS().requestPermissions(); } catch { /* Android 11+ needs none for Documents */ } }

export async function writeBlob(path, blob) {
  for (let off = 0, first = true; first || off < blob.size; off += CHUNK, first = false) {
    const data = await toBase64(blob.slice(off, off + CHUNK));
    if (first) await FS().writeFile({ path, data, directory: DIR, recursive: true });
    else await FS().appendFile({ path, data, directory: DIR });
  }
}
export const writeText = (path, text) => FS().writeFile({ path, data: text, directory: DIR, encoding: "utf8", recursive: true });
export async function moveFile(base, fromRel, toRel) {
  const to = `${base}/${toRel}`, dir = to.slice(0, to.lastIndexOf("/"));
  try { await FS().mkdir({ path: dir, directory: DIR, recursive: true }); } catch { /* already there */ }
  await FS().rename({ from: `${base}/${fromRel}`, to, directory: DIR, toDirectory: DIR });
}
export async function viewBase(base) { // -> function(rel) giving a URL the page can show
  const { uri } = await FS().getUri({ path: base, directory: DIR });
  return rel => cap().convertFileSrc(`${uri.replace(/\/$/, "")}/${rel.split("/").map(encodeURIComponent).join("/")}`);
}

// plan: from planOutput(); files: Map(id -> File); previous: rel paths this tool wrote last time (only those are removed).
export async function saveAll({ dest, recs, plan, files, previous = [], onProgress }) {
  const base = cleanDest(dest);
  await askPermission();
  for (const rel of previous) { try { await FS().deleteFile({ path: `${base}/${rel}`, directory: DIR }); } catch { /* already gone */ } }
  for (const dir of [...new Set(previous.map(r => r.slice(0, r.lastIndexOf("/"))))].sort((a, b) => b.length - a.length).concat("_Review")) {
    try { await FS().rmdir({ path: `${base}/${dir}`, directory: DIR }); } catch { /* not empty or gone: leave it */ }
  }
  const ok = [], failed = [];
  let n = 0;
  for (const p of plan) {
    const f = files.get(p.id);
    try {
      if (!f) throw new Error("the original is no longer open");
      await writeBlob(`${base}/${p.rel}`, f);
      ok.push(p);
    } catch (e) { failed.push(`${p.rel}: ${e.message || e}`); }
    onProgress(++n, plan.length);
  }
  const okIds = new Set(ok.map(p => p.id)), { sortedCsv, duplicatesCsv } = buildCsvs(recs.filter(r => okIds.has(r.id)), ok);
  await writeText(`${base}/sorted.csv`, sortedCsv);
  await writeText(`${base}/duplicates.csv`, duplicatesCsv);
  return { base, ok, failed };
}
export async function rewriteCsvs(base, recs, plan) {
  const { sortedCsv, duplicatesCsv } = buildCsvs(recs, plan);
  await writeText(`${base}/sorted.csv`, sortedCsv);
  await writeText(`${base}/duplicates.csv`, duplicatesCsv);
}
