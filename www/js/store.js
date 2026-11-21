// Saves results on the phone (IndexedDB) so closing the app does not lose them. Best effort: every call is safe to fail.
const open = () => new Promise((res, rej) => {
  const q = indexedDB.open("photo-sorter", 2);
  q.onupgradeneeded = () => { for (const s of ["kv", "thumbs", "minis", "emb"]) if (!q.result.objectStoreNames.contains(s)) q.result.createObjectStore(s); }; // emb: what the image model saw in each photo, kept so re-sorting needs no rescan
  q.onsuccess = () => res(q.result);
  q.onerror = () => rej(q.error);
});
let dbp;
const db = () => (dbp ||= open());
async function run(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => res(out && "result" in out ? out.result : out);
    t.onerror = t.onabort = () => rej(t.error);
  });
}
export const get = (s, k) => run(s, "readonly", o => o.get(k)).catch(() => undefined);
export const put = (s, k, v) => run(s, "readwrite", o => o.put(v, k)).catch(() => {});
export const clear = s => run(s, "readwrite", o => o.clear()).catch(() => {});
export async function putMany(s, entries) { // entries: [[key, value], ...] in one transaction
  try { await run(s, "readwrite", o => { for (const [k, v] of entries) o.put(v, k); }); } catch {}
}
export async function getAll(s) { // -> Map(key -> value)
  try {
    const d = await db();
    return await new Promise((res, rej) => {
      const t = d.transaction(s, "readonly"), o = t.objectStore(s), keys = o.getAllKeys(), vals = o.getAll();
      t.oncomplete = () => res(new Map(keys.result.map((k, i) => [k, vals.result[i]])));
      t.onerror = () => rej(t.error);
    });
  } catch { return new Map(); }
}

const DEFAULTS = { theme: null, labeler: "device", claudeKey: "", claudeModel: "claude-sonnet-5-5", jevKey: "", dest: "Photo Sorter", sample: false };
export function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("settings") || "{}") }; } catch { return { ...DEFAULTS }; }
}
export function saveSettings(s) { try { localStorage.setItem("settings", JSON.stringify(s)); } catch {} }
