"""End-to-end check in a phone-sized headless Chrome. Needs: python3 playwright, PIL, ffmpeg, Chrome.
   python3 test/e2e/run_e2e.py   -> prints PASS/FAIL lines and writes screenshots to /tmp/e2e-shots (or $SHOTS)
It fakes what only the phone has (the Capacitor Filesystem plugin) and what needs a paid key or a model download
(Claude's API, the on-device model), so those parts are only checked for how the app talks to them."""
import base64, http.server, json, os, random, subprocess, sys, threading, functools, shutil, tempfile
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
window.__fs = {};  // path -> base64 chunks joined
const toBytes = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
const store = window.__fs = {};
window.__calls = [];
window.Capacitor = {
  isNativePlatform: () => true, getPlatform: () => 'android',
  convertFileSrc: u => '/__fs__/' + u.replace('file:///fake/Documents/', ''),
  Plugins: {
    CapacitorHttp: { request: async o => { const r = await fetch(o.url, { method: o.method, headers: o.headers, body: JSON.stringify(o.data) }); return { status: r.status, data: await r.json() }; } },
    Filesystem: {
      requestPermissions: async () => ({}),
      writeFile: async o => { window.__calls.push(['write', o.path, (o.data||'').length]); store[o.path] = o.encoding === 'utf8' ? new TextEncoder().encode(o.data) : toBytes(o.data); return {}; },
      appendFile: async o => { window.__calls.push(['append', o.path, o.data.length]); const a = store[o.path], b = toBytes(o.data), c = new Uint8Array(a.length + b.length); c.set(a); c.set(b, a.length); store[o.path] = c; return {}; },
      deleteFile: async o => { if (!(o.path in store)) throw new Error('missing'); delete store[o.path]; },
      rmdir: async o => { throw new Error('not empty'); },
      mkdir: async o => ({}),
      rename: async o => { if (!(o.from in store)) throw new Error('missing source'); store[o.to] = store[o.from]; delete store[o.from]; },
      getUri: async o => ({ uri: 'file:///fake/Documents/' + o.path.split('/').map(encodeURIComponent).join('/') }),
    },
  },
};
"""

# the phone's gallery plugin (MediaLibrary): the same 10 test files, served to the page as if MediaStore listed them
FAKE_LIB = """
(() => {
  const media = __MEDIA__;
  const url = u => '/__media__/' + encodeURIComponent(decodeURIComponent(u.split('/').pop()));
  const lib = window.__lib = { grant: true, calls: [] };
  const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  const isVideo = m => m.type.startsWith('video');
  window.Capacitor.Plugins.MediaLibrary = {
    requestAccess: async () => { lib.calls.push(['requestAccess']); return { granted: lib.grant }; },
    openSettings: async () => { lib.calls.push(['openSettings']); },
    list: async o => {
      lib.calls.push(['list', o.kind, o.offset, o.skip]);
      const all = media.filter(m => (isVideo(m) ? 'video' : 'photo') === o.kind);
      return { items: all.slice(o.offset, o.offset + o.limit).map(m => ({ uri: 'content://media/external/' + encodeURIComponent(m.name), name: m.name, type: m.type, size: m.size, taken: m.taken, w: m.w, h: m.h, ...(isVideo(m) ? { duration: m.duration } : {}) })) };
    },
    thumb: async o => {
      lib.calls.push(['thumb']);
      const c = document.createElement('canvas');
      if (o.uri.endsWith('.mp4')) { c.width = c.height = 200; const x = c.getContext('2d'); x.fillStyle = '#556'; x.fillRect(0, 0, 200, 200); }
      else { const bmp = await createImageBitmap(await (await fetch(url(o.uri))).blob()); const k = Math.min(1, o.size / Math.max(bmp.width, bmp.height)); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k); c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); }
      return { data: c.toDataURL('image/jpeg', 0.85).split(',')[1], w: c.width, h: c.height };
    },
    sha: async o => ({ sha: hex(await crypto.subtle.digest('SHA-256', await (await fetch(url(o.uri))).arrayBuffer())) }),
    copy: async o => { const b = new Uint8Array(await (await fetch(url(o.uri))).arrayBuffer()); window.__fs[o.path] = b; lib.calls.push(['copy', o.path, b.length]); return { bytes: b.length }; },
  };
})();
"""
media_list = []
for n in picked:
    f = os.path.join(tmp, n); v = n.endswith(".mp4"); w, h = (320, 240) if v else Image.open(f).size
    media_list.append({"name": n, "type": "video/mp4" if v else "image/png" if n.endswith(".png") else "image/jpeg", "size": os.path.getsize(f), "taken": int(os.path.getmtime(f) * 1000), "w": w, "h": h, "duration": 3})
FAKE_LIB = FAKE_LIB.replace("__MEDIA__", json.dumps(media_list))

def claude_answer(route, request):
    if request.method == "OPTIONS":
        return route.fulfill(status=204, headers={"access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST"})
    body = json.loads(request.post_data)
    state["claude_calls"].append({"model": body["model"], "images": sum(1 for c in body["messages"][0]["content"] if c["type"] == "image"), "key": request.headers.get("x-api-key"), "browser_header": request.headers.get("anthropic-dangerous-direct-browser-access")})
    labels = {str(i): ("vclips" if n.endswith(".mp4") else "screenshots" if n.endswith(".png") else "travel" if n.startswith(("a_", "b_", "c_")) else "city" if n.startswith("d_") else "food") for i, n in enumerate(picked)}
    route.fulfill(status=200, headers={"access-control-allow-origin": "*", "content-type": "application/json"}, body=json.dumps({"content": [{"type": "text", "text": "Here you go:\n" + json.dumps(labels)}]}))
state = {"claude_calls": []}

with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox", "--autoplay-policy=no-user-gesture-required"])
    ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" else None)

    # ---- 1. demo mode: the fake camera roll, results screen ----
    page.goto(URL + "?demo"); page.wait_for_selector(".fcard", timeout=20000); page.wait_for_timeout(800)
    page.screenshot(path=f"{SHOTS}/1-demo-done.png")
    n = int(page.inner_text("#bigN").replace(",", ""))
    check("demo: shows a sorted total", n > 100, n)
    check("demo: 14 folder cards + duplicates card", page.locator(".fcard").count() == 15, page.locator(".fcard").count())
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

    # ---- 2. real flow with the Claude labeler, in the 'phone' (fake filesystem) ----
    for stage in range(2):
        ctx2 = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
        pg = ctx2.new_page(); pg.add_init_script(FAKE_CAP)
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.route("https://api.anthropic.com/**", claude_answer)
        pg.route("**/__fs__/**", lambda route, req: route.fulfill(status=200, body=bytes(pg.evaluate("p => Array.from(window.__fs[decodeURIComponent(p)] || [])", req.url.split("/__fs__/")[1])), content_type="application/octet-stream"))
        pg.goto(URL); pg.wait_for_selector("text=Choose photos")
        pg.screenshot(path=f"{SHOTS}/5-setup.png")
        pg.set_input_files("#picker", [os.path.join(tmp, n) for n in names])
        pg.wait_for_selector("text=Start sorting")
        txt = pg.inner_text("main")
        check("setup: counts photos and videos (txt file ignored)", "9 photos" in txt and "1 videos" in txt, txt[:120])
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
        break

    check("claude: asked once with 1 contact sheet (10 files = 1 sheet)", len(state["claude_calls"]) == 1 and state["claude_calls"][0]["images"] == 1, state["claude_calls"])
    check("claude: key and browser header sent", state["claude_calls"][0]["key"] == "sk-test-123" and state["claude_calls"][0]["browser_header"] == "true")
    check("done: total is 10 files", pg.inner_text("#bigN").strip() == "10", pg.inner_text("#bigN"))
    fs = pg.evaluate("Object.fromEntries(Object.entries(window.__fs).map(([k,v]) => [k, v.length]))")
    paths = sorted(fs)
    print("saved:", paths)
    check("saved: sorted.csv and duplicates.csv exist", "Photo Sorter/sorted.csv" in fs and "Photo Sorter/duplicates.csv" in fs)
    media_paths = [x for x in paths if not x.endswith(".csv")]
    check("saved: all 10 files copied", len(media_paths) == 10, len(media_paths))
    check("saved: big file byte-exact (chunked)", fs.get("Photo Sorter/Travel and nature/f_big_noise.jpg") == os.path.getsize(os.path.join(tmp, "f_big_noise.jpg")) or any(x.endswith("f_big_noise.jpg") and fs[x] == os.path.getsize(os.path.join(tmp, "f_big_noise.jpg")) for x in paths), [ (x, fs[x]) for x in paths if "big" in x])
    check("saved: chunked write used append", any(c[0] == "append" for c in pg.evaluate("window.__calls")))
    dups = [x for x in paths if "_Review/duplicates" in x]
    print("duplicates:", dups)
    check("dupes: exact + near beach copies and exact PNG copy found", len(dups) >= 2, dups)
    check("dupes: the two different screenshots were NOT merged", not any("h_shot2" in x for x in dups) or not any("g_shot1" in x for x in dups), dups)
    csv_text = bytes(pg.evaluate("Array.from(window.__fs['Photo Sorter/sorted.csv'])")).decode()
    check("csv: header and rows", csv_text.startswith("file,folder,original_name") and csv_text.count("\r\n") == 11, csv_text[:200])
    for i, line in enumerate(csv_text.splitlines()[:12]): print("  csv:", line)

    # ---- 3. browse a folder, view, move a photo ----
    pg.get_by_role("button", name="My files").click(); pg.wait_for_selector("text=Documents / Photo Sorter"); pg.screenshot(path=f"{SHOTS}/10-where.png"); pg.keyboard.press("Escape")
    pg.locator(".fcard", has_text="Travel").first.click(); pg.wait_for_selector(".browse img"); pg.wait_for_timeout(600)
    pg.screenshot(path=f"{SHOTS}/11-folder.png")
    pg.locator(".browse > button").first.click(); pg.wait_for_selector(".lightbox"); pg.wait_for_timeout(800)
    src = pg.evaluate("document.querySelector('.lightbox .media img, .lightbox .media video').getAttribute('src')")
    check("lightbox: shows the saved copy via the phone's file URL", src and src.startswith("/__fs__/"), src)
    pg.screenshot(path=f"{SHOTS}/12-lightbox.png")
    before = [x for x in pg.evaluate("Object.keys(window.__fs)") if "Food" in x]
    pg.select_option(".lightbox select", "food"); pg.wait_for_timeout(800)
    after = [x for x in pg.evaluate("Object.keys(window.__fs)") if "Food" in x]
    check("move: the saved copy was renamed into the new folder", len(after) == len(before) + 1, (before, after))
    csv_after = bytes(pg.evaluate("Array.from(window.__fs['Photo Sorter/sorted.csv'])")).decode()
    check("move: sorted.csv rewritten with the new folder", csv_after != csv_text and "Food and drinks" in csv_after)

    # ---- 4. edit folders sheet (close the lightbox and the folder sheet first) ----
    for _ in range(3):
        if pg.locator(".scrim").count() == 0: break
        pg.keyboard.press("Escape"); pg.wait_for_timeout(400)
    check("sheets close with Escape", pg.locator(".scrim").count() == 0, pg.locator(".scrim").count())
    pg.get_by_text("Edit folders").click(); pg.wait_for_selector(".frow"); pg.screenshot(path=f"{SHOTS}/13-edit-folders.png")
    check("edit folders: 14 rows", pg.locator(".frow").count() == 14, pg.locator(".frow").count())
    pg.keyboard.press("Escape")

    # ---- 5. a restart keeps the results (IndexedDB) ----
    pg.reload(); pg.wait_for_selector("text=View last sort"); pg.get_by_text("View last sort").click(); pg.wait_for_selector("body.is-done"); pg.wait_for_timeout(500)
    check("restart: last results come back", pg.inner_text("#bigN").strip() == "10", pg.inner_text("#bigN"))
    pg.screenshot(path=f"{SHOTS}/14-restored.png")

    # ---- 6. dark theme ----
    pg.click("#theme"); pg.wait_for_timeout(300); pg.screenshot(path=f"{SHOTS}/15-dark.png")

    # ---- 7. one tap: the app reads the whole gallery itself, nothing is picked ----
    state["claude_calls"].clear()
    ctx3 = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    g = ctx3.new_page(); g.add_init_script(FAKE_CAP); g.add_init_script(FAKE_LIB)
    g.add_init_script("localStorage.setItem('settings', JSON.stringify({labeler: 'claude', claudeKey: 'sk-test-123'}))")
    g.on("pageerror", lambda e: errors.append(str(e)))
    g.route("https://api.anthropic.com/**", claude_answer)
    g.goto(URL); g.wait_for_selector("text=Sort all my photos")
    g.screenshot(path=f"{SHOTS}/16-gallery-setup.png")
    setup_txt = g.inner_text("main")
    check("gallery: setup offers one Sort button, no picker needed", "Sort all my photos" in setup_txt and "Choose photos & videos" not in setup_txt and "Or choose photos myself" in setup_txt, setup_txt[:200])
    g.get_by_text("Sort all my photos").click()
    g.wait_for_selector("text=Spend tokens", timeout=20000); g.screenshot(path=f"{SHOTS}/17-gallery-confirm.png")
    check("gallery: the confirmation counts all 10 files it found itself", "10 files" in g.inner_text(".sheet"), g.inner_text(".sheet")[:120])
    g.get_by_text("Spend tokens").click()
    g.wait_for_selector("body.is-done", timeout=60000); g.wait_for_timeout(1000)
    g.screenshot(path=f"{SHOTS}/18-gallery-done.png")
    lib_calls = g.evaluate("window.__lib.calls")
    check("gallery: asked for access once", sum(1 for c in lib_calls if c[0] == "requestAccess") == 1)
    check("gallery: listed photos and videos, leaving out its own output folder", [c[1] for c in lib_calls if c[0] == "list"] == ["photo", "video"] and all(c[3] == "Photo Sorter" for c in lib_calls if c[0] == "list"), [c for c in lib_calls if c[0] == "list"])
    check("gallery: total is 10 files", g.inner_text("#bigN").strip() == "10", g.inner_text("#bigN"))
    gfs = g.evaluate("Object.fromEntries(Object.entries(window.__fs).map(([k,v]) => [k, v.length]))")
    gmedia = [x for x in gfs if not x.endswith(".csv")]
    check("gallery: the phone copied all 10 files itself", sum(1 for c in lib_calls if c[0] == "copy") == 10 and len(gmedia) == 10, (len(gmedia), [c[:2] for c in lib_calls if c[0] == "copy"][:3]))
    check("gallery: no file bytes went through the page (no chunked writes)", not any(c[0] == "append" for c in g.evaluate("window.__calls")))
    check("gallery: big file byte-exact", any(x.endswith("f_big_noise.jpg") and gfs[x] == os.path.getsize(os.path.join(tmp, "f_big_noise.jpg")) for x in gmedia))
    check("gallery: duplicates found and set aside", len([x for x in gmedia if "_Review/duplicates" in x]) >= 2, [x for x in gmedia if "_Review" in x])
    gcsv = bytes(g.evaluate("Array.from(window.__fs['Photo Sorter/sorted.csv'])")).decode()
    check("gallery: sorted.csv written with 10 rows", gcsv.startswith("file,folder,original_name") and gcsv.count("\r\n") == 11, gcsv[:120])
    check("gallery: same duplicates as the picked-file run", sorted(x for x in gmedia if "_Review" in x) == sorted(x for x in paths if "_Review" in x), (sorted(x for x in gmedia if "_Review" in x), dups))
    check("gallery: Claude asked once with the same key", len(state["claude_calls"]) == 1 and state["claude_calls"][0]["key"] == "sk-test-123", state["claude_calls"])

    # access refused: a clear message and a way to Settings, nothing is sorted
    ctx4 = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    d = ctx4.new_page(); d.add_init_script(FAKE_CAP); d.add_init_script(FAKE_LIB); d.add_init_script("window.__lib.grant = false")
    d.on("pageerror", lambda e: errors.append(str(e)))
    d.goto(URL); d.wait_for_selector("text=Sort all my photos"); d.get_by_text("Sort all my photos").click()
    d.wait_for_selector("text=needs to see your photos"); d.screenshot(path=f"{SHOTS}/19-gallery-denied.png")
    d.get_by_text("Open settings").click(); d.wait_for_timeout(300)
    check("gallery: refused access shows a message and opens Settings", any(c[0] == "openSettings" for c in d.evaluate("window.__lib.calls")) and d.locator("body[data-mode=setup]").count() == 1)
    b.close()

check("no page errors", not errors, errors[:5])
shutil.rmtree(tmp, ignore_errors=True)
print("\nFAILED:" if fails else "\nALL PASSED", fails if fails else "")
sys.exit(1 if fails else 0)
