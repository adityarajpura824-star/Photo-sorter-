import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CATEGORIES as CATS, validateCategories, slug, uniqueKey, folderName, fallbackKey, catsFingerprint, kindOf, extOf,
  phashFromGray, hamming, findDuplicates, resolveLabels, planOutput, csv, buildCsvs, folderCounts,
  claudeBatches, claudePrompt, parseLabelJson, sheetTag, softmaxPick, sampleFiles, overallProgress, secondsLeft, fmt, size, roughly,
} from "../www/js/core.js";

// smooth test "photos": a few waves with distinct strengths, so every hash bit is decided by real image content
const wave = (seed, shift = 0) => Array.from({ length: 1024 }, (_, i) => {
  const x = i % 32, y = Math.floor(i / 32);
  let v = 128 + shift;
  for (let k = 1; k <= 6; k++) v += (40 / k) * Math.cos(((x * (k + seed % 3) + y * (k * 2 + seed)) * Math.PI) / 32 + seed * k);
  return v;
});
const rec = (id, o = {}) => ({ id, name: `IMG_${id}.JPG`, ext: ".jpg", kind: "photo", bytes: 1000, sha: `sha${id}`, phash: null, ...o });

test("standard folders are valid and match the original 14", () => {
  assert.equal(CATS.length, 14);
  assert.equal(CATS.filter(c => c.kind === "photo").length, 10);
  assert.equal(validateCategories(CATS), CATS);
  assert.equal(fallbackKey(CATS, "photo"), "screenshots");
  assert.equal(fallbackKey(CATS, "video"), "vclips");
});

test("folder validation rules", () => {
  assert.throws(() => validateCategories([...CATS, { ...CATS[0] }]), /same key/);
  assert.throws(() => validateCategories([{ key: "a", kind: "photo", label: " " }, CATS[10]]), /needs a name/);
  assert.throws(() => validateCategories(CATS.filter(c => c.kind === "photo")), /one photo folder and one video/);
});

test("slug, unique keys, folder names, fingerprint", () => {
  assert.equal(slug("Kids & School!"), "kids-school");
  assert.equal(slug("🎉"), "folder");
  assert.equal(uniqueKey("Food", new Set(["food", "food-2"])), "food-3");
  assert.equal(folderName("People & family/2020"), "People and family-2020");
  const a = catsFingerprint(CATS), b = catsFingerprint(CATS.map(c => ({ ...c })));
  assert.equal(a, b);
  assert.notEqual(a, catsFingerprint(CATS.map((c, i) => (i ? c : { ...c, rule: "changed" }))));
});

test("kinds from name or mime", () => {
  assert.equal(kindOf("a.HEIC"), "photo");
  assert.equal(kindOf("a.mov"), "video");
  assert.equal(kindOf("noext", "video/mp4"), "video");
  assert.equal(kindOf("notes.txt"), null);
  assert.equal(extOf("a.b.PNG"), ".png");
});

test("phash: same image 0, slightly brighter copy close, different image far", () => {
  const a = phashFromGray(wave(1)), same = phashFromGray(wave(1)), bright = phashFromGray(wave(1, 8));
  const flipped = phashFromGray(wave(7));
  assert.equal(hamming(a, same), 0);
  assert.ok(hamming(a, bright) <= 4, `bright distance ${hamming(a, bright)}`);
  assert.ok(hamming(a, flipped) > 4, `different distance ${hamming(a, flipped)}`);
  assert.equal(hamming({ hi: 0, lo: 0 }, { hi: 0xffffffff, lo: 0xffffffff }), 64);
});

test("duplicates: exact copies, near copies, keeper is the biggest, space freed", async () => {
  const h = phashFromGray(wave(1));
  const recs = [
    rec(0, { sha: "x", bytes: 500, name: "a.jpg", phash: h }),
    rec(1, { sha: "x", bytes: 500, name: "a copy.jpg", phash: h }), // exact copy
    rec(2, { sha: "y", bytes: 900, name: "burst1.jpg", phash: phashFromGray(wave(1, 5)) }), // near copy of 0, bigger
    rec(3, { sha: "z", bytes: 100, name: "other.jpg", phash: phashFromGray(wave(7)) }),
    rec(4, { sha: "v", kind: "video", ext: ".mp4", bytes: 9999, name: "clip.mp4", phash: h }), // same hash but a video: never a dupe of a photo
  ];
  const d = await findDuplicates(recs);
  assert.equal(d.length, 1);
  assert.equal(d[0].keep, 2);
  assert.deepEqual([...d[0].dupes].sort(), [0, 1]);
  assert.equal(d[0].type, "near");
  assert.equal(d[0].freed, 1000);
});

test("duplicates: identical bytes are 'exact', even without a preview hash", async () => {
  const d = await findDuplicates([rec(0, { sha: "s", error: "bad" }), rec(1, { sha: "s", name: "longer name.jpg" })]);
  assert.equal(d[0].type, "exact");
  assert.equal(d[0].keep, 0); // same size: shorter name wins
});

