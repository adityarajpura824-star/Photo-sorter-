# Photo Sorter (Android)

Your camera roll, sorted by what is *in* each photo, on your phone. Tap **Sort all my photos** and the app reads your whole
gallery by itself (no picking), looks at every photo and video, and **proposes** folders
(Selfies, Food, Travel, Screenshots, Video calls, …) and a set of duplicates.

**Sorting changes nothing on your phone.** You look through the folders inside the app, fix mistakes, and only when you press
**Import** are the photos *moved* (not copied) into gallery albums. **Undo import** puts every photo back where it came from.

Everything the original `claude-photo-sorter` does is here, with a simpler phone UI:

| Original | On the phone |
|---|---|
| 14 default folders, editable | Same 14. **Edit folders** to rename, add, remove or reword the rules; the phone re-sorts in seconds |
| Claude labels the photos | Optional: paste your own Anthropic key in Settings. Free on-device model is the default |
| Jev labeler | Optional: paste your own Jev key |
| Duplicates (exact and near) | Exact copies and re-saved/resized copies; the biggest file is kept, the rest go to the album *Duplicates to review* (nothing is deleted) |
| Live dashboard, folder cards, flying photos | Same, phone-sized. Light and dark theme |
| Move a photo by hand | Tap a folder, tap a photo, pick a new folder. It only edits the plan until you press Import / Apply changes |
| `sorted.csv`, `duplicates.csv` | Written to Documents / Photo Sorter when you import (if Android allows it) |
| Cost check | A confirmation with the estimated tokens before any paid labeler runs |
| Try on a sample | "Try 200 random files first" option, and a demo with drawn pictures |

## Getting recognition right: Teach it

The free on-device model (CLIP) is a general-purpose image model, so it will be wrong on some of *your* photos. Instead of
guessing, the app learns from you:

1. After a sort, tap **Teach it**. It shows the ~24 photos it is **least sure about**, spread over different folders.
2. Fix the wrong ones, leave the right ones, tap **Teach it**.
3. It nudges its idea of each folder toward the photos you chose and **re-sorts everything at once** (it remembers what the model saw in
   every photo, so there is no rescan and no download). Repeat until it looks right. **Forget what I taught it** resets this.

What you taught is kept between sorts. Hand-moving a photo in the app also teaches it. Screenshots and screen recordings are
recognised from their name/folder and only go to the screenshot-type folders. Teaching works with the on-device sorter only.

## Get it on your phone

1. Push this folder to a GitHub repo (branch `main`).
2. Open the repo's **Actions** tab. **Build Android APK** runs on every push (or press *Run workflow*).
3. When it is green, open the run, download **photo-sorter-apk**, unzip it, and send `app-debug.apk` to your phone.
4. Open the APK on the phone and allow "install from this source" when asked. **Uninstall any older build first**: each CI build is signed with a different debug key, so Android refuses to update over it.

## Using it

- **Sort all my photos**: the first time, Android asks to let the app see your photos and videos. Choose **Allow** (on Android 14, *Allow all*).
- **Import**: Android asks you to confirm moving the files once per 1,000 photos. Albums are made at
  `Pictures/Photo Sorter/<folder>` and `Movies/Photo Sorter/<folder>`. Folders left empty by the move disappear from your gallery by themselves.
- Changed your mind after importing? Edit folders or move photos, then **Apply changes**. **Undo import** restores every photo you
  haven't moved or deleted yourself since.
- **Free on-device sorting** downloads a ~150 MB model the first time (Wi-Fi recommended), then works offline.
- **Claude / Jev** are paid by the key you paste. The app shows an estimate and asks before it starts.

## Build it yourself

```
npm ci
npm test              # unit tests for sorting, recognition/teaching and duplicate logic
npm run vendor        # copies the on-device model runtime into www/vendor
npx cap sync android
cd android && ./gradlew assembleDebug
```

To see the interface with drawn pictures and no phone: `python3 -m http.server -d www`, then open `http://localhost:8000/?demo`.

## Notes

- Needs **Android 11 or newer** (moving files between gallery folders without copying uses `MediaStore.createWriteRequest`). The native part is `android/.../MediaLibraryPlugin.java`.
- Moving keeps the file itself (GPS tag, date, everything); only its folder changes.
- If Android refuses the confirmation box, nothing moves and nothing is recorded; press Import again.
- The undo record is kept on the phone. If you clear the app's data, Undo is gone (the photos stay where they are).

## Layout

- `www/js/core.js` all the logic that decides things (folders, prompts, recognition, teaching, duplicates, planning, CSVs). Unit tested.
- `www/js/library.js` the whole gallery (list, previews, fingerprints, move); `scan.js`, `label.js`, `fsout.js` read files, label them, write the CSVs.
- `www/js/app.js` the screens. `www/css/app.css` the look.
- `test/e2e/run_e2e.py` drives the whole flow in a headless phone-sized browser against a fake gallery that really changes when files are moved
  (sort changes nothing, Import, Apply changes, Undo, denied permission, Teach it).
