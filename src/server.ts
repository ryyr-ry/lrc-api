import {
  hashPartition,
  MAX_SEARCH_LIMIT,
  rpcCall,
  warmRoomRpc,
  currentGeneration,
  generationPhase,
} from "./types";
import {
  TOTAL_ROOMS,
  NUM_GENERATIONS,
  NUM_SUPERS,
  NUM_SUBS,
  NUM_AGGREGATORS,
  WARM_NEXT_FRACTION,
  ROUTE_SWITCH_FRACTION,
  VERSION,
  WARM_CRON_NAME,
} from "./config";
import type { Request as PartyRequest, FetchLobby, Cron, CronLobby, PartyKitServer } from "partykit/server";
import type { ExecutionContext as CFExecutionContext } from "@cloudflare/workers-types";

function jsonResponse(data: unknown, status = 200, cacheTtl = 86400): Response {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (status === 200 && cacheTtl > 0) {
    headers["Cache-Control"] = `public, max-age=${cacheTtl}, s-maxage=${cacheTtl}`;
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function errorResponse(code: number, name: string, message: string): Response {
  return jsonResponse({ code, name, message }, code, 0);
}

function chunkRoomId(gen: number, roomIdx: number): string {
  return `chunk-${gen}-${roomIdx}`;
}

interface SearchEnvelope {
  results: unknown[];
  errors: number;
}

function parseEnvelope(body: string): SearchEnvelope {
  try {
    const parsed = JSON.parse(body) as SearchEnvelope;
    if (Array.isArray(parsed.results) && typeof parsed.errors === "number") {
      return parsed;
    }
  } catch {}
  try {
    const arr = JSON.parse(body);
    if (Array.isArray(arr)) {
      return { results: arr, errors: 0 };
    }
  } catch {}
  return { results: [], errors: 1 };
}

async function callChunk(
  lobby: FetchLobby,
  gen: number,
  roomIdx: number,
  route: string,
  params: Record<string, string>,
  timeoutMs = 30000
): Promise<{ status: number; body: string }> {
  const stub = lobby.parties.chunk.get(chunkRoomId(gen, roomIdx));
  try {
    return await rpcCall(stub, route, params, timeoutMs);
  } catch {
    return { status: 503, body: JSON.stringify({ code: 503, name: "NotReady", message: "chunk room unavailable" }) };
  }
}

async function handleApiGet(
  req: PartyRequest,
  lobby: FetchLobby
): Promise<Response> {
  const url = new URL(req.url);
  const trackName = url.searchParams.get("track_name");
  const artistName = url.searchParams.get("artist_name");
  const albumName = url.searchParams.get("album_name");
  const durationStr = url.searchParams.get("duration");

  if (!trackName || !artistName) {
    return errorResponse(400, "BadRequest", "track_name and artist_name are required");
  }

  const duration = durationStr ? parseFloat(durationStr) : null;

  const params: Record<string, string> = {
    track_name: trackName,
    artist_name: artistName,
  };
  if (albumName) params.album_name = albumName;
  if (duration !== null) params.duration = String(duration);

  const now = Date.now();
  const gen = currentGeneration(now);
  const roomIdx = hashPartition(artistName, trackName, TOTAL_ROOMS);

  const rpcRes = await callChunk(lobby, gen, roomIdx, "get", params);
  if (rpcRes.status === 404) {
    return errorResponse(404, "TrackNotFound", "Failed to find specified track");
  }
  if (rpcRes.status === 503) {
    const prevGen = (gen - 1 + NUM_GENERATIONS) % NUM_GENERATIONS;
    const prevRes = await callChunk(lobby, prevGen, roomIdx, "get", params);
    if (prevRes.status === 404) {
      return errorResponse(404, "TrackNotFound", "Failed to find specified track");
    }
    if (prevRes.status !== 200) {
      return errorResponse(503, "NotReady", "Service temporarily unavailable");
    }
    return new Response(prevRes.body, {
      status: prevRes.status,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(rpcRes.body, {
    status: rpcRes.status,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleApiGetById(
  req: PartyRequest,
  lobby: FetchLobby
): Promise<Response> {
  const url = new URL(req.url);
  const idMatch = url.pathname.match(/^\/api\/get\/(\d+)$/);
  if (!idMatch) {
    return errorResponse(400, "BadRequest", "Invalid track ID");
  }
  const id = parseInt(idMatch[1], 10);
  if (isNaN(id) || id < 1) {
    return errorResponse(400, "BadRequest", "Invalid track ID");
  }

  const indexStub = lobby.parties.index.get("index-0");
  let indexRpc;
  try {
    indexRpc = await rpcCall(indexStub, "lookup", { id: String(id) });
  } catch {
    return errorResponse(503, "NotReady", "Index not ready");
  }
  if (indexRpc.status === 400) {
    return errorResponse(404, "TrackNotFound", "Failed to find specified track");
  }
  if (indexRpc.status !== 200) {
    return errorResponse(503, "NotReady", "Index lookup failed");
  }
  const indexData = JSON.parse(indexRpc.body) as { chunk: number };
  const chunkIdx = indexData.chunk;
  if (typeof chunkIdx !== "number" || isNaN(chunkIdx) || chunkIdx < 0) {
    return errorResponse(404, "TrackNotFound", "Failed to find specified track");
  }

  const gen = currentGeneration(Date.now());
  const chunkStub = lobby.parties.chunk.get(chunkRoomId(gen, chunkIdx));
  const chunkRpc = await rpcCall(chunkStub, "get-by-id", { id: String(id) });
  if (chunkRpc.status === 404) {
    return errorResponse(404, "TrackNotFound", "Failed to find specified track");
  }
  if (chunkRpc.status === 503) {
    return errorResponse(503, "NotReady", "Chunk room not ready");
  }
  return new Response(chunkRpc.body, {
    status: chunkRpc.status,
    headers: { "Content-Type": "application/json" },
  });
}

async function searchTree(
  lobby: FetchLobby,
  gen: number,
  route: "search" | "search-lyrics",
  params: Record<string, string>
): Promise<SearchEnvelope> {
  const superParty = lobby.parties.aggregator;
  const superCalls: Promise<{ status: number; body: string } | null>[] = [];
  for (let j = 0; j < NUM_SUPERS; j++) {
    superCalls.push(
      rpcCall(superParty.get(`super-${gen}-${j}`), route, params, 60000).catch(() => null)
    );
  }
  const responses = await Promise.all(superCalls);
  const results: unknown[] = [];
  let errors = 0;
  for (const res of responses) {
    if (res && res.status === 200) {
      const env = parseEnvelope(res.body);
      results.push(...env.results);
      errors += env.errors;
    } else {
      errors++;
    }
  }
  return { results, errors };
}

async function handleApiSearch(
  req: PartyRequest,
  lobby: FetchLobby
): Promise<Response> {
  const url = new URL(req.url);
  const q = url.searchParams.get("q");
  const trackName = url.searchParams.get("track_name");
  const artistName = url.searchParams.get("artist_name");
  const albumName = url.searchParams.get("album_name");
  const limitStr = url.searchParams.get("limit");
  const limit = Math.min(Math.max(parseInt(limitStr || "20", 10) || 20, 1), MAX_SEARCH_LIMIT);

  if (!q && !trackName) {
    return jsonResponse([]);
  }

  const params: Record<string, string> = { limit: String(limit) };
  if (q) params.q = q;
  if (trackName) params.track_name = trackName;
  if (artistName) params.artist_name = artistName;
  if (albumName) params.album_name = albumName;

  const now = Date.now();
  const gen = currentGeneration(now);

  let env = await searchTree(lobby, gen, "search", params);
  if (env.errors > 0) {
    const prevGen = (gen - 1 + NUM_GENERATIONS) % NUM_GENERATIONS;
    const prevEnv = await searchTree(lobby, prevGen, "search", params);
    if (prevEnv.errors < env.errors) {
      env = prevEnv;
    }
  }

  if (env.errors > 0 && env.results.length === 0) {
    return errorResponse(503, "NotReady", "Search rooms not ready");
  }

  env.results.sort((a, b) => (a as { id: number }).id - (b as { id: number }).id);
  return jsonResponse(env.results.slice(0, limit));
}

async function handleApiSearchLyrics(
  req: PartyRequest,
  lobby: FetchLobby
): Promise<Response> {
  const url = new URL(req.url);
  const q = url.searchParams.get("q");
  const limitStr = url.searchParams.get("limit");
  const limit = Math.min(Math.max(parseInt(limitStr || "20", 10) || 20, 1), MAX_SEARCH_LIMIT);

  if (!q) {
    return errorResponse(400, "BadRequest", "q parameter is required");
  }

  const params: Record<string, string> = { q, limit: String(limit) };

  const now = Date.now();
  const gen = currentGeneration(now);

  let env = await searchTree(lobby, gen, "search-lyrics", params);
  if (env.errors > 0) {
    const prevGen = (gen - 1 + NUM_GENERATIONS) % NUM_GENERATIONS;
    const prevEnv = await searchTree(lobby, prevGen, "search-lyrics", params);
    if (prevEnv.errors < env.errors) {
      env = prevEnv;
    }
  }

  if (env.errors > 0 && env.results.length === 0) {
    return errorResponse(503, "NotReady", "Search rooms not ready");
  }

  env.results.sort((a, b) => (a as { id: number }).id - (b as { id: number }).id);
  return jsonResponse(env.results.slice(0, limit));
}

function handlePostEndpoint(): Response {
  return new Response(
    JSON.stringify({
      code: 405,
      name: "MethodNotAllowed",
      message: "This is a read-only edge API. Please use the official LRCLIB API at https://lrclib.net for this endpoint.",
    }),
    { status: 405, headers: { "Content-Type": "application/json" } }
  );
}

async function warmGeneration(lobby: CronLobby, gen: number, deadlineMs: number, rotateBy: number): Promise<void> {
  const warmBatch = 32;
  const chunkParty = lobby.parties.chunk;
  const total = TOTAL_ROOMS;

  const order: number[] = [];
  for (let i = 0; i < total; i++) {
    order.push((i + rotateBy) % total);
  }

  for (let i = 0; i < total; i += warmBatch) {
    if (Date.now() > deadlineMs) return;
    const batch: Promise<void>[] = [];
    for (let j = i; j < Math.min(i + warmBatch, total); j++) {
      batch.push(warmRoomRpc(chunkParty.get(chunkRoomId(gen, order[j]))));
    }
    await Promise.all(batch);
  }

  if (Date.now() > deadlineMs) return;

  const aggParty = lobby.parties.aggregator;
  const aggBatch: Promise<void>[] = [];
  for (let j = 0; j < NUM_SUPERS; j++) {
    aggBatch.push(warmRoomRpc(aggParty.get(`super-${gen}-${j}`)));
  }
  for (let j = 0; j < NUM_SUBS; j++) {
    aggBatch.push(warmRoomRpc(aggParty.get(`sub-${gen}-${j}`)));
  }
  for (let j = 0; j < NUM_AGGREGATORS; j++) {
    aggBatch.push(warmRoomRpc(aggParty.get(`agg-${gen}-${j}`)));
  }
  await Promise.all(aggBatch);
}

export default {
  async onFetch(req: PartyRequest, lobby: FetchLobby, ctx: CFExecutionContext): Promise<Response | null> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/api/get" && req.method === "GET") {
      const cacheKey = new Request(req.url, req);
      const cached = await caches.default.match(cacheKey);
      if (cached) return cached;
      const res = await handleApiGet(req, lobby);
      if (res.status === 200) {
        ctx.waitUntil(caches.default.put(cacheKey, res.clone()));
      }
      return res;
    }

    if (path.match(/^\/api\/get\/\d+$/) && req.method === "GET") {
      const cacheKey = new Request(req.url, req);
      const cached = await caches.default.match(cacheKey);
      if (cached) return cached;
      const res = await handleApiGetById(req, lobby);
      if (res.status === 200) {
        ctx.waitUntil(caches.default.put(cacheKey, res.clone()));
      }
      return res;
    }

    if (path === "/api/search" && req.method === "GET") {
      const cacheKey = new Request(req.url, req);
      const cached = await caches.default.match(cacheKey);
      if (cached) return cached;
      const res = await handleApiSearch(req, lobby);
      if (res.status === 200) {
        ctx.waitUntil(caches.default.put(cacheKey, res.clone()));
      }
      return res;
    }

    if (path === "/api/search-lyrics" && req.method === "GET") {
      const cacheKey = new Request(req.url, req);
      const cached = await caches.default.match(cacheKey);
      if (cached) return cached;
      const res = await handleApiSearchLyrics(req, lobby);
      if (res.status === 200) {
        ctx.waitUntil(caches.default.put(cacheKey, res.clone()));
      }
      return res;
    }

    if (path === "/api/publish" || path === "/api/flag" || path === "/api/request-challenge") {
      return handlePostEndpoint();
    }

    if (path === "/" || path === "/health") {
      return jsonResponse({ status: "ok", version: VERSION }, 200, 60);
    }

    return errorResponse(404, "NotFound", "Endpoint not found");
  },

  async onCron(cron: Cron, lobby: CronLobby): Promise<void> {
    if (cron.name !== WARM_CRON_NAME) return;
    const now = Date.now();
    const gen = currentGeneration(now);
    const phase = generationPhase(now, WARM_NEXT_FRACTION, ROUTE_SWITCH_FRACTION);
    const deadline = now + 50 * 1000;

    const minuteOfHour = new Date(now).getMinutes();
    const rotateBy = (minuteOfHour * 64) % TOTAL_ROOMS;

    await warmGeneration(lobby, gen, deadline, rotateBy);

    if (phase !== "stable" && Date.now() <= deadline) {
      const nextGen = (gen + 1) % NUM_GENERATIONS;
      await warmGeneration(lobby, nextGen, deadline, rotateBy);
    }

    if (Date.now() <= deadline) {
      const indexParty = lobby.parties.index;
      await warmRoomRpc(indexParty.get("index-0"));
    }
  },
} satisfies PartyKitServer;