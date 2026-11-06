"""Download a stage's photos from Panoramax, strip all metadata, and save them under random names.

Usage: python3 tools/fetch.py [--dry]
Reads tools/stages.json (kept out of git: it holds the answers and photo sources),
writes img/*.jpg and tools/photos.json (also kept out of git: it holds coordinates).
Only relative angles between photos end up in the page - never coordinates.
"""
import io, json, math, os, secrets, sys, time, urllib.request
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
IMG = os.path.join(HERE, "..", "img")
DRY = "--dry" in sys.argv

def get(url, tries=6):
    req = urllib.request.Request(url, headers={"User-Agent": "geo-osint-challenge-builder"})
    for t in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                return r.read()
        except OSError:
            if t == tries - 1: raise
            time.sleep(2 ** t)

def items(collection):
    out, url = [], f"https://api.panoramax.xyz/api/collections/{collection}/items?limit=500"
    while url:
        d = json.loads(get(url)); out += d["features"]
        url = next((l["href"] for l in d.get("links", []) if l.get("rel") == "next"), None)
    return sorted(out, key=lambda f: f["properties"].get("geovisio:rank_in_collection", 0))

def bearing(a, b):
    (la1, lo1), (la2, lo2) = [(math.radians(x[1]), math.radians(x[0])) for x in (a, b)]
    y = math.sin(lo2 - lo1) * math.cos(la2)
    x = math.cos(la1) * math.sin(la2) - math.sin(la1) * math.cos(la2) * math.cos(lo2 - lo1)
    return math.degrees(math.atan2(y, x)) % 360

def metres(a, b):
    la1, la2 = math.radians(a[1]), math.radians(b[1]); dl = math.radians(b[0] - a[0])
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin(dl / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(h))

NADIR = 0.76  # cover everything below ~47 degrees down: camera car, logos stamped by the uploader

def cover_nadir(im):
    w, h = im.size; y0 = int(h * NADIR); fade = int(h * 0.02)
    over = Image.new("RGB", (w, h - y0), (27, 31, 36))
    band = im.crop((0, y0 - fade, w, y0))
    grad = Image.linear_gradient("L").resize((w, fade))
    im.paste(Image.composite(Image.new("RGB", (w, fade), (27, 31, 36)), band, grad), (0, y0 - fade))
    im.paste(over, (0, y0))
    return im

def rel(angle):  # -180..180
    return round((angle + 180) % 360 - 180, 1)

stages = json.load(open(os.path.join(HERE, "stages.json")))
os.makedirs(IMG, exist_ok=True)
result = []
for n, s in enumerate(stages, 1):
    src = s["source"]
    feats = items(src["collection"])[src["from"]:src["to"]]
    pts = [f["geometry"]["coordinates"] for f in feats]
    span = max(metres(pts[0], p) for p in pts)
    print(f"stage {n}: {len(feats)} photos, furthest {span:.0f} m from first, kind={src['kind']}")
    if DRY: continue
    photos = []
    for i, f in enumerate(feats):
        p = f["properties"]; az = p.get("view:azimuth") or 0
        url = f["assets"]["hd" if src["kind"] == "360" else "sd"]["href"]
        im = Image.open(io.BytesIO(get(url))).convert("RGB")
        im = im.resize((4096, 2048), Image.LANCZOS) if src["kind"] == "360" else im.resize((1600, round(1600 * im.height / im.width)), Image.LANCZOS)
        if src["kind"] == "360": im = cover_nadir(im)
        name = secrets.token_hex(12) + ".jpg"
        im.save(os.path.join(IMG, name), "JPEG", quality=80, optimize=True, progressive=True)  # no EXIF/XMP kept
        ph = {"f": name, "az": az, "w": im.width, "h": im.height}
        if i + 1 < len(feats): ph["ny"] = rel(bearing(pts[i], pts[i + 1]) - az)
        if i > 0: ph["py"] = rel(bearing(pts[i], pts[i - 1]) - az)
        photos.append(ph)
        print(f"  {i + 1}/{len(feats)} {name} {os.path.getsize(os.path.join(IMG, name)) // 1024} KB")
    mid = pts[0]
    credit = sorted({f["properties"].get("geovisio:producer") or "unknown" for f in feats})
    licence = sorted({f["properties"].get("license") for f in feats})
    result.append({"kind": src["kind"], "photos": photos, "lat": mid[1], "lng": mid[0],
                   "credit": f"Photos by {', '.join(credit)} via Panoramax ({', '.join(licence)})"})
if not DRY:
    json.dump(result, open(os.path.join(HERE, "photos.json"), "w"), indent=1)
    print("wrote tools/photos.json")
