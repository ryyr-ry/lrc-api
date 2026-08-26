#!/usr/bin/env node
// Observe and forward all PartyKit API requests to api.partykit.dev
// Run: node scripts/api_proxy.js <logfile>
const http = require("node:http");
const fs = require("node:fs");

const REAL_BASE = "https://api.partykit.dev";
const PORT = parseInt(process.env.PROXY_PORT || "8787", 10);
const LOGFILE = process.argv[2] || "/tmp/proxy.log";

function log(line) {
  fs.appendFileSync(LOGFILE, line + "\n");
}

const server = http.createServer((req, res) => {
  let body = Buffer.alloc(0);
  req.on("data", (chunk) => {
    body = Buffer.concat([body, chunk]);
  });
  req.on("end", () => {
    const target = new URL(REAL_BASE + req.url);
    const headers = { ...req.headers };
    headers.host = target.host;

    log(`>>> ${req.method} ${req.url} body=${body.length} bytes`);

    const upstream = http.request(
      target,
      {
        method: req.method,
        headers,
      },
      (upstreamRes) => {
        let resBody = Buffer.alloc(0);
        upstreamRes.on("data", (chunk) => {
          resBody = Buffer.concat([resBody, chunk]);
        });
        upstreamRes.on("end", () => {
          const preview = resBody.toString("utf8").slice(0, 500);
          log(
            `<<< ${req.method} ${req.url} status=${upstreamRes.statusCode} body=${resBody.length} bytes: ${preview}`
          );
          res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
          res.end(resBody);
        });
      }
    );
    upstream.on("error", (err) => {
      log(`!!! ${req.method} ${req.url} error=${err.message}`);
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("proxy error: " + err.message);
    });
    upstream.end(body);
  });
});

server.listen(PORT, () => {
  log(`Proxy listening on ${PORT}`);
});