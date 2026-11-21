// The phone's own gallery, read through the small native plugin (android/.../MediaLibraryPlugin.java).
// This is what lets "Sort" work on every photo and video with no picking. Only the Android app has it.
import { isNative, plugin } from "./platform.js";

const P = () => plugin("MediaLibrary");
const PAGE = 1500;

export const hasLibrary = isNative;

export async function access() { return !!(await P().requestAccess()).granted; }
export const openSettings = () => P().openSettings();

// Every photo, then every video, as file-like items: { native, kind, uri, name, type, size, lastModified, rel, w, h, duration }.
export async function list(onCount = () => {}) {
  const out = [];
  for (const kind of ["photo", "video"]) {
    for (let offset = 0; ;) {
      const { items } = await P().list({ kind, offset, limit: PAGE });
      for (const m of items) out.push({ native: true, kind, uri: m.uri, name: m.name, type: m.type, size: m.size, lastModified: m.taken, rel: m.rel, w: m.w, h: m.h, duration: m.duration });
      offset += items.length; onCount(out.length);
      if (items.length < PAGE) break;
    }
  }
  return out;
}

export async function thumb(file, px = 300) { // -> JPEG Blob (a video gives one of its frames)
  const { data } = await P().thumb({ uri: file.uri, size: px });
  return (await fetch("data:image/jpeg;base64," + data)).blob();
}
export const sha = async file => (await P().sha({ uri: file.uri })).sha;
// Moves photos and videos into other gallery folders (no copies). moves: [{ uri, to: "Pictures/Photo Sorter/Food/", name }].
// Android asks the person to allow each batch once; the promise rejects with "denied" if they say no.
// -> { moved: [uri], failed: [uri] }
export async function move(moves) {
  const r = await P().move({ moves });
  if (r.denied) throw new Error("denied");
  return r;
}
