import { rpcCall, RpcRequest, RpcResponse } from "./types";
import {
  TOTAL_ROOMS,
  NUM_AGGREGATORS,
  NUM_SUPERS,
  NUM_SUBS,
  CHUNKS_PER_AGG,
  SUBS_PER_SUPER,
} from "./config";
import type { Request as PartyRequest, Room, Server, Connection } from "partykit/server";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function parseRoomId(roomId: string): {
  level: "super" | "sub" | "agg";
  generation: number;
  index: number;
} | null {
  const match = roomId.match(/^(super|sub|agg)-(\d+)-(\d+)$/);
  if (!match) return null;
  return {
    level: match[1] as "super" | "sub" | "agg",
    generation: parseInt(match[2], 10),
    index: parseInt(match[3], 10),
  };
}

export default class AggregatorServer implements Server {
  room: Room;
  generation = -1;
  index = -1;
  level: "super" | "sub" | "agg" = "agg";

  constructor(room: Room) {
    this.room = room;
    const parsed = parseRoomId(room.id);
    if (parsed) {
      this.generation = parsed.generation;
      this.index = parsed.index;
      this.level = parsed.level;
    }
  }

  async onStart() {}

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
    const params = req.params;
    if (req.route === "warm") {
      return { status: 200, body: JSON.stringify({ state: "ok" }) };
    }
    if (req.route === "search") {
      const body = await this.doSearch(params);
      return { status: 200, body };
    }
    if (req.route === "search-lyrics") {
      const body = await this.doSearchLyrics(params);
      return { status: 200, body };
    }
    return { status: 404, body: JSON.stringify({ error: "Not found" }) };
  }

  async onRequest(req: PartyRequest): Promise<Response> {
    const url = new URL(req.url);
    const segments = url.pathname.split("/");
    const route = segments[segments.length - 1];

    if (route === "warm") {
      return jsonResponse({ state: "ok" });
    }

    if (route === "info") {
      return jsonResponse({
        level: this.level,
        generation: this.generation,
        index: this.index,
      });
    }

    const params: Record<string, string> = {};
    for (const [k, v] of url.searchParams.entries()) {
      params[k] = v;
    }

    if (route === "search") {
      const body = await this.doSearch(params);
      return jsonResponse(JSON.parse(body));
    }

    if (route === "search-lyrics") {
      const body = await this.doSearchLyrics(params);
      return jsonResponse(JSON.parse(body));
    }

    return jsonResponse({ error: "Not found" }, 404);
  }

  private parseLimit(params: Record<string, string>): number {
    return Math.min(
      Math.max(parseInt(params.limit || "20", 10) || 20, 1),
      100
    );
  }

  private mergeResults(responses: (RpcResponse | null)[]): { results: unknown[]; errors: number } {
    const results: unknown[] = [];
    let errors = 0;
    for (const res of responses) {
      if (res && res.status === 200) {
        const text = res.body;
        if (text && text !== "[]") {
          try {
            const items: unknown = JSON.parse(text);
            if (Array.isArray(items)) {
              results.push(...items);
            } else if (items && typeof items === "object" && Array.isArray((items as { results?: unknown[] }).results)) {
              results.push(...(items as { results: unknown[] }).results);
              errors += (items as { errors?: number }).errors ?? 0;
            }
          } catch {}
        }
      } else {
        errors++;
      }
    }
    return { results, errors };
  }

  private fanOut(
    partyName: "aggregator" | "chunk",
    roomIds: string[],
    route: string,
    params: Record<string, string>
  ): Promise<RpcResponse | null>[] {
    const party = this.room.context.parties[partyName];
    return roomIds.map((id) =>
      rpcCall(party.get(id), route, params, 60000).catch(() => null)
    );
  }

  private async doSearch(params: Record<string, string>): Promise<string> {
    const limit = this.parseLimit(params);
    if (this.level === "super") {
      const subIds: string[] = [];
      const subsPer = Math.ceil(NUM_SUBS / NUM_SUPERS);
      const subStart = this.index * subsPer;
      const subEnd = Math.min(subStart + subsPer, NUM_SUBS);
      for (let i = subStart; i < subEnd; i++) {
        subIds.push(`sub-${this.generation}-${i}`);
      }
      const responses = await Promise.all(this.fanOut("aggregator", subIds, "search", params));
      const { results, errors } = this.mergeResults(responses);
      results.sort((a, b) => (a as { id: number }).id - (b as { id: number }).id);
      return JSON.stringify({ results: results.slice(0, limit), errors });
    }

    if (this.level === "sub") {
      const aggIds: string[] = [];
      for (let i = 0; i < SUBS_PER_SUPER; i++) {
        const aggIndex = this.index * SUBS_PER_SUPER + i;
        if (aggIndex >= NUM_AGGREGATORS) break;
        aggIds.push(`agg-${this.generation}-${aggIndex}`);
      }
      const responses = await Promise.all(this.fanOut("aggregator", aggIds, "search", params));
      const { results, errors } = this.mergeResults(responses);
      results.sort((a, b) => (a as { id: number }).id - (b as { id: number }).id);
      return JSON.stringify({ results: results.slice(0, limit), errors });
    }

    const chunkIds: string[] = [];
    const start = this.index * CHUNKS_PER_AGG;
    const end = Math.min(start + CHUNKS_PER_AGG, TOTAL_ROOMS);
    for (let j = start; j < end; j++) {
      chunkIds.push(`chunk-${this.generation}-${j}`);
    }
    const responses = await Promise.all(this.fanOut("chunk", chunkIds, "search", params));
    const { results, errors } = this.mergeResults(responses);
    results.sort((a, b) => (a as { id: number }).id - (b as { id: number }).id);
    return JSON.stringify({ results: results.slice(0, limit), errors });
  }

  private async doSearchLyrics(params: Record<string, string>): Promise<string> {
    const limit = this.parseLimit(params);
    if (this.level === "super") {
      const subIds: string[] = [];
      const subsPer = Math.ceil(NUM_SUBS / NUM_SUPERS);
      const subStart = this.index * subsPer;
      const subEnd = Math.min(subStart + subsPer, NUM_SUBS);
      for (let i = subStart; i < subEnd; i++) {
        subIds.push(`sub-${this.generation}-${i}`);
      }
      const responses = await Promise.all(this.fanOut("aggregator", subIds, "search-lyrics", params));
      const { results, errors } = this.mergeResults(responses);
      results.sort((a, b) => (a as { id: number }).id - (b as { id: number }).id);
      return JSON.stringify({ results: results.slice(0, limit), errors });
    }

    if (this.level === "sub") {
      const aggIds: string[] = [];
      for (let i = 0; i < SUBS_PER_SUPER; i++) {
        const aggIndex = this.index * SUBS_PER_SUPER + i;
        if (aggIndex >= NUM_AGGREGATORS) break;
        aggIds.push(`agg-${this.generation}-${aggIndex}`);
      }
      const responses = await Promise.all(this.fanOut("aggregator", aggIds, "search-lyrics", params));
      const { results, errors } = this.mergeResults(responses);
      results.sort((a, b) => (a as { id: number }).id - (b as { id: number }).id);
      return JSON.stringify({ results: results.slice(0, limit), errors });
    }

    const chunkIds: string[] = [];
    const start = this.index * CHUNKS_PER_AGG;
    const end = Math.min(start + CHUNKS_PER_AGG, TOTAL_ROOMS);
    for (let j = start; j < end; j++) {
      chunkIds.push(`chunk-${this.generation}-${j}`);
    }
    const responses = await Promise.all(this.fanOut("chunk", chunkIds, "search-lyrics", params));
    const { results, errors } = this.mergeResults(responses);
    results.sort((a, b) => (a as { id: number }).id - (b as { id: number }).id);
    return JSON.stringify({ results: results.slice(0, limit), errors });
  }
}