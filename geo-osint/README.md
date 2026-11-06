# GEO OSINT - Where am I?

A Geo-OSINT challenge. You get dropped somewhere on Earth in Street View, you can walk and look around, and there is a light hint.
When you know where you are, place a pin on the map. **You must get at least the city right** - the country alone is not enough.

- 3 stages (Easy, Medium, Hard). Solving a stage shows its flag and a **Next stage** button.
- 3 attempts per stage, then a 2-minute lock.
- A wrong guess only tells you "wrong country" or "right country, wrong city" (no distance, so the spot can't be triangulated).
- A stage is solved when the pin is inside the right city (looked up with OpenStreetMap / Nominatim).

## Running

One file, `index.html`. No server and no API key. Host it on any static host (Render Static Site, GitHub Pages, Netlify...)
or locally: `python3 -m http.server` inside this folder.

Live: https://abdalaziz5.onrender.com

## How the stages are protected

Only stage 1's location is in the page. Each stage's flag and the next stage are AES-GCM encrypted
with a key derived (PBKDF2) from that stage's city name, so you can't read later stages from the source
without solving the earlier ones.

To change stages: put them in `tools/stages.json` (kept out of git, same fields as before: lat, lng,
heading, cc, city, hint, flag, level) and run `node tools/build.mjs`. It rewrites the data inside `index.html`.

## Google Maps key (walk limit + no street names)

Set `GMAPS_KEY` near the top of the script in `index.html` to a Google Maps JavaScript API key. With a key:
street names are hidden in Street View, and the player can only walk within `walk` metres of the start
(Easy 200 m, Medium 150 m, Hard 120 m). Without a key the page falls back to the keyless embed (free walking).
Restrict the key in Google Cloud to `https://abdalaziz5.onrender.com/*` - it is visible in the page.

## Notes

- The map uses OpenFreeMap tiles (free, no key) with every label forced to English (or Latin letters), and street names, house numbers and points of interest hidden.
- The current stage's Street View coordinates are visible in DevTools (the iframe needs them). That only spoils the stage you're on, not the later ones.
