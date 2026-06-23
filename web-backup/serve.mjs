// web/serve.mjs — tiny zero-dependency static file server for the TasteLoop demo.
// Serves the web/ directory on http://localhost:8080 using only built-in modules.
// Run with:  npm start   (or  node web/serve.mjs )

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname; // serve the web/ directory
const PORT = Number(process.env.PORT) || 8080;

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

function contentTypeFor(filePath) {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Cache-Control": "no-cache", // demo: always reflect latest snapshots/events
    ...headers,
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  try {
    // Parse + decode the URL path, strip query string.
    const rawPath = decodeURIComponent((req.url || "/").split("?")[0]);
    let urlPath = rawPath === "/" ? "/index.html" : rawPath;

    // Resolve against ROOT and guard against path traversal.
    const resolved = path.normalize(path.join(ROOT, urlPath));
    if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) {
      return send(res, 403, "403 Forbidden", { "Content-Type": "text/plain; charset=utf-8" });
    }

    fs.stat(resolved, (err, stat) => {
      if (err) {
        return send(res, 404, "404 Not Found: " + urlPath, {
          "Content-Type": "text/plain; charset=utf-8",
        });
      }

      // If a directory was requested, serve its index.html.
      const target = stat.isDirectory() ? path.join(resolved, "index.html") : resolved;

      fs.readFile(target, (readErr, data) => {
        if (readErr) {
          return send(res, 404, "404 Not Found: " + urlPath, {
            "Content-Type": "text/plain; charset=utf-8",
          });
        }
        send(res, 200, data, { "Content-Type": contentTypeFor(target) });
      });
    });
  } catch {
    send(res, 500, "500 Internal Server Error", { "Content-Type": "text/plain; charset=utf-8" });
  }
});

server.listen(PORT, () => {
  console.log(`TasteLoop demo serving ${ROOT}`);
  console.log(`  ->  http://localhost:${PORT}`);
});
