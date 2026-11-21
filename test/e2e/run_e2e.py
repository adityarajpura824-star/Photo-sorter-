"""End-to-end check in a phone-sized headless Chrome. Needs: python3 playwright, PIL, ffmpeg, Chrome.
   python3 test/e2e/run_e2e.py   -> prints PASS/FAIL lines and writes screenshots to /tmp/e2e-shots (or $SHOTS)
It fakes what only the phone has (Capacitor's Filesystem/Http and the MediaLibrary gallery plugin, with a gallery that really changes when
files are moved) and what needs a paid key or a model download (Claude's API, the on-device model: its "what the model saw" vectors are seeded),
so those parts are only checked for how the app talks to them."""
import base64, hashlib, http.server, json, os, random, subprocess, sys, threading, functools, shutil, tempfile
from PIL import Image, ImageDraw, ImageFilter
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WWW = os.path.join(ROOT, "www")
SHOTS = os.environ.get("SHOTS", "/tmp/e2e-shots")
os.makedirs(SHOTS, exist_ok=True)
tmp = tempfile.mkdtemp(prefix="photos-")
fails = []

def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail and not ok else ""))
    if not ok: fails.append(name)

# ---------- test media ----------
rnd = random.Random(5)
def scene(seed, w=800, h=600):
    r = random.Random(seed); im = Image.new("RGB", (w, h), tuple(r.randint(60, 200) for _ in range(3))); d = ImageDraw.Draw(im)
    for _ in range(14):
        x, y = r.randint(0, w), r.randint(0, h); s = r.randint(40, 260)
        d.ellipse((x, y, x + s, y + s), fill=tuple(r.randint(0, 255) for _ in range(3)))
    return im.filter(ImageFilter.GaussianBlur(3))
def screenshot(seed, dark=True):
    r = random.Random(seed); im = Image.new("RGB", (540, 1170), (20, 20, 24) if dark else (245, 245, 247)); d = ImageDraw.Draw(im); y = 60
    while y < 1100:
        d.rounded_rectangle((40, y, 40 + r.randint(100, 440), y + 22), 10, fill=(80, 80, 90) if dark else (200, 200, 205)); y += r.randint(34, 60)
    return im

media = {}  # name -> kind, expected label
def save(name, im, **kw): im.save(os.path.join(tmp, name), **kw)
save("a_beach.jpg", scene(1), quality=92)
shutil.copy(os.path.join(tmp, "a_beach.jpg"), os.path.join(tmp, "b_beach_copy.jpg"))                      # exact duplicate
save("c_beach_resaved.jpg", scene(1).resize((400, 300)), quality=60)                                       # near duplicate
save("d_city.jpg", scene(2), quality=90)
save("e_food.jpg", scene(3), quality=90)
big = Image.effect_noise((2600, 2000), 90).convert("RGB"); save("f_big_noise.jpg", big, quality=95)          # > 3 MB: forces chunked saving
save("g_shot1.png", screenshot(10)); save("h_shot2.png", screenshot(11))                                    # same layout family, different pixels
shutil.copy(os.path.join(tmp, "g_shot1.png"), os.path.join(tmp, "i_shot1_copy.png"))                        # exact PNG duplicate
subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=15", "-pix_fmt", "yuv420p", os.path.join(tmp, "j_clip.mp4")], check=True)
open(os.path.join(tmp, "k_notes.txt"), "w").write("not a photo")
names = sorted(os.listdir(tmp)); picked = [n for n in names if not n.endswith(".txt")]
print("picked in order:", picked)

# ---------- local web server ----------
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):  # /__media__/<name> serves the test photos, like the phone's gallery would
        if self.path.startswith("/__media__/"):
            data = open(os.path.join(tmp, os.path.basename(self.path.split("/__media__/")[1])), "rb").read()
            self.send_response(200); self.send_header("content-length", str(len(data))); self.end_headers(); self.wfile.write(data); return
        super().do_GET()
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Q, directory=WWW)); PORT = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = f"http://localhost:{PORT}/"


