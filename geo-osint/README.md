# GEO OSINT #1 - Where am I?

A Geo-OSINT challenge. You get dropped somewhere on Earth in Street View, you can walk and look around, and there is a light hint.
When you know where you are, place a pin on the map. **You must get at least the city right** - the country alone is not enough.

- 3 attempts, then a 2-minute lock.
- A wrong guess only tells you "wrong country" or "right country, wrong city" (no distance, so the spot can't be triangulated).
- You win if the pin is inside the city (checked with OpenStreetMap / Nominatim) or within 6 km of the spot. Then the flag is shown.

## Running

One file, `index.html`. No server and no API key. Host it on any static host (Render Static Site, GitHub Pages, Netlify...)
or locally: `python3 -m http.server` inside this folder.

Live: https://abdalaziz5.onrender.com

## Notes

- Street View is embedded from Google without a key, so players can walk far from the start (limiting the area needs an API key).
- The answer and flag are lightly encoded in the page, but anyone who opens DevTools can read the iframe coordinates. Fine for casual play; a serious CTF needs a server.