test("duplicates: different screenshots with the same layout stay apart (PNG pixel check)", async () => {
  const h = phashFromGray(wave(1));
  const recs = [rec(0, { ext: ".png", sha: "a", phash: h }), rec(1, { ext: ".png", sha: "b", phash: h }), rec(2, { ext: ".png", sha: "c", phash: h })];
  const differ = async (a, b) => !(a === 0 && b === 2); // only 0 and 2 are pixel-identical
  const d = await findDuplicates(recs, { pixelsDiffer: differ });
  assert.equal(d.length, 1);
  assert.deepEqual([d[0].keep, ...d[0].dupes].sort(), [0, 2]);
});

test("labels: Jev wins at >=70%, otherwise AI; wrong-kind labels fall back; hand moves win", () => {
  const recs = [rec(0), rec(1), rec(2), rec(3), rec(4, { kind: "video" })];
  const ai = { 0: "food", 1: "food", 2: "vtalk", 4: "vscreen" }; // 2 is a photo given a video folder; 3 has no label
  const jev = { 0: { key: "pets", confidence: 0.9 }, 1: { key: "pets", confidence: 0.5 } };
  const { labels, fixed, missing } = resolveLabels(recs, CATS, ai, jev, { 4: "vclips", 99: "food" });
  assert.deepEqual(labels, { 0: "pets", 1: "food", 2: "screenshots", 3: "screenshots", 4: "vclips" });
  assert.equal(fixed, 1);
  assert.equal(missing, 1);
});

test("output plan: dupes go to _Review, name clashes get the id, CSVs quote properly", () => {
  const recs = [rec(0, { name: "a.jpg" }), rec(1, { name: "a.jpg" }), rec(2, { name: 'we"ird, name.jpg' }), rec(3, { name: "d.jpg" })];
  const labels = { 0: "food", 1: "food", 2: "pets", 3: "food" };
  const dupes = [{ keep: 0, dupes: [3], type: "exact", freed: 1 }];
  const plan = planOutput(recs, labels, CATS, dupes);
  assert.deepEqual(plan.map(p => p.rel), ["Food and drinks/a.jpg", "Food and drinks/a__1.jpg", 'Pets and animals/we"ird, name.jpg', "_Review/duplicates/d.jpg"]);
  const { sortedCsv, duplicatesCsv } = buildCsvs(recs, plan);
  assert.match(sortedCsv, /^file,folder,original_name\r\n/);
  assert.match(sortedCsv, /"Pets and animals\/we""ird, name.jpg"/);
  assert.equal(duplicatesCsv, "duplicate,kept_copy,type\r\nd.jpg,a.jpg,exact\r\n");
  assert.deepEqual(folderCounts(recs, labels, dupes), { _dupes: 1, food: 2, pets: 1 });
  assert.equal(csv([["a", "b c"]]), "a,b c\r\n");
});

test("Claude: batches of 3 sheets, tags, prompt, tolerant JSON parsing", () => {
  const recs = Array.from({ length: 200 }, (_, i) => rec(i));
  const b = claudeBatches(recs);
  assert.equal(b.length, 3); // 7 sheets -> 3 + 3 + 1
  assert.equal(b[0].length, 3);
  assert.equal(b[2][0].length, 20);
  assert.equal(sheetTag(rec(5, { kind: "video", duration: 11.6 })), "5 VIDEO 12s");
  assert.equal(sheetTag(rec(6, { ext: ".png" })), "6 PNG");
  assert.match(claudePrompt(CATS, 3), /- vscreen \(video\): recordings of a phone/);
  assert.deepEqual(parseLabelJson('Sure!\n{"12": "food", "13": "selfies", "99": "x"}', ["12", "13"]), { 12: "food", 13: "selfies" });
  assert.deepEqual(parseLabelJson("no json", ["1"]), {});
  assert.deepEqual(parseLabelJson("{broken", ["1"]), {});
});

test("on-device scoring picks the most similar folder", () => {
  const r = softmaxPick([0.1, 0.3, 0.2], ["a", "b", "c"]);
  assert.equal(r.key, "b");
  assert.ok(r.confidence > 0.5 && r.confidence < 1);
});

test("sampling is repeatable, ordered and the right size", () => {
  const items = Array.from({ length: 1000 }, (_, i) => i);
  const s = sampleFiles(items, 200), s2 = sampleFiles(items, 200);
  assert.equal(s.length, 200);
  assert.deepEqual(s, s2);
  assert.deepEqual(s, [...s].sort((a, b) => a - b));
  assert.equal(new Set(s).size, 200);
  assert.equal(sampleFiles(items, 5000), items);
});

test("progress and time left are measured, never guessed", () => {
  const all = ["scan", "dupes", "label", "apply"];
  assert.equal(overallProgress(all, "scan", 0, 10), 0);
  assert.ok(Math.abs(overallProgress(all, "dupes", 0, 0) - 0.3) < 1e-9);
  assert.equal(overallProgress(all, "done", 0, 0), 1);
  assert.ok(Math.abs(overallProgress(["dupes", "label", "apply"], "label", 5, 10) - 0.275 / 0.7) < 1e-9);
  assert.equal(secondsLeft(10, 1, 100), null);
  assert.equal(secondsLeft(30, 50, 100), 30);
});

test("number formats", () => {
  assert.equal(fmt(1234567), "12,34,567");
  assert.equal(size(2.5e9), "2.5 GB");
  assert.equal(size(450e6), "450 MB");
  assert.equal(roughly(20), "under a minute");
  assert.equal(roughly(300), "about 5 min");
});