# ---------- a stand-in for what the Android app provides ----------
FAKE_CAP = """
const toBytes = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
const store = window.__fs = {};   // Documents: only the two CSV lists are ever written there
window.__calls = [];
window.Capacitor = {
  isNativePlatform: () => true, getPlatform: () => 'android',
  convertFileSrc: u => '/__media__/' + encodeURIComponent(decodeURIComponent(u.split('/').pop())),
  Plugins: {
    CapacitorHttp: { request: async o => { const r = await fetch(o.url, { method: o.method, headers: o.headers, body: JSON.stringify(o.data) }); return { status: r.status, data: await r.json() }; } },
    Filesystem: {
      writeFile: async o => { window.__calls.push(['write', o.path, (o.data||'').length]); store[o.path] = o.encoding === 'utf8' ? new TextEncoder().encode(o.data) : toBytes(o.data); return {}; },
    },
  },
};
"""

# the phone's gallery plugin (MediaLibrary): the 10 test files in a gallery that changes when the app moves them, like MediaStore does
FAKE_LIB = """
(() => {
  const media = __MEDIA__;
  const url = u => '/__media__/' + encodeURIComponent(decodeURIComponent(u.split('/').pop()));
  const lib = window.__lib = { grant: true, deny: false, calls: [], items: media.map(m => ({ ...m, uri: 'content://media/external/' + encodeURIComponent(m.name) })) };
  const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  const isVideo = m => m.type.startsWith('video');
  window.Capacitor.Plugins.MediaLibrary = {
    requestAccess: async () => { lib.calls.push(['requestAccess']); return { granted: lib.grant }; },
    openSettings: async () => { lib.calls.push(['openSettings']); },
    list: async o => {
      lib.calls.push(['list', o.kind, o.offset]);
      const all = lib.items.filter(m => (isVideo(m) ? 'video' : 'photo') === o.kind);
      return { items: all.slice(o.offset, o.offset + o.limit).map(m => ({ uri: m.uri, name: m.name, type: m.type, size: m.size, taken: m.taken, rel: m.rel, w: m.w, h: m.h, ...(isVideo(m) ? { duration: m.duration } : {}) })) };
    },
    thumb: async o => {
      lib.calls.push(['thumb']);
      const c = document.createElement('canvas');
      if (o.uri.endsWith('.mp4')) { c.width = c.height = 200; const x = c.getContext('2d'); x.fillStyle = '#556'; x.fillRect(0, 0, 200, 200); }
      else { const bmp = await createImageBitmap(await (await fetch(url(o.uri))).blob()); const k = Math.min(1, o.size / Math.max(bmp.width, bmp.height)); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k); c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); }
      return { data: c.toDataURL('image/jpeg', 0.85).split(',')[1], w: c.width, h: c.height };
    },
    sha: async o => ({ sha: hex(await crypto.subtle.digest('SHA-256', await (await fetch(url(o.uri))).arrayBuffer())) }),
    // like the Java plugin: one Android permission box per call, then every file's folder is changed in place
    move: async o => {
      lib.calls.push(['move', o.moves.length]);
      if (lib.deny) return { denied: true };
      const moved = [], failed = [];
      for (const m of o.moves) { const it = lib.items.find(x => x.uri === m.uri); if (!it) { failed.push(m.uri); continue; } it.rel = m.to; it.name = m.name; moved.push({ uri: m.uri, name: m.name }); }
      return { moved, failed };
    },
  };
})();
"""
media_list = []
for n in picked:
    f = os.path.join(tmp, n); v = n.endswith(".mp4"); w, h = (320, 240) if v else Image.open(f).size
    media_list.append({"name": n, "type": "video/mp4" if v else "image/png" if n.endswith(".png") else "image/jpeg", "size": os.path.getsize(f), "taken": int(os.path.getmtime(f) * 1000), "w": w, "h": h, "duration": 3,
                       "rel": "DCIM/Camera/" if not n.endswith(".png") else "Pictures/Screenshots/"})
