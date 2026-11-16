// Copies the on-device model runtime (transformers.js + its onnx wasm) from node_modules into www/vendor/,
// so the app loads it from inside the APK. The model weights themselves (~150 MB) download once on the phone.
import { copyFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const from = fileURLToPath(new URL("../node_modules/@huggingface/transformers/dist/", import.meta.url));
const to = fileURLToPath(new URL("../www/vendor/", import.meta.url));
const files = ["transformers.min.js", "ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm"];

mkdirSync(to, { recursive: true });
for (const f of files) {
  if (!existsSync(from + f)) { console.error(`missing ${from}${f} - run npm ci first`); process.exit(1); }
  copyFileSync(from + f, to + f);
  console.log(`vendor/${f}  ${(statSync(to + f).size / 1e6).toFixed(1)} MB`);
}
