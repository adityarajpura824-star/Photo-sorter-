// The only thing written to Documents now: sorted.csv and duplicates.csv (a readable list of what went where).
// Photos and videos are moved inside the gallery by the native plugin (library.js), never copied.
import { buildCsvs } from "./core.js";
import { plugin } from "./platform.js";

export const cleanDest = s => (s || "").replace(/[\\:*?"<>|]/g, " ").replace(/^\/+|\/+$/g, "").trim() || "Photo Sorter";

export async function writeCsvs(base, recs, plan) {
  const { sortedCsv, duplicatesCsv } = buildCsvs(recs, plan), FS = plugin("Filesystem");
  for (const [name, data] of [["sorted.csv", sortedCsv], ["duplicates.csv", duplicatesCsv]])
    await FS.writeFile({ path: `${base}/${name}`, data, directory: "DOCUMENTS", encoding: "utf8", recursive: true });
}