FAKE_LIB = FAKE_LIB.replace("__MEDIA__", json.dumps(media_list))
SHA = {n: hashlib.sha256(open(os.path.join(tmp, n), "rb").read()).hexdigest() for n in picked}

def claude_answer(route, request):
    if request.method == "OPTIONS":
        return route.fulfill(status=204, headers={"access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST"})
    body = json.loads(request.post_data)
    state["claude_calls"].append({"model": body["model"], "images": sum(1 for c in body["messages"][0]["content"] if c["type"] == "image"), "key": request.headers.get("x-api-key"), "browser_header": request.headers.get("anthropic-dangerous-direct-browser-access")})
    labels = {str(i): ("vclips" if n.endswith(".mp4") else "screenshots" if n.endswith(".png") else "travel" if n.startswith(("a_", "b_", "c_")) else "city" if n.startswith("d_") else "food") for i, n in enumerate(picked)}
    route.fulfill(status=200, headers={"access-control-allow-origin": "*", "content-type": "application/json"}, body=json.dumps({"content": [{"type": "text", "text": "Here you go:\n" + json.dumps(labels)}]}))
state = {"claude_calls": []}

# What the on-device model "saw", made up: every folder is one axis; a photo is a mix of axes. Two photos sit between Food and City,
# so the model is unsure about them and guesses Food. (The real model is far too big to run here.)
SEED = """async ({ shas }) => {
  const core = await import('/js/core.js'), st = await import('/js/store.js'), cats = core.DEFAULT_CATEGORIES, D = 32;
  const ax = key => cats.findIndex(c => c.key === key);
  const norm = v => { const n = Math.hypot(...v) || 1; return Float32Array.from(v, x => x / n); };
  const txt = {};
  cats.forEach((c, k) => core.clipPrompts(c).forEach((p, j) => { const v = new Float32Array(D); v[k] = 1; v[(k + 1 + j) % D] += 0.04; txt[p] = Array.from(norm(v)); }));
  await st.put('kv', 'txt', txt);
  for (const [sha, mix] of Object.entries(shas)) { const v = new Float32Array(D); for (const [key, w] of mix) v[ax(key)] += w; await st.put('emb', sha, norm(v)); }
  return Object.keys(txt).length;
}"""
def seeds():
    mix = {n: [("screenshots", 1.0)] if n.endswith(".png") else [("travel", 1.0)] for n in picked}  # a screenshot can only go to a screen folder
    mix["d_city.jpg"] = [("food", 0.62), ("city", 0.6)]; mix["f_big_noise.jpg"] = [("food", 0.62), ("city", 0.6), ("home", 0.02)]
    mix["e_food.jpg"] = [("food", 1.0)]; mix["j_clip.mp4"] = [("vclips", 1.0)]
    return {SHA[n]: m for n, m in mix.items()}

def phone(b, init=(), url=None):
    ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    pg = ctx.new_page()
    for s in init: pg.add_init_script(s)
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" else None)
    pg.route("https://api.anthropic.com/**", claude_answer)
    return pg
def toast_has(pg, text, t=20000): pg.wait_for_function("t => document.getElementById('toast').textContent.includes(t)", arg=text, timeout=t)
def rels(pg): return pg.evaluate("Object.fromEntries(window.__lib.items.map(m => [m.name, m.rel]))")
def kv(pg, key): return pg.evaluate("async k => (await (await import('/js/store.js')).get('kv', k))", key)
def count(pg, label): return int(pg.locator(".fcard", has_text=label).first.locator(".count").inner_text().replace(",", "") or 0)
errors = []

