import { toApiResponse, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT } from "./types";
import { TOTAL_ROOMS, NUM_AGGREGATORS, CHUNKS_PER_AGG } from "./config";
import type { Request as PartyRequest, Room, Server } from "partykit/server";

type ApiResponse = ReturnType<typeof toApiResponse>;

export default class AggregatorServer implements Server {
  room: Room;

  constructor(room: Room) {
    this.room = room;
  }

  async onRequest(req: PartyRequest): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const isSuper = this.room.id.startsWith("super-");

    if (path === "/get-by-id") {
      return this.handleGetById(url, isSuper);
    }

    if (path === "/search") {
      return this.handleSearch(url, isSuper);
    }

    if (path === "/search-lyrics") {
      return this.handleSearchLyrics(url, isSuper);
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  private async handleGetById(url: URL, isSuper: boolean): Promise<Response> {
    const idStr = url.searchParams.get("id");
    if (!idStr) {
      return this.jsonError("id required", 400);
    }
    const id = parseInt(idStr, 10);
    if (isNaN(id) || id < 1) {
      return this.jsonError("invalid id", 400);
    }

    if (isSuper) {
      const aggParty = this.room.context.parties.aggregator;
      const batchSize = 6;
      for (let i = 0; i < NUM_AGGREGATORS; i += batchSize) {
        const batch: Promise<Response>[] = [];
        for (let j = i; j < Math.min(i + batchSize, NUM_AGGREGATORS); j++) {
          batch.push(aggParty.get(`agg-${j}`).fetch(`/get-by-id?id=${id}`));
        }
        const responses = await Promise.all(batch);
        for (const res of responses) {
          if (res.ok) {
            const text = await res.text();
            try {
              const item = JSON.parse(text);
              if (item && !item.error && !item.code) {
                return new Response(text, {
                  headers: { "Content-Type": "application/json" },
                });
              }
            } catch {}
          }
        }
      }
      return this.trackNotFound();
    } else {
      const aggIndex = parseInt(this.room.id.replace("agg-", ""), 10);
      if (isNaN(aggIndex)) return this.trackNotFound();
      const start = aggIndex * CHUNKS_PER_AGG;
      const end = Math.min(start + CHUNKS_PER_AGG, TOTAL_ROOMS);
      const chunkParty = this.room.context.parties.chunk;
      const batchSize = 6;
      for (let i = start; i < end; i += batchSize) {
        const batch: Promise<Response>[] = [];
        for (let j = i; j < Math.min(i + batchSize, end); j++) {
          batch.push(chunkParty.get(`chunk-${j}`).fetch(`/get-by-id?id=${id}`));
        }
        const responses = await Promise.all(batch);
        for (const res of responses) {
          if (res.ok) {
            const text = await res.text();
            try {
              const item = JSON.parse(text);
              if (item && !item.error && !item.code) {
                return new Response(text, {
                  headers: { "Content-Type": "application/json" },
                });
              }
            } catch {}
          }
        }
      }
      return this.trackNotFound();
    }
  }

  private async handleSearch(url: URL, isSuper: boolean): Promise<Response> {
    const q = url.searchParams.get("q");
    const trackName = url.searchParams.get("track_name");
    const artistName = url.searchParams.get("artist_name");
    const albumName = url.searchParams.get("album_name");
    const limitStr = url.searchParams.get("limit");
    const limit = Math.min(Math.max(parseInt(limitStr || String(DEFAULT_SEARCH_LIMIT), 10) || DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT);

    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (trackName) params.set("track_name", trackName);
    if (artistName) params.set("artist_name", artistName);
    if (albumName) params.set("album_name", albumName);
    params.set("limit", String(limit));
    const searchParams = params.toString();

    if (isSuper) {
      const aggParty = this.room.context.parties.aggregator;
      const batchSize = 6;
      const allResults: ApiResponse[] = [];

      for (let i = 0; i < NUM_AGGREGATORS; i += batchSize) {
        const batch: Promise<Response>[] = [];
        for (let j = i; j < Math.min(i + batchSize, NUM_AGGREGATORS); j++) {
          batch.push(aggParty.get(`agg-${j}`).fetch(`/search?${searchParams}`));
        }
        const responses = await Promise.all(batch);
        for (const res of responses) {
          if (res.ok) {
            const text = await res.text();
            if (text && text !== "[]") {
              try {
                const items: unknown = JSON.parse(text);
                if (Array.isArray(items)) {
                  allResults.push(...(items as ApiResponse[]));
                }
              } catch {}
            }
          }
        }
      }

      allResults.sort((a, b) => a.id - b.id);
      return new Response(JSON.stringify(allResults.slice(0, limit)), {
        headers: { "Content-Type": "application/json" },
      });
    } else {
      const aggIndex = parseInt(this.room.id.replace("agg-", ""), 10);
      if (isNaN(aggIndex)) {
        return new Response(JSON.stringify([]), {
          headers: { "Content-Type": "application/json" },
        });
      }
      const start = aggIndex * CHUNKS_PER_AGG;
      const end = Math.min(start + CHUNKS_PER_AGG, TOTAL_ROOMS);
      const chunkParty = this.room.context.parties.chunk;
      const batchSize = 6;
      const allResults: ApiResponse[] = [];

      for (let i = start; i < end; i += batchSize) {
        const batch: Promise<Response>[] = [];
        for (let j = i; j < Math.min(i + batchSize, end); j++) {
          batch.push(chunkParty.get(`chunk-${j}`).fetch(`/search?${searchParams}`));
        }
        const responses = await Promise.all(batch);
        for (const res of responses) {
          if (res.ok) {
            const text = await res.text();
            if (text && text !== "[]") {
              try {
                const items: unknown = JSON.parse(text);
                if (Array.isArray(items)) {
                  allResults.push(...(items as ApiResponse[]));
                }
              } catch {}
            }
          }
        }
      }

      allResults.sort((a, b) => a.id - b.id);
      return new Response(JSON.stringify(allResults.slice(0, limit)), {
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  private async handleSearchLyrics(url: URL, isSuper: boolean): Promise<Response> {
    const q = url.searchParams.get("q");
    const limitStr = url.searchParams.get("limit");
    const limit = Math.min(Math.max(parseInt(limitStr || String(DEFAULT_SEARCH_LIMIT), 10) || DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT);

    if (!q) {
      return new Response(JSON.stringify([]), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const searchParams = `q=${encodeURIComponent(q)}&limit=${limit}`;

    if (isSuper) {
      const aggParty = this.room.context.parties.aggregator;
      const batchSize = 6;
      const allResults: ApiResponse[] = [];

      for (let i = 0; i < NUM_AGGREGATORS; i += batchSize) {
        const batch: Promise<Response>[] = [];
        for (let j = i; j < Math.min(i + batchSize, NUM_AGGREGATORS); j++) {
          batch.push(aggParty.get(`agg-${j}`).fetch(`/search-lyrics?${searchParams}`));
        }
        const responses = await Promise.all(batch);
        for (const res of responses) {
          if (res.ok) {
            const text = await res.text();
            if (text && text !== "[]") {
              try {
                const items: unknown = JSON.parse(text);
                if (Array.isArray(items)) {
                  allResults.push(...(items as ApiResponse[]));
                }
              } catch {}
            }
          }
        }
      }

      allResults.sort((a, b) => a.id - b.id);
      return new Response(JSON.stringify(allResults.slice(0, limit)), {
        headers: { "Content-Type": "application/json" },
      });
    } else {
      const aggIndex = parseInt(this.room.id.replace("agg-", ""), 10);
      if (isNaN(aggIndex)) {
        return new Response(JSON.stringify([]), {
          headers: { "Content-Type": "application/json" },
        });
      }
      const start = aggIndex * CHUNKS_PER_AGG;
      const end = Math.min(start + CHUNKS_PER_AGG, TOTAL_ROOMS);
      const chunkParty = this.room.context.parties.chunk;
      const batchSize = 6;
      const allResults: ApiResponse[] = [];

      for (let i = start; i < end; i += batchSize) {
        const batch: Promise<Response>[] = [];
        for (let j = i; j < Math.min(i + batchSize, end); j++) {
          batch.push(chunkParty.get(`chunk-${j}`).fetch(`/search-lyrics?${searchParams}`));
        }
        const responses = await Promise.all(batch);
        for (const res of responses) {
          if (res.ok) {
            const text = await res.text();
            if (text && text !== "[]") {
              try {
                const items: unknown = JSON.parse(text);
                if (Array.isArray(items)) {
                  allResults.push(...(items as ApiResponse[]));
                }
              } catch {}
            }
          }
        }
      }

      allResults.sort((a, b) => a.id - b.id);
      return new Response(JSON.stringify(allResults.slice(0, limit)), {
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  private jsonError(message: string, status: number): Response {
    return new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  private trackNotFound(): Response {
    return new Response(
      JSON.stringify({ code: 404, name: "TrackNotFound", message: "Failed to find specified track" }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  }
}
