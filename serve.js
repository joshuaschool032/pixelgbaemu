#!/usr/bin/env node
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const port = Number.parseInt(process.argv[2] || "8080", 10);
const host = process.argv[3] || "127.0.0.1";
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("Usage: node serve.js [port] [host]");
  process.exit(1);
}

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".data": "application/octet-stream",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

const server = http.createServer((request, response) => {
  if (!request.url || !["GET", "HEAD"].includes(request.method)) {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end("Method not allowed");
    return;
  }

  let pathname;
  try { pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname); }
  catch { response.writeHead(400); response.end("Bad request"); return; }
  if (pathname === "/") pathname = "/index.html";

  const filename = path.resolve(root, "." + pathname);
  if (filename !== root && !filename.startsWith(root + path.sep)) {
    response.writeHead(403); response.end("Forbidden"); return;
  }

  fs.stat(filename, (statError, stat) => {
    if (statError || !stat.isFile()) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    response.writeHead(200, {
      "Content-Type": types[path.extname(filename).toLowerCase()] || "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
    });
    if (request.method === "HEAD") response.end();
    else fs.createReadStream(filename).pipe(response);
  });
});

server.on("error", (error) => {
  console.error(`Could not start PixelGBA on ${host}:${port}: ${error.message}`);
  process.exitCode = 1;
});
server.listen(port, host, () => console.log(`PixelGBA: http://${host}:${port}/`));