with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox", "--autoplay-policy=no-user-gesture-required"])
    ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" else None)

    # ---- 1. demo mode: the fake camera roll, results screen ----
    page.goto(URL + "?demo"); page.wait_for_selector(".fcard", timeout=20000); page.wait_for_timeout(800)
    page.screenshot(path=f"{SHOTS}/1-demo-done.png")
    n = int(page.inner_text("#bigN").replace(",", ""))
    check("demo: shows a sorted total", n > 100, n)
    check("demo: 14 folder cards + duplicates card", page.locator(".fcard").count() == 15, page.locator(".fcard").count())
    check("demo: no Import button (nothing real to move)", page.locator("#importbtn").count() == 0 and "only works in the Android app" in page.inner_text("#panel"))
    page.locator(".fcard").first.click(); page.wait_for_selector(".browse img"); page.wait_for_timeout(500)
    page.screenshot(path=f"{SHOTS}/2-demo-folder.png")
    page.locator(".browse > button").first.click(); page.wait_for_selector(".lightbox"); page.wait_for_timeout(400)
    page.screenshot(path=f"{SHOTS}/3-demo-lightbox.png")
    check("demo: lightbox opens with a move-to list", page.locator(".lightbox select option").count() >= 10)
    page.keyboard.press("Escape"); page.keyboard.press("Escape")
    page.get_by_text("Replay").click(); page.wait_for_timeout(5000)
    page.screenshot(path=f"{SHOTS}/4-demo-replay.png")
    page.wait_for_selector("body.is-done", timeout=30000)
    check("demo: replay finishes", True)

    # ---- 2. a browser (no gallery plugin): pick files, Claude labels, results, hand moves, restart ----
    pg = phone(b)
    pg.goto(URL); pg.wait_for_selector("text=Choose photos")
    pg.screenshot(path=f"{SHOTS}/5-setup.png")
    pg.set_input_files("#picker", [os.path.join(tmp, n) for n in names])
    pg.wait_for_selector("text=Start sorting")
    txt = pg.inner_text("main")
    check("setup: counts photos and videos (txt file ignored)", "9 photos" in txt and "1 videos" in txt, txt[:120])
    check("setup: says nothing changes until Import", "until you press Import" in txt, txt[:160])
    pg.get_by_text("Settings").click(); pg.get_by_text("Claude ").first.click()
    pg.fill("input[aria-label='Claude API key']", "sk-test-123")
    pg.screenshot(path=f"{SHOTS}/6-settings.png", full_page=True)
    pg.get_by_text("Start sorting").click()
    pg.wait_for_selector("text=Spend tokens"); pg.screenshot(path=f"{SHOTS}/7-confirm.png")
    pg.get_by_text("Spend tokens").click()
    pg.wait_for_timeout(1500); pg.screenshot(path=f"{SHOTS}/8-running.png")
    try:
        pg.wait_for_selector("body.is-done", timeout=40000)
    except Exception:
        print("STUCK:", pg.inner_text("#runname") if pg.locator("#runname").count() else "-", "|", pg.inner_text("#runnote") if pg.locator("#runnote").count() else "-", "|", errors[:5], state)
        pg.screenshot(path=f"{SHOTS}/stuck.png"); raise
    pg.wait_for_timeout(1200)
    pg.screenshot(path=f"{SHOTS}/9-done.png")
    check("claude: asked once with 1 contact sheet (10 files = 1 sheet)", len(state["claude_calls"]) == 1 and state["claude_calls"][0]["images"] == 1, state["claude_calls"])
    check("claude: key and browser header sent", state["claude_calls"][0]["key"] == "sk-test-123" and state["claude_calls"][0]["browser_header"] == "true")
    check("done: total is 10 files", pg.inner_text("#bigN").strip() == "10", pg.inner_text("#bigN"))
    check("done: picked files cannot be imported (no Import button in a browser)", pg.locator("#importbtn").count() == 0)
    check("dupes: exact + near beach copies and exact PNG copy found", int(pg.locator(".fcard.wide .count").inner_text()) >= 3, pg.locator(".fcard.wide .count").inner_text())
    pg.locator(".fcard", has_text="Travel").first.click(); pg.wait_for_selector(".browse img"); pg.wait_for_timeout(600)
    pg.screenshot(path=f"{SHOTS}/11-folder.png")
    pg.locator(".browse > button").first.click(); pg.wait_for_selector(".lightbox"); pg.wait_for_timeout(800)
    src = pg.evaluate("document.querySelector('.lightbox .media img, .lightbox .media video').getAttribute('src')")
    check("lightbox: shows the picked file (this session)", src and src.startswith("blob:"), src)
    pg.screenshot(path=f"{SHOTS}/12-lightbox.png")
    food = count(pg, "Food") if pg.locator(".fcard", has_text="Food").count() else 0
    pg.select_option(".lightbox select", "food"); pg.wait_for_timeout(800)
    toast_has(pg, "Moved to Food")
    for _ in range(3):
        if pg.locator(".scrim").count() == 0: break
        pg.keyboard.press("Escape"); pg.wait_for_timeout(400)
    check("move: the photo is now counted in Food", count(pg, "Food") == food + 1, (food, count(pg, "Food")))
    check("sheets close with Escape", pg.locator(".scrim").count() == 0, pg.locator(".scrim").count())
    pg.get_by_text("Edit folders").click(); pg.wait_for_selector(".frow"); pg.screenshot(path=f"{SHOTS}/13-edit-folders.png")
    check("edit folders: 14 rows", pg.locator(".frow").count() == 14, pg.locator(".frow").count())
    pg.keyboard.press("Escape")
    pg.reload(); pg.wait_for_selector("text=View last sort"); pg.get_by_text("View last sort").click(); pg.wait_for_selector("body.is-done"); pg.wait_for_timeout(500)
    check("restart: last results come back", pg.inner_text("#bigN").strip() == "10", pg.inner_text("#bigN"))
    check("restart: the hand move was kept", count(pg, "Food") == food + 1, (food, count(pg, "Food")))
    pg.screenshot(path=f"{SHOTS}/14-restored.png")
    pg.click("#theme"); pg.wait_for_timeout(300); pg.screenshot(path=f"{SHOTS}/15-dark.png")

    # ---- 3. one tap, Claude labels: sorting changes nothing, Import moves, Apply changes, Undo ----
    state["claude_calls"].clear()
    g = phone(b, [FAKE_CAP, FAKE_LIB, "localStorage.setItem('settings', JSON.stringify({labeler: 'claude', claudeKey: 'sk-test-123'}))"])
    g.goto(URL); g.wait_for_selector("text=Sort all my photos")
    g.screenshot(path=f"{SHOTS}/16-gallery-setup.png")
    setup_txt = g.inner_text("main")
    check("gallery: one Sort button, no picker, no 'choose myself' link", "Sort all my photos" in setup_txt and "Choose photos & videos" not in setup_txt and "Or choose photos myself" not in setup_txt, setup_txt[:200])
    g.get_by_text("Sort all my photos").click()
    g.wait_for_selector("text=Spend tokens", timeout=20000); g.screenshot(path=f"{SHOTS}/17-gallery-confirm.png")
    check("gallery: the confirmation counts all 10 files it found itself", "10 files" in g.inner_text(".sheet"), g.inner_text(".sheet")[:120])
    g.get_by_text("Spend tokens").click()
    g.wait_for_selector("body.is-done", timeout=60000); g.wait_for_timeout(1000)
    g.screenshot(path=f"{SHOTS}/18-gallery-done.png")
    lib_calls = g.evaluate("window.__lib.calls")
    original = {m["name"]: m["rel"] for m in media_list}
    check("gallery: asked for access once", sum(1 for c in lib_calls if c[0] == "requestAccess") == 1)
    check("gallery: listed photos then videos", [c[1] for c in lib_calls if c[0] == "list"] == ["photo", "video"], [c for c in lib_calls if c[0] == "list"])
    check("gallery: total is 10 files", g.inner_text("#bigN").strip() == "10", g.inner_text("#bigN"))
    check("SORT CHANGES NOTHING: no file moved, nothing written", not any(c[0] == "move" for c in lib_calls) and rels(g) == original and g.evaluate("window.__calls") == [], (rels(g), g.evaluate("window.__calls")))
    check("panel: offers Import for all 10 files, no Undo yet", "Import 10 files into the gallery" in g.inner_text("#importbtn") and g.locator("#undobtn").count() == 0, g.inner_text("#panel")[:200])
    check("panel: says nothing has changed yet", "Nothing on your phone has changed yet" in g.inner_text("#panelnote"))
    g.screenshot(path=f"{SHOTS}/18b-panel.png")
    g.click("#importbtn"); g.wait_for_selector("#doimport")
    check("import: the box says moved not copied, once per 1,000", "10 files" in g.inner_text(".sheet") and "moved, not copied" in g.inner_text(".sheet") and "once" in g.inner_text(".sheet"), g.inner_text(".sheet")[:300])
    g.wait_for_timeout(450); g.screenshot(path=f"{SHOTS}/19-import-confirm.png")
    g.click("#doimport"); toast_has(g, "Moved 10 files")
    now = rels(g); names_now = {m["name"]: m for m in g.evaluate("window.__lib.items")}
    g.screenshot(path=f"{SHOTS}/20-imported.png")
    check("import: one batch, every file moved, none copied", [c for c in g.evaluate("window.__lib.calls") if c[0] == "move"] == [["move", 10]] and len(now) == 10, [c for c in g.evaluate("window.__lib.calls") if c[0] == "move"])
    check("import: photos under Pictures/Photo Sorter/<folder>/", now["d_city.jpg"] == "Pictures/Photo Sorter/City and nights out/" and now["e_food.jpg"] == "Pictures/Photo Sorter/Food and drinks/", (now["d_city.jpg"], now["e_food.jpg"]))
    check("import: video under Movies/Photo Sorter/", now["j_clip.mp4"] == "Movies/Photo Sorter/Everyday clips/", now["j_clip.mp4"])
    dup_albums = [n for n, r in now.items() if r == "Pictures/Photo Sorter/Duplicates to review/"]
    check("import: duplicates are set aside in their own album, not deleted", len(dup_albums) >= 3 and len(now) == 10, dup_albums)
    csv_text = bytes(g.evaluate("Array.from(window.__fs['Photo Sorter/sorted.csv'] || [])")).decode()
    check("import: sorted.csv and duplicates.csv written", csv_text.startswith("file,folder,original_name") and csv_text.count("\r\n") == 11 and "Photo Sorter/duplicates.csv" in g.evaluate("Object.keys(window.__fs)"), csv_text[:120])
    check("import: panel now says done and offers Undo", g.locator("#undobtn").count() == 1 and g.locator("#importbtn").count() == 0 and "Pictures/Photo Sorter" in g.inner_text("#panelnote"), g.inner_text("#panel")[:200])
    rec = kv(g, "import")
    check("import: the original place of every file is remembered", rec and len(rec["moves"]) == 10 and all(m["from"]["rel"] == original[urlname] for urlname, m in [(__import__("urllib.parse").parse.unquote(u.split("/")[-1]), m) for u, m in rec["moves"].items()]), rec and list(rec["moves"].items())[:2])
    # a hand move after the import only edits the plan until you press Apply changes
    g.locator(".fcard", has_text="Travel").first.click(); g.wait_for_selector(".browse img"); g.wait_for_timeout(500)
    g.locator(".browse > button").first.click(); g.wait_for_selector(".lightbox"); g.wait_for_timeout(600)
    moved_name = g.inner_text(".lightbox .bar b")
    src = g.evaluate("document.querySelector('.lightbox .media img, .lightbox .media video').getAttribute('src')")
    check("lightbox: shows the real gallery file", src and src.startswith("/__media__/"), src)
    before = rels(g)
    g.select_option(".lightbox select", "food"); toast_has(g, "Apply changes")
    for _ in range(3):
        if g.locator(".scrim").count() == 0: break
        g.keyboard.press("Escape"); g.wait_for_timeout(300)
    check("hand move after import: the file has not moved yet", rels(g) == before)
    check("hand move after import: panel offers 'Apply 1 changes'", "Apply 1 changes" in g.inner_text("#importbtn"), g.inner_text("#panel")[:200])
    g.click("#importbtn"); g.wait_for_selector("#doimport"); g.click("#doimport"); toast_has(g, "Moved 1 files")
    check("apply: only that one file moved, into Food", rels(g)[moved_name] == "Pictures/Photo Sorter/Food and drinks/" and sum(1 for a, c in zip(sorted(before.items()), sorted(rels(g).items())) if a != c) == 1, rels(g)[moved_name])
    rec = kv(g, "import")
    check("apply: its ORIGINAL place is still what Undo will restore", rec["moves"][next(u for u in rec["moves"] if u.endswith(moved_name))]["from"]["rel"] == original[moved_name])
    # undo, with one photo the person moved themselves in the meantime
    g.evaluate("window.__lib.items.find(x => x.name === 'e_food.jpg').rel = 'Pictures/Elsewhere/'")
    g.click("#undobtn"); g.wait_for_selector("#doundo"); g.wait_for_timeout(450); g.screenshot(path=f"{SHOTS}/21-undo-confirm.png")
    check("undo: the box promises to leave your own moves alone", "left alone" in g.inner_text(".sheet"), g.inner_text(".sheet")[:300])
    g.click("#doundo"); toast_has(g, "Put 9 files back")
    back = rels(g)
    check("undo: everything is back where it came from", all(back[n] == original[n] for n in original if n != "e_food.jpg"), {n: (back[n], original[n]) for n in original if back[n] != original[n]})
    check("undo: the photo you moved yourself was left alone", back["e_food.jpg"] == "Pictures/Elsewhere/" and "left alone" in g.inner_text("#toast"), (back["e_food.jpg"], g.inner_text("#toast")))
    check("undo: record cleared, Import offered again", kv(g, "import") is None and g.locator("#undobtn").count() == 0 and "Import 10 files" in g.inner_text("#importbtn"), g.inner_text("#panel")[:200])
    g.screenshot(path=f"{SHOTS}/22-undone.png")
    # the person says no to Android's box: nothing moves, nothing is recorded
    g.evaluate("window.__lib.deny = true")
    before = rels(g)
    g.click("#importbtn"); g.wait_for_selector("#doimport"); g.click("#doimport"); toast_has(g, "You said no")
    check("denied: nothing moved, nothing recorded, Import still offered", rels(g) == before and kv(g, "import") is None and g.locator("#importbtn").count() == 1, g.inner_text("#toast"))
    g.evaluate("window.__lib.deny = false")
    check("gallery: Claude asked once with the same key", len(state["claude_calls"]) == 1 and state["claude_calls"][0]["key"] == "sk-test-123", state["claude_calls"])

    # ---- 4. the on-device model: Teach it, then Import. (Image vectors are seeded; the real model needs a download.) ----
    hf = []
    d = phone(b, [FAKE_CAP, FAKE_LIB])
    d.route("**/huggingface.co/**", lambda r, q: (hf.append(q.url), r.abort()))
    d.goto(URL); d.wait_for_selector("text=Sort all my photos")
    d.evaluate(SEED, {"shas": seeds()})
    d.get_by_text("Sort all my photos").click(); d.wait_for_selector("body.is-done", timeout=60000); d.wait_for_timeout(800)
    d.screenshot(path=f"{SHOTS}/23-device-done.png")
    check("device: sorted without downloading anything (cached vectors)", not hf and not errors, (hf, errors[:3]))
    check("device: unsure photos landed in Food, City is empty", count(d, "Food") == 3 and count(d, "City") == 0, (count(d, "Food"), count(d, "City")))
    check("device: sorting moved nothing", rels(d) == original)
    check("device: Teach it button is offered", d.locator("#teachbtn").count() == 1)
    d.click("#teachbtn"); d.wait_for_selector(".teach .tcard"); d.wait_for_timeout(600)
    d.screenshot(path=f"{SHOTS}/24-teach.png")
    first = d.locator(".tcard select").first.get_attribute("aria-label")
    check("teach: shows the unsure photos first", first in ("Folder for d_city.jpg", "Folder for f_big_noise.jpg"), first)
    check("teach: every folder choice is a photo folder", d.locator(".tcard select").first.locator("option").count() == 10, d.locator(".tcard select").first.locator("option").count())
    d.select_option("select[aria-label='Folder for d_city.jpg']", "city"); d.select_option("select[aria-label='Folder for f_big_noise.jpg']", "city")
    d.click("#teachgo"); toast_has(d, "Learned from")
    d.wait_for_timeout(500)
    check("teach: re-sorted at once, with no model download", not hf and count(d, "City") == 2 and count(d, "Food") == 1, (hf, count(d, "City"), count(d, "Food"), d.inner_text("#toast")))
    ex = kv(d, "examples")
    check("teach: what you taught it is kept", ex and ex.get(SHA["d_city.jpg"]) == "city" and ex.get(SHA["e_food.jpg"]) == "food", ex)
    d.screenshot(path=f"{SHOTS}/25-taught.png")
    d.click("#importbtn"); d.wait_for_selector("#doimport"); d.click("#doimport"); toast_has(d, "Moved 10 files")
    dn = rels(d)
    check("teach -> import: the taught photos went to City", dn["d_city.jpg"] == "Pictures/Photo Sorter/City and nights out/" and dn["f_big_noise.jpg"] == "Pictures/Photo Sorter/City and nights out/", (dn["d_city.jpg"], dn["f_big_noise.jpg"]))
    d.reload(); d.wait_for_selector("text=View last sort"); d.get_by_text("View last sort").click(); d.wait_for_selector("body.is-done"); d.wait_for_timeout(600)
    check("restart: Undo is still there after closing the app", d.locator("#undobtn").count() == 1 and d.locator("#importbtn").count() == 0, d.inner_text("#panel")[:200])
    d.click("#teachbtn"); d.wait_for_selector("#forgetbtn"); d.screenshot(path=f"{SHOTS}/26-teach-again.png")
    check("teach again: all taught, the box says so and still offers Forget", "nothing left to teach" in d.inner_text(".sheet") and d.locator("#teachgo").count() == 0, d.inner_text(".sheet")[:200])
    d.click("#forgetbtn"); toast_has(d, "Forgot what you taught it")
    check("forget: teaching cleared, hand placements stay", (kv(d, "examples") or {}) == {} and count(d, "City") == 2, (kv(d, "examples"), count(d, "City")))

    # ---- 5. access refused: a clear message and a way to Settings, nothing is sorted ----
    r = phone(b, [FAKE_CAP, FAKE_LIB, "window.__lib.grant = false"])
    r.goto(URL); r.wait_for_selector("text=Sort all my photos"); r.get_by_text("Sort all my photos").click()
    r.wait_for_selector("text=needs to see your photos"); r.screenshot(path=f"{SHOTS}/27-gallery-denied.png")
    r.get_by_text("Open settings").click(); r.wait_for_timeout(300)
    check("gallery: refused access shows a message and opens Settings", any(c[0] == "openSettings" for c in r.evaluate("window.__lib.calls")) and r.locator("body[data-mode=setup]").count() == 1)
    b.close()

check("no page errors", not errors, errors[:5])
shutil.rmtree(tmp, ignore_errors=True)
print("\nFAILED:" if fails else "\nALL PASSED", fails if fails else "")
sys.exit(1 if fails else 0)
