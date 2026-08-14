import { hashPartition, MAX_SEARCH_LIMIT } from "./types";
import { TOTAL_ROOMS } from "./config";
import type { Request as PartyRequest, FetchLobby, Cron, CronLobby, PartyKitServer } from "partykit/server";
import type { ExecutionContext as CFExecutionContext } from "@cloudflare/workers-types";

const NUM_SUPERS = 10;

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

  const params = new URLSearchParams();
  params.set("track_name", trackName);
  params.set("artist_name", artistName);
  if (albumName) params.set("album_name", albumName);
  if (duration !== null) params.set("duration", String(duration));

  const res = await chunkStub.fetch(`/get?${params.toString()}`);
  if (res.status === 404) {
    return errorResponse(404, "TrackNotFound", "Failed to find specified track");
  }
  return res;
}

async function handleApiGetById(
  req: PartyRequest,
  lobby: FetchLobby,
  config: { totalRooms: number }
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

  const superId = getSuperId(String(id));
  const superStub = lobby.parties.aggregator.get(superId);
  return superStub.fetch(`/get-by-id?id=${id}`);
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

  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (trackName) params.set("track_name", trackName);
  if (artistName) params.set("artist_name", artistName);
  if (albumName) params.set("album_name", albumName);
  params.set("limit", String(limit));

  return superStub.fetch(`/search?${params.toString()}`);
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
  return superStub.fetch(`/search-lyrics?q=${encodeURIComponent(q)}&limit=${limit}`);
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
      return handleApiGetById(req, lobby, CONFIG);
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
    const chunkParty = lobby.parties.chunk;
    const batchSize = 6;
    for (let i = 0; i < CONFIG.totalRooms; i += batchSize) {
      const batch: Promise<Response>[] = [];
      for (let j = i; j < Math.min(i + batchSize, CONFIG.totalRooms); j++) {
        batch.push(chunkParty.get(`chunk-${j}`).fetch("/warm"));
      }
      await Promise.all(batch);
    }
  },
} satisfies PartyKitServer;
