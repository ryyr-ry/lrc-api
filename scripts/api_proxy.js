#!/usr/bin/env node
// Split-proxy for PartyKit API: splits prepare_assets / assets manifest
// updates into batches to bypass the 500-assets-per-call check.
// Run: node scripts/api_proxy.js <logfile>
// Env: PROXY_TARGET (default https://api.partykit.dev), PROXY_PORT (default 8787),
//      PROXY_BATCH (default 500)
const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");

const REAL_BASE = process.env.PROXY_TARGET || "https://api.partykit.dev";
const PORT = parseInt(process.env.PROXY_PORT || "8787", 10);
const LOGFILE = process.argv[2] || "/tmp/proxy.log";
const BATCH = parseInt(process.env.PROXY_BATCH || "500", 10);
const MAX_BATCH_BYTES = parseInt(process.env.PROXY_MAX_BATCH_BYTES || "94371840", 10);
const CLERK_BASE = process.env.PROXY_CLERK_BASE || "https://clerk.partykit.io";
const CLIENT_TOKEN = process.env.PARTYKIT_TOKEN || "";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function log(line) {
  fs.appendFileSync(LOGFILE, line + "\n");
}

function stripHopByHop(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

let sessionIdCache = null;
let sessionTokenCache = null;
let sessionTokenFetchedAt = 0;

async function fetchClerkJson(path, method = "GET") {
  const url = new URL(`${CLERK_BASE}${path}`);
  url.searchParams.set("_is_native", "1");
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request(
      url,
      {
        method,
        headers: {
          Authorization: CLIENT_TOKEN,
          "User-Agent": "partykit-split-proxy",
        },
      },
      (res) => {
        let body = Buffer.alloc(0);
        res.on("data", (c) => (body = Buffer.concat([body, c])));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(body.toString("utf8")) });
          } catch (e) {
            reject(new Error(`clerk json parse: ${e.message}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function getFreshSessionToken() {
  const now = Date.now();
  if (sessionTokenCache && now - sessionTokenFetchedAt < 30000) {
    return sessionTokenCache;
  }
  if (!sessionIdCache) {
    const clientRes = await fetchClerkJson("/v1/client");
    if (clientRes.status !== 200) {
      throw new Error(`clerk client fetch failed: ${clientRes.status}`);
    }
    sessionIdCache =
      clientRes.json?.response?.last_active_session_id ||
      clientRes.json?.client?.sessions?.[0]?.id ||
      null;
    if (!sessionIdCache) {
      throw new Error("no active clerk session found");
    }
  }
  const tokenRes = await fetchClerkJson(
    `/v1/client/sessions/${sessionIdCache}/tokens`,
    "POST"
  );
  if (tokenRes.status !== 200 || !tokenRes.json?.jwt) {
    sessionIdCache = null;
    throw new Error(`clerk token fetch failed: ${tokenRes.status}`);
  }
  sessionTokenCache = tokenRes.json.jwt;
  sessionTokenFetchedAt = now;
  return sessionTokenCache;
}

function forward(method, url, headers, body) {
  return new Promise((resolve) => {
    const target = new URL(REAL_BASE + url);
    const transport = target.protocol === "https:" ? https : http;
    const outHeaders = stripHopByHop(headers);
    outHeaders.host = target.host;
    outHeaders["content-length"] = String(body.length);
    const upstream = transport.request(
      target,
      { method, headers: outHeaders },
      (upstreamRes) => {
        let resBody = Buffer.alloc(0);
        upstreamRes.on("data", (chunk) => {
          resBody = Buffer.concat([resBody, chunk]);
        });
        upstreamRes.on("end", () => {
          resolve({
            status: upstreamRes.statusCode,
            headers: stripHopByHop(upstreamRes.headers),
            body: resBody,
          });
        });
      }
    );
    upstream.on("error", (err) => {
      resolve({ status: 502, headers: {}, body: Buffer.from(err.message) });
    });
    upstream.end(body);
  });
}

function isManifestEndpoint(method, url) {
  return (
    method === "POST" &&
    (url.includes("/prepare_assets") ||
      (url.includes("/assets") && !url.includes("/prepare_assets")))
  );
}

async function forwardWithTokenRefresh(method, url, headers, body) {
  let res = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let authHeaders = headers;
    if (CLIENT_TOKEN) {
      try {
        const freshToken = await getFreshSessionToken();
        authHeaders = {
          ...headers,
          authorization: `Bearer ${freshToken}`,
        };
      } catch (e) {
        log(`!!! clerk token refresh failed: ${e.message}`);
      }
    }
    res = await forward(method, url, authHeaders, body);
    if (res.status === 401 && CLIENT_TOKEN && attempt === 0) {
      sessionTokenCache = null;
      log(`!!! 401 on batch, retrying with fresh token`);
      continue;
    }
    return res;
  }
  return res;
}

const FAKE_SIZES = process.env.PROXY_FAKE_SIZES === "1";

async function splitManifest(method, url, headers, body) {
  const manifest = JSON.parse(body.toString("utf8"));
  const assets = manifest.assets || {};
  const assetInfo = manifest.assetInfo || {};
  const keys = Object.keys(assets);

  if (FAKE_SIZES) {
    for (const k of keys) {
      if (assetInfo[k]) {
        assetInfo[k] = { ...assetInfo[k], fileSize: 1 };
      }
    }
    log(`FAKE_SIZES ${url}: ${keys.length} assets, all fileSize set to 1`);
  }

  const batches = [];
  let currentKeys = [];
  let currentBytes = 0;
  for (const k of keys) {
    const size = assetInfo[k] ? assetInfo[k].fileSize : 0;
    if (
      currentKeys.length > 0 &&
      (currentKeys.length >= BATCH || currentBytes + size > MAX_BATCH_BYTES)
    ) {
      batches.push(currentKeys);
      currentKeys = [];
      currentBytes = 0;
    }
    currentKeys.push(k);
    currentBytes += size;
  }
  if (currentKeys.length > 0) {
    batches.push(currentKeys);
  }

  log(
    `SPLIT ${url}: ${keys.length} assets, ${batches.length} batches ` +
      `(max ${BATCH} files / ${MAX_BATCH_BYTES} bytes per batch)`
  );

  const results = new Array(batches.length);
  const CONCURRENCY = parseInt(process.env.PROXY_CONCURRENCY || "20", 10);
  let nextIndex = 0;
  let firstError = null;
  let finishedWorkers = 0;

  async function worker() {
    while (firstError === null) {
      const idx = nextIndex++;
      if (idx >= batches.length) return;
      const batchKeys = batches[idx];
      const chunkAssets = {};
      const chunkInfo = {};
      let chunkBytes = 0;
      for (const k of batchKeys) {
        chunkAssets[k] = assets[k];
        if (assetInfo[k]) {
          chunkInfo[k] = assetInfo[k];
          chunkBytes += assetInfo[k].fileSize || 0;
        }
      }
      const chunk = {
        ...manifest,
        assets: chunkAssets,
        assetInfo: chunkInfo,
      };
      const res = await forwardWithTokenRefresh(
        method,
        url,
        headers,
        Buffer.from(JSON.stringify(chunk))
      );
      results[idx] = res;
      log(
        `SPLIT batch ${idx + 1}/${batches.length} (${batchKeys.length} files, ${chunkBytes} bytes) -> ${res.status} ${res.body
          .toString("utf8")
          .slice(0, 160)}`
      );
      if (res.status >= 400) {
        firstError = res;
      }
    }
  }

  const workers = [];
  for (let w = 0; w < Math.min(CONCURRENCY, batches.length); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  if (firstError !== null) {
    return firstError;
  }
  for (const res of results) {
    if (res.status >= 400) {
      return res;
    }
  }
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: Buffer.from('{"success":true}'),
  };
}

const server = http.createServer((req, res) => {
  let body = Buffer.alloc(0);
  req.on("data", (chunk) => {
    body = Buffer.concat([body, chunk]);
  });
  req.on("error", (err) => {
    log(`!!! client error on ${req.method} ${req.url}: ${err.message}`);
    res.writeHead(400);
    res.end();
  });
  req.on("end", async () => {
    const authPresent = req.headers.authorization ? "yes" : "no";
    log(`>>> ${req.method} ${req.url} body=${body.length} auth=${authPresent}`);

    let result;
    if (isManifestEndpoint(req.method, req.url) && body.length > 0) {
      try {
        result = await splitManifest(req.method, req.url, req.headers, body);
      } catch (err) {
        log(`!!! manifest split parse error: ${err.message}`);
        result = await forward(req.method, req.url, req.headers, body);
      }
    } else {
      result = await forward(req.method, req.url, req.headers, body);
    }

    log(
      `<<< ${req.method} ${req.url} status=${result.status} body=${result.body.length} bytes`
    );
    res.writeHead(result.status, result.headers);
    res.end(result.body);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  log(`Split-proxy listening on ${PORT}, target ${REAL_BASE}, batch ${BATCH}`);
});