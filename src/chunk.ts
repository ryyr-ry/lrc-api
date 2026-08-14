import type { LyricRecord } from "./types";
import { prepareInput, toApiResponse, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT } from "./types";
import type { Request as PartyRequest, Room, Server } from "partykit/server";

export default class ChunkServer implements Server {
  room: Room;
  records: LyricRecord[] = [];
  loaded = false;
  loadTimeMs = 0;
  chunkIndex = -1;

  private lruCache = new Map<string, string>();
  private readonly LRU_MAX = 200;

  private inflight = new Map<string, Promise<string>>();

  constructor(room: Room) {
    this.room = room;
  }

  async onStart() {
    this.chunkIndex = parseInt(this.room.id.replace("chunk-", ""), 10);
    if (isNaN(this.chunkIndex)) {
      console.error(`Invalid chunk index from room id: ${this.room.id}`);
      return;
    }

    const t0 = Date.now();
    for (let part = 0; ; part++) {
      const path = `/data/chunk-${this.chunkIndex}-${part}.json`;
      try {
        const res = await this.room.context.assets.fetch(path);
        if (!res || res.status !== 200) break;
        const text = await res.text();
        const partRecords = JSON.parse(text) as LyricRecord[];
        this.records.push(...partRecords);
      } catch (e) {
        console.error(`Failed to load ${path}: ${e}`);
        break;
      }
    }

    this.loaded = true;
    this.loadTimeMs = Date.now() - t0;
  }

  async onRequest(req: PartyRequest): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/warm") {
      return new Response("OK", { status: 200 });
    }

    if (path === "/info") {
      return new Response(
        JSON.stringify({
          chunk: this.chunkIndex,
          loaded: this.loaded,
          recordCount: this.records.length,
          loadTimeMs: this.loadTimeMs,
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    if (path === "/get") {
      return this.handleGet(url);
    }

    if (path === "/get-by-id") {
      return this.handleGetById(url);
    }

    if (path === "/search") {
      return this.handleSearch(url);
    }

    if (path === "/search-lyrics") {
      return this.handleSearchLyrics(url);
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  private async handleGet(url: URL): Promise<Response> {
    const trackName = url.searchParams.get("track_name") || "";
    const artistName = url.searchParams.get("artist_name") || "";
    const albumName = url.searchParams.get("album_name");
    const durationStr = url.searchParams.get("duration");

    const nameLower = prepareInput(trackName);
    const artistNameLower = prepareInput(artistName);
    const duration = durationStr ? parseFloat(durationStr) : null;

    for (const rec of this.records) {
      if (rec.nameLower === nameLower && rec.artistNameLower === artistNameLower) {
        if (duration !== null) {
          if (rec.duration < duration - 2.0 || rec.duration > duration + 2.0) continue;
        }
        if (albumName) {
          const albumLower = prepareInput(albumName);
          if (rec.albumNameLower !== albumLower) continue;
        }
        return new Response(JSON.stringify(toApiResponse(rec)), {
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    return new Response(
      JSON.stringify({ code: 404, name: "TrackNotFound", message: "Failed to find specified track" }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  }

  private async handleGetById(url: URL): Promise<Response> {
    const idStr = url.searchParams.get("id");
    if (!idStr) {
      return new Response(JSON.stringify({ error: "id required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const id = parseInt(idStr, 10);
    if (isNaN(id) || id < 1) {
      return new Response(JSON.stringify({ error: "invalid id" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    for (const rec of this.records) {
      if (rec.id === id) {
        return new Response(JSON.stringify(toApiResponse(rec)), {
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    return new Response(
      JSON.stringify({ code: 404, name: "TrackNotFound", message: "Failed to find specified track" }),
      { status: 404, headers: { "Content-Type": "application/json" } }
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
    const results: ReturnType<typeof toApiResponse>[] = [];

    if (q) {
      const tokens = prepareInput(q).split(" ").filter(t => t.length > 0);
      for (const rec of this.records) {
        if (tokens.every(t =>
          rec.nameLower.includes(t) ||
          rec.artistNameLower.includes(t) ||
          rec.albumNameLower.includes(t)
        )) {
          results.push(toApiResponse(rec));
          if (results.length >= limit) break;
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
        results.push(toApiResponse(rec));
        if (results.length >= limit) break;
      }
    }

    return JSON.stringify(results);
  }

  private async handleSearchLyrics(url: URL): Promise<Response> {
    const q = url.searchParams.get("q");
    const limitStr = url.searchParams.get("limit");
    const limit = Math.min(Math.max(parseInt(limitStr || String(DEFAULT_SEARCH_LIMIT), 10) || DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT);

    if (!q) {
      return new Response(JSON.stringify([]), {
        headers: { "Content-Type": "application/json" },
      });
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
    const results: ReturnType<typeof toApiResponse>[] = [];

    for (const rec of this.records) {
      const plain = rec.plainLyrics?.toLowerCase() || "";
      const synced = rec.syncedLyrics?.toLowerCase() || "";
      if (plain.includes(queryLower) || synced.includes(queryLower)) {
        results.push(toApiResponse(rec));
        if (results.length >= limit) break;
      }
    }

    return JSON.stringify(results);
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
    if (this.lruCache.size >= this.LRU_MAX) {
      const oldest = this.lruCache.keys().next().value;
      if (oldest !== undefined) this.lruCache.delete(oldest);
    }
    this.lruCache.set(key, value);
  }
}
