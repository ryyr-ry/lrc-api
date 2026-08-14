import { toApiResponse, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT } from "./types";
import { TOTAL_ROOMS } from "./config";
import type { Request as PartyRequest, Room, Server } from "partykit/server";

export default class AggregatorServer implements Server {
  room: Room;

  constructor(room: Room) {
    this.room = room;
  }

  async onRequest(req: PartyRequest): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

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

  private async handleGetById(url: URL): Promise<Response> {
    const idStr = url.searchParams.get("id");
    if (!idStr) {
      return new Response(JSON.stringify({ error: "id required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const id = parseInt(idStr, 10);

    const chunkParty = this.room.context.parties.chunk;
    const batchSize = 6;

    for (let i = 0; i < TOTAL_ROOMS; i += batchSize) {
      const batch: Promise<Response>[] = [];
      for (let j = i; j < Math.min(i + batchSize, TOTAL_ROOMS); j++) {
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

    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (trackName) params.set("track_name", trackName);
    if (artistName) params.set("artist_name", artistName);
    if (albumName) params.set("album_name", albumName);
    params.set("limit", String(limit));

    const chunkParty = this.room.context.parties.chunk;
    const batchSize = 6;
    const allResults: ReturnType<typeof toApiResponse>[] = [];

    for (let i = 0; i < TOTAL_ROOMS; i += batchSize) {
      const batch: Promise<Response>[] = [];
      for (let j = i; j < Math.min(i + batchSize, TOTAL_ROOMS); j++) {
        batch.push(chunkParty.get(`chunk-${j}`).fetch(`/search?${params.toString()}`));
      }
      const responses = await Promise.all(batch);
      for (const res of responses) {
        if (res.ok) {
          const text = await res.text();
          if (text && text !== "[]") {
            try {
              const items = JSON.parse(text);
              if (Array.isArray(items)) {
                allResults.push(...items);
              }
            } catch {}
          }
        }
      }
      if (allResults.length >= limit) break;
    }

    const sorted = allResults.slice(0, limit);
    return new Response(JSON.stringify(sorted), {
      headers: { "Content-Type": "application/json" },
    });
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

    const totalRooms = TOTAL_ROOMS;
    const chunkParty = this.room.context.parties.chunk;
    const batchSize = 6;
    const allResults: ReturnType<typeof toApiResponse>[] = [];

    for (let i = 0; i < totalRooms; i += batchSize) {
      const batch: Promise<Response>[] = [];
      for (let j = i; j < Math.min(i + batchSize, totalRooms); j++) {
        batch.push(chunkParty.get(`chunk-${j}`).fetch(`/search-lyrics?q=${encodeURIComponent(q)}&limit=${limit}`));
      }
      const responses = await Promise.all(batch);
      for (const res of responses) {
        if (res.ok) {
          const text = await res.text();
          if (text && text !== "[]") {
            try {
              const items = JSON.parse(text);
              if (Array.isArray(items)) {
                allResults.push(...items);
              }
            } catch {}
          }
        }
      }
      if (allResults.length >= limit) break;
    }

    const sorted = allResults.slice(0, limit);
    return new Response(JSON.stringify(sorted), {
      headers: { "Content-Type": "application/json" },
    });
  }
}
