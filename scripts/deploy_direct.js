#!/usr/bin/env node
// Direct PartyKit deploy without the CLI. Replicates cli.tsx deploy():
// - esbuild bundle of main + parties
// - assets enumeration with SHA-1 hashes
// - prepare_assets / POST assets split into <=500-file, <=95MB batches
// - PUT uploads with bounded concurrency and retries
// - final deploy POST with code, parties, crons, staticAssetsManifest
// Run: PARTYKIT_TOKEN=... PARTYKIT_LOGIN=... node scripts/deploy_direct.js
const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const crypto = require("node:crypto");

const API_BASE = "https://api.partykit.dev";
const CLERK_BASE = "https://clerk.partykit.io";
const CLIENT_TOKEN = process.env.PARTYKIT_TOKEN || "";
const LOGIN = process.env.PARTYKIT_LOGIN || "";
const BATCH_MAX_FILES = 500;
const BATCH_MAX_BYTES = 95 * 1024 * 1024;
const PUT_CONCURRENCY = 8;
const MANIFEST_CONCURRENCY = 4;

const configPath = path.resolve("partykit.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const projectName = config.name;
const mainPath = path.resolve(config.main);
const assetsPath = path.resolve(
  typeof config.serve === "string" ? config.serve : config.serve.path
);

function log(line) {
  console.log(line);
}

function httpsRequest(method, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(API_BASE + urlPath);
    const req = https.request(
      target,
      { method, headers },
      (res) => {
        let buf = Buffer.alloc(0);
        res.on("data", (c) => (buf = Buffer.concat([buf, c])));
        res.on("end", () => {
          resolve({ status: res.statusCode, body: buf });
        });
      }
    );
    req.on("error", (err) => reject(err));
    if (body) req.write(body);
    req.end();
  });
}

let sessionToken = null;
let sessionTokenAt = 0;

