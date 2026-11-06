# GEO OSINT - Where am I?

A Geo-OSINT challenge in 3 stages (Easy, Medium, Hard). You get dropped on a street somewhere on Earth.
Walk along it (Forward / Back, or W / S), look around, zoom in, and find clues. When you know where you are,
pin it on the map. **You must get at least the city right** - the country alone is not enough.

- Each stage is one short stretch of street (about 100-250 m). You can't walk anywhere else.
- No street names: not on the map, not printed on the road.
- 3 attempts per stage, then a 2-minute lock. A wrong guess only says "wrong country" or "right country, wrong city".
- Solving a stage shows its flag and a **Next stage** button.

Live: https://abdalaziz5.onrender.com

## How it works

- Free, no keys: street photos come from [Panoramax](https://panoramax.fr) (open licences, credits shown after
  each stage is solved), the map is [OpenFreeMap](https://openfreemap.org) with English-only labels, and the city
  check uses OpenStreetMap's Nominatim.
- Photos are downloaded, resized, stripped of all metadata (no GPS) and saved under random names in `img/`.
  The bottom of each 360 photo is painted over (camera car, uploader logos).
- No coordinates are in the page. Stage 1 is in the clear; each stage's flag, map spot and the whole next
  stage are AES-GCM encrypted with a key unlocked by the right city name (PBKDF2), so later stages can't be
  read from the source.

## Changing the stages

Both files below hold answers and stay out of git.

1. `tools/stages.json`: per stage `level`, `cc` (country code), `cities` (accepted names as Nominatim returns
   them), `hint`, `flag`, and `source` (`collection` id on Panoramax, `from`/`to` photo range, `kind`: `360` or `flat`).
2. `python3 tools/fetch.py` downloads and cleans the photos into `img/` and writes `tools/photos.json`
   (`--dry` just prints how far each stretch goes).
3. `node tools/build.mjs` encrypts everything into `index.html`.
