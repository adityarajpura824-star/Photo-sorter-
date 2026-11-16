# Photo Sorter (Android)

Your camera roll, sorted on your phone. Pick photos and videos, and the app puts a copy of each into a folder
(Selfies, Food, Travel, Screenshots, Video calls, …), finds duplicates, and shows it all live.
Your originals are never moved, renamed or deleted.

Everything the original `claude-photo-sorter` does is here, with a simpler phone UI:

| Original | On the phone |
|---|---|
| 14 default folders, editable | Same 14. **Edit folders** to rename, add, remove or reword the rules |
| Claude labels the photos | Optional: paste your own Anthropic key in Settings. Free on-device model is the default |
| Jev labeler | Optional: paste your own Jev key |
| Duplicates (exact and near) | Exact copies and re-saved/resized copies; the biggest file is kept, the rest go to `_Review/duplicates` |
| Live dashboard, folder cards, flying photos | Same, phone-sized. Light and dark theme |
| Move a photo by hand | Tap a folder, tap a photo, pick a new folder. The saved copy and the CSVs update |
| `sorted.csv`, `duplicates.csv` | Written next to the folders |
| Cost check | A confirmation with the estimated tokens before any paid labeler runs |
| Try on a sample | "Try 200 random files first" option, and a demo with drawn pictures |

## Get it on your phone

1. Create an empty GitHub repo and push this folder to it (branch `main`).
2. Open the repo's **Actions** tab. **Build Android APK** runs on every push (or press *Run workflow*).
3. When it is green, open the run, download **photo-sorter-apk**, unzip it, and send `app-debug.apk` to your phone.
4. Open the APK on the phone and allow "install from this source" when asked.

## Using it

- **Choose photos & videos**: in the picker open a folder such as Camera and use *Select all*.
- **Free on-device sorting** downloads a ~150 MB model the first time (Wi-Fi recommended), then works offline.
- **Claude / Jev** are paid by the key you paste. The app shows an estimate and asks before it starts.
- Copies are saved in **Documents / Photo Sorter** (change the name in Settings). **My files** shows the exact place.

## Build it yourself

```
npm ci
npm test              # 15 unit tests for the sorting and duplicate logic
npm run vendor        # copies the on-device model runtime into www/vendor
npx cap sync android
cd android && ./gradlew assembleDebug
```

To see the interface with drawn pictures and no phone: `python3 -m http.server -d www`, then open `http://localhost:8000/?demo`.

## Layout

- `www/js/core.js` all the logic that decides things (folders, duplicates, planning, CSVs). Unit tested.
- `www/js/scan.js`, `label.js`, `fsout.js` read files, label them, write the copies.
- `www/js/app.js` the screens. `www/css/app.css` the look.
- `test/e2e/run_e2e.py` drives the whole flow in a headless phone-sized browser with a fake phone filesystem.