async function clerkFetch(method, urlPath) {
  return new Promise((resolve, reject) => {
    const target = new URL(CLERK_BASE + urlPath);
    target.searchParams.set("_is_native", "1");
    const req = https.request(
      target,
      {
        method,
        headers: {
          Authorization: CLIENT_TOKEN,
          "User-Agent": "lrc-deploy-direct",
        },
      },
      (res) => {
        let buf = Buffer.alloc(0);
        res.on("data", (c) => (buf = Buffer.concat([buf, c])));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(buf.toString("utf8")) });
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function getSessionToken() {
  const now = Date.now();
  if (sessionToken && now - sessionTokenAt < 30000) {
    return sessionToken;
  }
  const clientRes = await clerkFetch("GET", "/v1/client");
  const sessionId =
    clientRes.json?.response?.last_active_session_id ||
    clientRes.json?.client?.sessions?.[0]?.id;
  if (!sessionId) {
    throw new Error("no active clerk session");
  }
  const tokenRes = await clerkFetch("POST", `/v1/client/sessions/${sessionId}/tokens`);
  if (tokenRes.status !== 200 || !tokenRes.json?.jwt) {
    throw new Error(`clerk token fetch failed: ${tokenRes.status}`);
  }
  sessionToken = tokenRes.json.jwt;
  sessionTokenAt = now;
  return sessionToken;
}

async function apiRequest(method, urlPath, headers, body) {
  let lastRes = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    let authHeaders = headers || {};
    try {
      const token = await getSessionToken();
      authHeaders = {
        Accept: "application/json",
        "User-Agent": "partykit/0.0.115",
        "X-PartyKit-Version": "0.0.115",
        "X-PartyKit-User-Type": "clerk",
        ...authHeaders,
        Authorization: `Bearer ${token}`,
      };
    } catch (e) {
      log(`token refresh failed: ${e.message}`);
    }
    try {
      lastRes = await httpsRequest(method, urlPath, authHeaders, body);
    } catch (err) {
      log(`request error ${method} ${urlPath}: ${err.message}`);
      lastRes = { status: 0, body: Buffer.from(err.message) };
    }
    if (lastRes.status === 401) {
      sessionToken = null;
      log(`401 on ${method} ${urlPath}, refreshing token and retrying (attempt ${attempt + 1}/5)`);
      continue;
    }
    if (lastRes.status === 429 || lastRes.status >= 500 || lastRes.status === 0) {
      const backoff = 1000 * Math.pow(2, attempt) + Math.random() * 500;
      log(`retryable ${lastRes.status} on ${method} ${urlPath}, waiting ${Math.round(backoff)}ms`);
      await new Promise((r) => setTimeout(r, backoff));
      continue;
    }
    return lastRes;
  }
  return lastRes;
}

function findAllFiles(root) {
  const results = [];
  const dirs = [root];
  while (dirs.length > 0) {
    const dir = dirs.pop();
    for (const entry of fs.readdirSync(dir)) {
      if (entry.startsWith(".")) continue;
      const full = path.join(dir, entry);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        if (entry === "node_modules") continue;
        dirs.push(full);
      } else {
        results.push(full);
      }
    }
  }
  return results;
}

function buildAssetManifest(includeAssetInfo = true) {
  const manifest = { devServer: "", assets: {}, assetInfo: {} };
  for (const filePath of findAllFiles(assetsPath)) {
    const rel = path.relative(assetsPath, filePath).replace(/\\/g, "/");
    const fileSize = fs.statSync(filePath).size;
    const fileHash = crypto
      .createHash("sha1")
      .update(fs.readFileSync(filePath))
      .digest("hex");
    const base = path.basename(rel, path.extname(rel));
    const ext = path.extname(rel);
    const fileName = `${base}-${fileHash}${ext}`;
    manifest.assets[rel] = fileName;
    if (includeAssetInfo) {
      manifest.assetInfo[rel] = {
        fileHash,
        fileSize,
        fileName: `${base}${ext}`,
      };
    }
  }
  return manifest;
}

function splitIntoBatches(manifest) {
  const keys = Object.keys(manifest.assets);
  const batches = [];
  let current = [];
  let bytes = 0;
  for (const k of keys) {
    const size = manifest.assetInfo[k]?.fileSize || 0;
    if (
      current.length > 0 &&
      (current.length >= BATCH_MAX_FILES || bytes + size > BATCH_MAX_BYTES)
    ) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(k);
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

async function postManifestBatches(endpoint, manifest) {
  const batches = splitIntoBatches(manifest);
  log(`manifest ${endpoint}: ${Object.keys(manifest.assets).length} assets, ${batches.length} batches`);
  let index = 0;
  const results = new Array(batches.length);
  let firstError = null;

  async function worker() {
    while (firstError === null) {
      const idx = index++;
      if (idx >= batches.length) return;
      const chunkKeys = batches[idx];
      const chunk = {
        ...manifest,
        assets: {},
        assetInfo: {},
      };
      for (const k of chunkKeys) {
        chunk.assets[k] = manifest.assets[k];
        if (manifest.assetInfo[k]) chunk.assetInfo[k] = manifest.assetInfo[k];
      }
      const res = await apiRequest(
        "POST",
        endpoint,
        { "Content-Type": "application/json" },
        Buffer.from(JSON.stringify(chunk))
      );
      results[idx] = res;
      log(`  batch ${idx + 1}/${batches.length} (${chunkKeys.length} files) -> ${res.status}`);
      if (res.status >= 400) {
        firstError = res;
      }
    }
  }

  const workers = [];
  for (let w = 0; w < Math.min(MANIFEST_CONCURRENCY, batches.length); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  if (firstError) return firstError;
  return { status: 200, body: Buffer.from('{"success":true}') };
}

async function uploadAsset(rel, fileName, filePath) {
  const body = fs.readFileSync(filePath);
  const res = await apiRequest(
    "PUT",
    `/parties/${LOGIN}/${projectName}/assets`,
    {
      "Content-Type": "application/octet-stream",
      "X-PartyKit-Asset-Name": fileName,
    },
    body
  );
  if (res.status >= 400) {
    log(`PUT failed ${rel}: ${res.status} ${res.body.toString("utf8").slice(0, 120)}`);
    return false;
  }
  return true;
}

async function uploadAllAssets(manifest) {
  const entries = Object.entries(manifest.assets);
  log(`uploading ${entries.length} assets, concurrency ${PUT_CONCURRENCY}`);
  let index = 0;
  let failures = 0;

  async function worker() {
    while (true) {
      const idx = index++;
      if (idx >= entries.length) return;
      const [rel, fileName] = entries[idx];
      const filePath = path.join(assetsPath, rel);
      const ok = await uploadAsset(rel, fileName, filePath);
      if (!ok) failures += 1;
      if ((idx + 1) % 500 === 0) {
        log(`  uploaded ${idx + 1}/${entries.length}`);
      }
    }
  }

  const workers = [];
  for (let w = 0; w < Math.min(PUT_CONCURRENCY, entries.length); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  log(`upload complete, ${failures} failures out of ${entries.length}`);
  return failures === 0;
}

function buildBundle() {
  return new Promise((resolve, reject) => {
    const esbuild = require("esbuild");
    const { env, nodeless } = require("unenv");
    const nodePath = require("node:path");
    const partyParts = config.parties || {};
    const partyImports = Object.entries(partyParts)
      .map(([name, p]) => {
        const abs = path.resolve(path.dirname(configPath), p);
        return `import ${name}Party from '${abs.replace(/\\/g, "/")}'; export const ${name} = ${name}Party;`;
      })
      .join("\n");
    const contents = `
import WorkerSpec from '${mainPath.replace(/\\/g, "/")}'; export default WorkerSpec;
${partyImports}
`;
    const injectPath = path.join(
      process.cwd(),
      "node_modules",
      "partykit",
      "inject-process.js"
    );
    const baseNodeBuiltins = [
      "assert", "async_hooks", "buffer", "diagnostics_channel", "events",
      "path", "stream", "string_decoder", "util", "crypto",
    ];
    const baseNodePreset = {
      alias: baseNodeBuiltins.reduce((acc, module) => {
        return {
          ...acc,
          [module]: `partykit-exposed-node-${module}`,
          [`node:${module}`]: `partykit-exposed-node-${module}`,
        };
      }, {}),
      inject: { Buffer: "node:buffer" },
      polyfill: [],
      external: baseNodeBuiltins.map((builtin) => `node:${builtin}`),
    };
    const { alias, inject, external } = env(nodeless, baseNodePreset);
    const aliasAbsolute = {};
    for (const [module, unresolvedAlias] of Object.entries(alias)) {
      if (baseNodeBuiltins.includes(module)) continue;
      try {
        aliasAbsolute[module] = require.resolve(unresolvedAlias).replace(/\.cjs$/, ".mjs");
      } catch (e) {
        // ignore aliases not installed in this project
      }
    }
    const ALIAS_RE = new RegExp(`^(${Object.keys(aliasAbsolute).join("|")})$`);
    const plugin = {
      name: "partykit-nodejs-compat",
      setup(build) {
        build.onResolve({ filter: /^cloudflare:/ }, (args) => {
          const cloudflareModuleName = args.path.split(":")[1];
          return {
            path: `partykit-exposed-cloudflare-${cloudflareModuleName}`,
            external: true,
          };
        });
        build.onResolve({ filter: ALIAS_RE }, (args) => {
          return {
            path: aliasAbsolute[args.path],
            external: external.includes(alias[args.path]),
          };
        });
      },
    };
    esbuild
      .build({
        stdin: { contents, resolveDir: process.cwd() },
        format: "esm",
        bundle: true,
        write: false,
        target: "esnext",
        conditions: ["partykit", "workerd", "worker"],
        external: external.concat(baseNodeBuiltins.map((n) => `node:${n}`)),
        inject: [injectPath],
        define: {
          PARTYKIT_HOST: JSON.stringify(
            `${projectName}.${LOGIN}.partykit.dev`
          ),
          PARTYKIT_PROCESS_ENV: '"{}"',
          ...(config.define || {}),
        },
        plugins: [plugin],
      })
      .then((result) => resolve(result.outputFiles[0].text))
      .catch(reject);
  });
}

function buildFinalForm(code, manifest) {
  const { FormData, File } = require("undici");
  const form = new FormData();
  form.set("code", code);
  if (config.parties) {
    form.set("parties", JSON.stringify(Object.keys(config.parties)));
  }
  if (config.crons) {
    form.set("crons", JSON.stringify(config.crons));
  }
  form.set("staticAssetsManifest", JSON.stringify(manifest));
  const baseNodeBuiltins = [
    "assert", "async_hooks", "buffer", "diagnostics_channel", "events",
    "path", "stream", "string_decoder", "util", "crypto",
  ];
  for (const name of baseNodeBuiltins) {
    const fileName = `upload/partykit-exposed-node-${name}`;
    const content = `export * from 'node:${name}';export { default } from 'node:${name}';`;
    form.set(
      fileName,
      new File([content], fileName, { type: "application/javascript+module" })
    );
  }
  for (const cfName of ["email", "sockets"]) {
    const fileName = `upload/partykit-exposed-cloudflare-${cfName}`;
    const content = `export * from 'cloudflare:${cfName}';`;
    form.set(
      fileName,
      new File([content], fileName, { type: "application/javascript+module" })
    );
  }
  return form;
}

async function finalDeployRequest(form) {
  const { fetch } = require("undici");
  const token = await getSessionToken();
  const res = await fetch(
    `${API_BASE}/parties/${LOGIN}/${projectName}`,
    {
      method: "POST",
      body: form,
      headers: {
        Accept: "application/json",
        "User-Agent": "partykit/0.0.115",
        "X-PartyKit-Version": "0.0.115",
        "X-PartyKit-User-Type": "clerk",
        Authorization: `Bearer ${token}`,
      },
    }
  );
  const text = await res.text();
  return { status: res.status, body: Buffer.from(text) };
}

async function main() {
  log(`deploying ${projectName} via direct API`);
  if (!CLIENT_TOKEN || !LOGIN) {
    log("PARTYKIT_TOKEN and PARTYKIT_LOGIN are required");
    process.exit(1);
  }

  log("building bundle...");
  const code = await buildBundle();
  log(`bundle size: ${code.length} bytes`);

  log("building asset manifest...");
  const manifest = buildAssetManifest();
  log(`assets: ${Object.keys(manifest.assets).length} files`);

  log("prepare_assets (split)...");
  const prepRes = await postManifestBatches(
    `/parties/${LOGIN}/${projectName}/prepare_assets`,
    manifest
  );
  if (prepRes.status >= 400) {
    log(`prepare_assets failed: ${prepRes.status} ${prepRes.body.toString("utf8")}`);
    process.exit(1);
  }

  log("uploading assets...");
  const ok = await uploadAllAssets(manifest);
  if (!ok) {
    log("some asset uploads failed");
    process.exit(1);
  }

  log("posting asset index (split)...");
  const indexRes = await postManifestBatches(
    `/parties/${LOGIN}/${projectName}/assets`,
    manifest
  );
  if (indexRes.status >= 400) {
    log(`asset index failed: ${indexRes.status} ${indexRes.body.toString("utf8")}`);
    process.exit(1);
  }

  log("final deploy POST...");
  const slimManifest = buildAssetManifest(false);
  const form = buildFinalForm(code, slimManifest);
  const deployRes = await finalDeployRequest(form);
  log(`deploy response: ${deployRes.status} ${deployRes.body.toString("utf8").slice(0, 300)}`);
  if (deployRes.status >= 400) {
    process.exit(1);
  }
  log(`Deployed to https://${projectName}.${LOGIN}.partykit.dev`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});