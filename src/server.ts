import { hashPartition, MAX_SEARCH_LIMIT, rpcCall, warmRoom } from "./types";
import { TOTAL_ROOMS, NUM_SUPERS, NUM_AGGREGATORS } from "./config";
import type { Request as PartyRequest, FetchLobby, Cron, CronLobby, PartyKitServer } from "partykit/server";
import type { ExecutionContext as CFExecutionContext } from "@cloudflare/workers-types";

function getSuperId(query: string): string {
  let hash = 0;
  for (let i = 0; i < query.length; i++) {
    hash = ((hash << 5) - hash + query.charCodeAt(i)) | 0;
  }
  return `super-${Math.abs(hash) % NUM_SUPERS}`;
}

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

async function handleApiGet(
  req: PartyRequest,
  lobby: FetchLobby,
  config: { totalRooms: number }
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

  const chunkIndex = hashPartition(artistName, trackName, config.totalRooms);
  const chunkRoomId = `chunk-${chunkIndex}`;
  const chunkStub = lobby.parties.chunk.get(chunkRoomId);

  const params: Record<string, string> = {
    track_name: trackName,
    artist_name: artistName,
  };
  if (albumName) params.album_name = albumName;
  if (duration !== null) params.duration = String(duration);

  const rpcRes = await rpcCall(chunkStub, "get", params);
  if (rpcRes.status === 404) {
    return errorResponse(404, "TrackNotFound", "Failed to find specified track");
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
  const indexRpc = await rpcCall(indexStub, "lookup", { id: String(id) });
  if (indexRpc.status !== 200) {
    return errorResponse(404, "TrackNotFound", "Failed to find specified track");
  }
  const indexData = JSON.parse(indexRpc.body) as { chunk: number };
  const chunkIdx = indexData.chunk;
  if (typeof chunkIdx !== "number" || isNaN(chunkIdx) || chunkIdx < 0) {
    return errorResponse(404, "TrackNotFound", "Failed to find specified track");
  }
  const chunkStub = lobby.parties.chunk.get(`chunk-${chunkIdx}`);
  const chunkRpc = await rpcCall(chunkStub, "get-by-id", { id: String(id) });
  return new Response(chunkRpc.body, {
    status: chunkRpc.status,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleApiSearch(
  req: PartyRequest,
  lobby: FetchLobby,
  config: { totalRooms: number }
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

  const query = q || `${trackName || ""} ${artistName || ""} ${albumName || ""}`.trim();
  const superId = getSuperId(query);
  const superStub = lobby.parties.aggregator.get(superId);

  const params: Record<string, string> = { limit: String(limit) };
  if (q) params.q = q;
  if (trackName) params.track_name = trackName;
  if (artistName) params.artist_name = artistName;
  if (albumName) params.album_name = albumName;

  const rpcRes = await rpcCall(superStub, "search", params, 60000);
  return new Response(rpcRes.body, {
    status: rpcRes.status,
    headers: { "Content-Type": "application/json" },
  });
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

  const superId = getSuperId(q);
  const superStub = lobby.parties.aggregator.get(superId);
  const rpcRes = await rpcCall(superStub, "search-lyrics", { q, limit: String(limit) }, 60000);
  return new Response(rpcRes.body, {
    status: rpcRes.status,
    headers: { "Content-Type": "application/json" },
  });
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

const CONFIG = {
  totalRooms: TOTAL_ROOMS,
};

export default {
  async onFetch(req: PartyRequest, lobby: FetchLobby, ctx: CFExecutionContext): Promise<Response | null> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/api/get" && req.method === "GET") {
      const cacheKey = new Request(req.url, req);
      const cached = await caches.default.match(cacheKey);
      if (cached) return cached;
      const res = await handleApiGet(req, lobby, CONFIG);
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
      const res = await handleApiSearch(req, lobby, CONFIG);
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
      return jsonResponse({ status: "ok", version: "0.1.0" }, 200, 60);
    }

    return errorResponse(404, "NotFound", "Endpoint not found");
  },

  async onCron(cron: Cron, lobby: CronLobby): Promise<void> {
    if (cron.name !== "warm") return;
    const batchSize = 6;

    const chunkParty = lobby.parties.chunk;
    for (let i = 0; i < CONFIG.totalRooms; i += batchSize) {
      const batch: Promise<void>[] = [];
      for (let j = i; j < Math.min(i + batchSize, CONFIG.totalRooms); j++) {
        batch.push(warmRoom(chunkParty.get(`chunk-${j}`)));
      }
      await Promise.all(batch);
    }

    const aggParty = lobby.parties.aggregator;
    const totalAgg = NUM_SUPERS + NUM_AGGREGATORS;
    for (let i = 0; i < totalAgg; i += batchSize) {
      const batch: Promise<void>[] = [];
      for (let j = i; j < Math.min(i + batchSize, totalAgg); j++) {
        if (j < NUM_SUPERS) {
          batch.push(warmRoom(aggParty.get(`super-${j}`)));
        } else {
          batch.push(warmRoom(aggParty.get(`agg-${j - NUM_SUPERS}`)));
        }
      }
      await Promise.all(batch);
    }

    const indexParty = lobby.parties.index;
    await warmRoom(indexParty.get("index-0"));
  },
} satisfies PartyKitServer;
