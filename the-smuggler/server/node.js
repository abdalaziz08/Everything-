// Plain Node server (local testing, or any Node host): serves public/ and the /api routes.
//   SMUGGLER_SECRET=... node server/node.js     (PORT defaults to 3000)
import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, extname, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "./instance.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".png": "image/png", ".ico": "image/x-icon" };

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const out = await app.handle(new Request(url, {
        method: req.method, headers: req.headers,
        body: req.method === "POST" ? Buffer.concat(chunks) : undefined,
      }));
      res.writeHead(out.status, Object.fromEntries(out.headers));
      res.end(Buffer.from(await out.arrayBuffer()));
      return;
    }
    const file = normalize(join(ROOT, url.pathname === "/" ? "index.html" : url.pathname));
    if (!file.startsWith(ROOT + sep)) { res.writeHead(403).end(); return; }
    const data = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(data);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(process.env.PORT || 3000, () => console.log("THE SMUGGLER on http://localhost:" + (process.env.PORT || 3000)));
