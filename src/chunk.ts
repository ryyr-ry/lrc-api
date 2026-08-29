import type { LyricRecord, RpcRequest } from "./types";
import {
  prepareInput,
  toApiResponse,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  roomFileUrl,
  fetchRoomFile,
} from "./types";
import { RELEASE_TAGS, LOAD_MAX_ATTEMPTS, LOAD_RETRY_BASE_DELAY_MS } from "./config";
import type { Request as PartyRequest, Room, Server, Connection } from "partykit/server";

export type RoomState = "unloaded" | "loading" | "ready";

export interface RoomFilePayload {
  room_id: number;
  dump_key: string;
  expected_count: number;
  records: LyricRecord[];
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default class ChunkServer implements Server {
  room: Room;
  state: RoomState = "unloaded";
  records: LyricRecord[] = [];
  loadTimeMs = 0;
  lastError = "";
  roomId = -1;
  generation = -1;
  loadAttempts = 0;

  private lruCache = new Map<string, string>();
  private readonly LRU_MAX_BYTES = 20 * 1024 * 1024;
  private lruCacheBytes = 0;
  private inflight = new Map<string, Promise<string>>();
  private loadPromise: Promise<boolean> | null = null;

  constructor(room: Room) {
    this.room = room;
    const match = room.id.match(/^chunk-(\d+)-(\d+)$/);
    if (match) {
      this.generation = parseInt(match[1], 10);
      this.roomId = parseInt(match[2], 10);
    } else {
      this.lastError = `invalid room id: ${room.id}`;
    }
  }

  async onStart() {
    await this.ensureLoaded();
  }

  private async ensureLoaded(): Promise<boolean> {
    if (this.state === "ready") return true;
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.tryLoad();
    try {
      return await this.loadPromise;
    } finally {
      this.loadPromise = null;
    }
  }

  private async tryLoad(): Promise<boolean> {
    if (this.roomId < 0 || this.generation < 0) {
      this.lastError = "invalid room id";
      this.state = "unloaded";
      return false;
    }
    this.state = "loading";
    const t0 = Date.now();

    for (let attempt = 0; attempt < LOAD_MAX_ATTEMPTS; attempt++) {
      try {
        const fileUrl = roomFileUrl(this.roomId, RELEASE_TAGS);
        const res = await fetchRoomFile(fileUrl);
        if (!res.ok) {
          this.lastError = `fetch ${fileUrl} -> ${res.status}`;
          throw new Error(this.lastError);
        }
        const text = await res.text();
        let payload: RoomFilePayload;
        try {
          payload = JSON.parse(text) as RoomFilePayload;
        } catch {
          this.lastError = `invalid json from room file (room ${this.roomId})`;
          throw new Error(this.lastError);
        }
        if (!Array.isArray(payload.records)) {
          this.lastError = "payload.records is not an array";
          throw new Error(this.lastError);
        }
        if (payload.records.length !== payload.expected_count) {
          this.lastError = `count mismatch: ${payload.records.length} != ${payload.expected_count}`;
          throw new Error(this.lastError);
        }
        this.records = payload.records;
        this.loadTimeMs = Date.now() - t0;
        this.loadAttempts = attempt + 1;
        this.state = "ready";
        return true;
      } catch (e) {
        this.lastError = e instanceof Error ? e.message : String(e);
      }
      await new Promise((r) => setTimeout(r, attempt * LOAD_RETRY_BASE_DELAY_MS));
    }

    this.state = "unloaded";
    this.loadAttempts = LOAD_MAX_ATTEMPTS;
    return false;
  }

  private gate(): Response | null {
    if (this.state === "ready") return null;
    if (this.state === "unloaded") {
      void this.ensureLoaded();
    }
    return jsonResponse(
      {
        code: 503,
        name: "NotReady",
        message: `room not ready (${this.state}): ${this.lastError}`,
      },
      503
    );
  }

  async onRequest(req: PartyRequest): Promise<Response> {
    const url = new URL(req.url);
    const segments = url.pathname.split("/");
    const route = segments[segments.length - 1];

    if (route === "warm") {
      if (this.state !== "ready") {
        void this.ensureLoaded();
      }
      return jsonResponse({ state: this.state });
    }

    if (route === "info") {
      return jsonResponse({
        chunk: this.roomId,
        generation: this.generation,
        state: this.state,
        recordCount: this.records.length,
        loadTimeMs: this.loadTimeMs,
        loadAttempts: this.loadAttempts,
        lastError: this.lastError,
      });
    }

    const g = this.gate();
    if (g) return g;

    if (route === "get") return this.handleGet(url);
    if (route === "get-by-id") return this.handleGetById(url);
    if (route === "search") return this.handleSearch(url);
    if (route === "search-lyrics") return this.handleSearchLyrics(url);

    return jsonResponse({ error: "Not found" }, 404);
  }

  async onMessage(message: string | ArrayBuffer, sender: Connection): Promise<void> {
    if (typeof message !== "string") return;
    let req: RpcRequest;
    try {
      req = JSON.parse(message) as RpcRequest;
    } catch {
      return;
    }
    const url = new URL(`http://rpc.local/${req.route}`);
    for (const [k, v] of Object.entries(req.params)) {
      url.searchParams.set(k, v);
    }
    let res: Response;
    try {
      res = await this.routeRpc(url);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res = jsonResponse({ error: msg }, 500);
    }
    sender.send(
      JSON.stringify({ id: req.id, status: res.status, body: await res.text() })
    );
  }

  private async routeRpc(url: URL): Promise<Response> {
    const segments = url.pathname.split("/");
    const route = segments[segments.length - 1];
    if (route === "warm") {
      if (this.state !== "ready") {
        void this.ensureLoaded();
      }
      return jsonResponse({ state: this.state });
    }
    const g = this.gate();
    if (g) return g;
    if (route === "get") return this.handleGet(url);
    if (route === "get-by-id") return this.handleGetById(url);
    if (route === "search") return this.handleSearch(url);
    if (route === "search-lyrics") return this.handleSearchLyrics(url);
    return jsonResponse({ error: "Not found" }, 404);
  }

  async onAlarm() {
    if (this.state !== "ready") {
      await this.ensureLoaded();
    }
  }

  private async handleGet(url: URL): Promise<Response> {
    const trackName = url.searchParams.get("track_name") || "";
    const artistName = url.searchParams.get("artist_name") || "";
    const albumName = url.searchParams.get("album_name");
    const durationStr = url.searchParams.get("duration");

    const nameLower = prepareInput(trackName);
    const artistNameLower = prepareInput(artistName);
    const duration = durationStr ? parseFloat(durationStr) : null;

    let best: LyricRecord | null = null;

    const albumLower = albumName ? prepareInput(albumName) : null;

    for (const rec of this.records) {
      if (rec.nameLower === nameLower && rec.artistNameLower === artistNameLower) {
        if (duration !== null) {
          if (rec.duration < duration - 2.0 || rec.duration > duration + 2.0) continue;
        }
        if (albumLower !== null) {
          if (rec.albumNameLower !== albumLower) continue;
        }
        if (best === null || rec.id < best.id) {
          best = rec;
        }
      }
    }

    if (best !== null) {
      return jsonResponse(toApiResponse(best));
    }

    return jsonResponse(
      { code: 404, name: "TrackNotFound", message: "Failed to find specified track" },
      404
    );
  }

  private async handleGetById(url: URL): Promise<Response> {
    const idStr = url.searchParams.get("id");
    if (!idStr) {
      return jsonResponse({ error: "id required" }, 400);
    }
    const id = parseInt(idStr, 10);
    if (isNaN(id) || id < 1) {
      return jsonResponse({ error: "invalid id" }, 400);
    }

    for (const rec of this.records) {
      if (rec.id === id) {
        return jsonResponse(toApiResponse(rec));
      }
    }

    return jsonResponse(
      { code: 404, name: "TrackNotFound", message: "Failed to find specified track" },
      404
    );
  }

  private async handleSearch(url: URL): Promise<Response> {
    const q = url.searchParams.get("q");
    const trackName = url.searchParams.get("track_name");
    const artistName = url.searchParams.get("artist_name");
    const albumName = url.searchParams.get("album_name");
    const limitStr = url.searchParams.get("limit");
    const limit = Math.min(Math.max(parseInt(limitStr || String(DEFAULT_SEARCH_LIMIT), 10) || DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT);

    const cacheKey = `search:${q || ""}:${trackName || ""}:${artistName || ""}:${albumName || ""}:${limit}`;
    const cached = this.getCached(cacheKey);
    if (cached) return new Response(cached, { headers: { "Content-Type": "application/json" } });

    const existing = this.inflight.get(cacheKey);
    if (existing) {
      const result = await existing;
      return new Response(result, { headers: { "Content-Type": "application/json" } });
    }

    const promise = this.doSearch(q, trackName, artistName, albumName, limit);
    this.inflight.set(cacheKey, promise);
    try {
      const result = await promise;
      this.setCached(cacheKey, result);
      return new Response(result, { headers: { "Content-Type": "application/json" } });
    } finally {
      this.inflight.delete(cacheKey);
    }
  }

  private async doSearch(
    q: string | null,
    trackName: string | null,
    artistName: string | null,
    albumName: string | null,
    limit: number
  ): Promise<string> {
    const matched: LyricRecord[] = [];

    if (q) {
      const tokens = prepareInput(q).split(" ").filter(t => t.length > 0);
      for (const rec of this.records) {
        if (tokens.every(t =>
          rec.nameLower.includes(t) ||
          rec.artistNameLower.includes(t) ||
          rec.albumNameLower.includes(t)
        )) {
          matched.push(rec);
        }
      }
    } else {
      const trackLower = trackName ? prepareInput(trackName) : null;
      const artistLower = artistName ? prepareInput(artistName) : null;
      const albumLower = albumName ? prepareInput(albumName) : null;

      for (const rec of this.records) {
        if (trackLower && !rec.nameLower.includes(trackLower)) continue;
        if (artistLower && !rec.artistNameLower.includes(artistLower)) continue;
        if (albumLower && !rec.albumNameLower.includes(albumLower)) continue;
        matched.push(rec);
      }
    }

    matched.sort((a, b) => a.id - b.id);
    const sliced = matched.slice(0, limit);
    return JSON.stringify(sliced.map(rec => toApiResponse(rec)));
  }

  private async handleSearchLyrics(url: URL): Promise<Response> {
    const q = url.searchParams.get("q");
    const limitStr = url.searchParams.get("limit");
    const limit = Math.min(Math.max(parseInt(limitStr || String(DEFAULT_SEARCH_LIMIT), 10) || DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT);

    if (!q) {
      return jsonResponse([]);
    }

    const cacheKey = `search-lyrics:${q}:${limit}`;
    const cached = this.getCached(cacheKey);
    if (cached) return new Response(cached, { headers: { "Content-Type": "application/json" } });

    const existing = this.inflight.get(cacheKey);
    if (existing) {
      const result = await existing;
      return new Response(result, { headers: { "Content-Type": "application/json" } });
    }

    const promise = this.doSearchLyrics(q, limit);
    this.inflight.set(cacheKey, promise);
    try {
      const result = await promise;
      this.setCached(cacheKey, result);
      return new Response(result, { headers: { "Content-Type": "application/json" } });
    } finally {
      this.inflight.delete(cacheKey);
    }
  }

  private async doSearchLyrics(q: string, limit: number): Promise<string> {
    const queryLower = q.toLowerCase();
    const matched: LyricRecord[] = [];

    for (const rec of this.records) {
      const plain = rec.plainLyrics?.toLowerCase() || "";
      const synced = rec.syncedLyrics?.toLowerCase() || "";
      if (plain.includes(queryLower) || synced.includes(queryLower)) {
        matched.push(rec);
      }
    }

    matched.sort((a, b) => a.id - b.id);
    const sliced = matched.slice(0, limit);
    return JSON.stringify(sliced.map(rec => toApiResponse(rec)));
  }

  private getCached(key: string): string | undefined {
    const val = this.lruCache.get(key);
    if (val !== undefined) {
      this.lruCache.delete(key);
      this.lruCache.set(key, val);
    }
    return val;
  }

  private setCached(key: string, value: string): void {
    const entryBytes = key.length + value.length;
    const existing = this.lruCache.get(key);
    if (existing !== undefined) {
      this.lruCacheBytes -= key.length + existing.length;
    }
    this.lruCache.set(key, value);
    this.lruCacheBytes += entryBytes;
    while (this.lruCacheBytes > this.LRU_MAX_BYTES && this.lruCache.size > 0) {
      const oldest = this.lruCache.keys().next().value;
      if (oldest !== undefined) {
        const oldVal = this.lruCache.get(oldest);
        this.lruCacheBytes -= oldest.length + (oldVal?.length || 0);
        this.lruCache.delete(oldest);
      }
    }
  }
}