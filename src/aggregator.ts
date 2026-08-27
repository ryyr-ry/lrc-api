import { toApiResponse, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT, rpcCall, RpcRequest } from "./types";
import { TOTAL_ROOMS, NUM_AGGREGATORS, CHUNKS_PER_AGG } from "./config";
import type { Request as PartyRequest, Room, Server, Connection } from "partykit/server";

type ApiResponse = ReturnType<typeof toApiResponse>;

export default class AggregatorServer implements Server {
  room: Room;

  constructor(room: Room) {
    this.room = room;
  }

  async onMessage(message: string | ArrayBuffer, sender: Connection): Promise<void> {
    if (typeof message !== "string") return;
    let req: RpcRequest;
    try {
      req = JSON.parse(message) as RpcRequest;
    } catch {
      return;
    }
    let status = 200;
    let body = "";
    try {
      const result = await this.routeRpc(req);
      status = result.status;
      body = result.body;
    } catch (e) {
      status = 500;
      body = JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
    }
    sender.send(JSON.stringify({ id: req.id, status, body }));
  }

  private async routeRpc(req: RpcRequest): Promise<{ status: number; body: string }> {
    const isSuper = this.room.id.startsWith("super-");
    const params = req.params;
    if (req.route === "warm") {
      return { status: 200, body: "OK" };
    }
    if (req.route === "search") {
      const body = await this.doSearch(params, isSuper);
      return { status: 200, body };
    }
    if (req.route === "search-lyrics") {
      const body = await this.doSearchLyrics(params, isSuper);
      return { status: 200, body };
    }
    return { status: 404, body: JSON.stringify({ error: "Not found" }) };
  }

  async onRequest(req: PartyRequest): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const segments = path.split("/");
    const route = segments[segments.length - 1];

    if (route === "warm") {
      return new Response("OK", { status: 200 });
    }

    const isSuper = this.room.id.startsWith("super-");
    const params: Record<string, string> = {};
    for (const [k, v] of url.searchParams.entries()) {
      params[k] = v;
    }

    if (route === "search") {
      const body = await this.doSearch(params, isSuper);
      return new Response(body, { headers: { "Content-Type": "application/json" } });
    }

    if (route === "search-lyrics") {
      const body = await this.doSearchLyrics(params, isSuper);
      return new Response(body, { headers: { "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  private async doSearch(params: Record<string, string>, isSuper: boolean): Promise<string> {
    const q = params.q || null;
    const trackName = params.track_name || null;
    const artistName = params.artist_name || null;
    const albumName = params.album_name || null;
    const limit = Math.min(Math.max(parseInt(params.limit || String(DEFAULT_SEARCH_LIMIT), 10) || DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT);

    const rpcParams: Record<string, string> = { limit: String(limit) };
    if (q) rpcParams.q = q;
    if (trackName) rpcParams.track_name = trackName;
    if (artistName) rpcParams.artist_name = artistName;
    if (albumName) rpcParams.album_name = albumName;

    const allResults: ApiResponse[] = [];
    let errors = 0;

    if (isSuper) {
      const aggParty = this.room.context.parties.aggregator;
      const batchSize = 6;
      for (let i = 0; i < NUM_AGGREGATORS; i += batchSize) {
        const batch: Promise<{ status: number; body: string } | null>[] = [];
        for (let j = i; j < Math.min(i + batchSize, NUM_AGGREGATORS); j++) {
          batch.push(
            rpcCall(aggParty.get(`agg-${j}`), "search", rpcParams).catch(() => null)
          );
        }
        const responses = await Promise.all(batch);
        for (const res of responses) {
          if (res && res.status === 200) {
            const text = res.body;
            if (text && text !== "[]") {
              try {
                const items: unknown = JSON.parse(text);
                if (Array.isArray(items)) {
                  allResults.push(...(items as ApiResponse[]));
                }
              } catch {}
            }
          } else {
            errors++;
          }
        }
      }
    } else {
      const aggIndex = parseInt(this.room.id.replace("agg-", ""), 10);
      if (isNaN(aggIndex)) return "[]";
      const start = aggIndex * CHUNKS_PER_AGG;
      const end = Math.min(start + CHUNKS_PER_AGG, TOTAL_ROOMS);
      const chunkParty = this.room.context.parties.chunk;
      const batchSize = 6;
      for (let i = start; i < end; i += batchSize) {
        const batch: Promise<{ status: number; body: string } | null>[] = [];
        for (let j = i; j < Math.min(i + batchSize, end); j++) {
          batch.push(
            rpcCall(chunkParty.get(`chunk-${j}`), "search", rpcParams).catch(() => null)
          );
        }
        const responses = await Promise.all(batch);
        for (const res of responses) {
          if (res && res.status === 200) {
            const text = res.body;
            if (text && text !== "[]") {
              try {
                const items: unknown = JSON.parse(text);
                if (Array.isArray(items)) {
                  allResults.push(...(items as ApiResponse[]));
                }
              } catch {}
            }
          } else {
            errors++;
          }
        }
      }
    }

    allResults.sort((a, b) => a.id - b.id);
    return JSON.stringify(allResults.slice(0, limit));
  }

  private async doSearchLyrics(params: Record<string, string>, isSuper: boolean): Promise<string> {
    const q = params.q || null;
    const limit = Math.min(Math.max(parseInt(params.limit || String(DEFAULT_SEARCH_LIMIT), 10) || DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT);

    if (!q) return "[]";

    const rpcParams: Record<string, string> = { q, limit: String(limit) };

    const allResults: ApiResponse[] = [];

    if (isSuper) {
      const aggParty = this.room.context.parties.aggregator;
      const batchSize = 6;
      for (let i = 0; i < NUM_AGGREGATORS; i += batchSize) {
        const batch: Promise<{ status: number; body: string } | null>[] = [];
        for (let j = i; j < Math.min(i + batchSize, NUM_AGGREGATORS); j++) {
          batch.push(
            rpcCall(aggParty.get(`agg-${j}`), "search-lyrics", rpcParams).catch(() => null)
          );
        }
        const responses = await Promise.all(batch);
        for (const res of responses) {
          if (res && res.status === 200) {
            const text = res.body;
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
    } else {
      const aggIndex = parseInt(this.room.id.replace("agg-", ""), 10);
      if (isNaN(aggIndex)) return "[]";
      const start = aggIndex * CHUNKS_PER_AGG;
      const end = Math.min(start + CHUNKS_PER_AGG, TOTAL_ROOMS);
      const chunkParty = this.room.context.parties.chunk;
      const batchSize = 6;
      for (let i = start; i < end; i += batchSize) {
        const batch: Promise<{ status: number; body: string } | null>[] = [];
        for (let j = i; j < Math.min(i + batchSize, end); j++) {
          batch.push(
            rpcCall(chunkParty.get(`chunk-${j}`), "search-lyrics", rpcParams).catch(() => null)
          );
        }
        const responses = await Promise.all(batch);
        for (const res of responses) {
          if (res && res.status === 200) {
            const text = res.body;
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
    }

    allResults.sort((a, b) => a.id - b.id);
    return JSON.stringify(allResults.slice(0, limit));
  }
}
