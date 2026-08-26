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
  private readonly LRU_MAX_BYTES = 20 * 1024 * 1024;
  private lruCacheBytes = 0;

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
    const segments = path.split("/");
    const route = segments[segments.length - 1];

    if (route === "warm") {
      return new Response("OK", { status: 200 });
    }

    if (route === "info") {
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

    if (route === "get") {
      return this.handleGet(url);
    }

    if (route === "get-by-id") {
      return this.handleGetById(url);
    }

    if (route === "search") {
      return this.handleSearch(url);
    }

    if (route === "search-lyrics") {
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
      return new Response(JSON.stringify(toApiResponse(best)), {
        headers: { "Content-Type": "application/json" },
      });
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
