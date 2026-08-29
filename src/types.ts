import {
  GENERATION_HOURS,
  NUM_GENERATIONS,
  RELEASE_BASE_URL,
  ROOMS_PER_RELEASE,
} from "./config";

export interface LyricRecord {
  id: number;
  name: string;
  trackName: string;
  artistName: string;
  albumName: string;
  duration: number;
  instrumental: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
  lyricsfile: string | null;
  nameLower: string;
  artistNameLower: string;
  albumNameLower: string;
}

export const GENERATION_MS = GENERATION_HOURS * 3600 * 1000;

export function prepareInput(text: string): string {
  const punct = /[`~!@#$%^&*()_|+\-=?;:",.<>{}[\]\\/\0\n]/g;
  let s = text.normalize("NFKC").toLowerCase();
  s = s.replace(punct, " ");
  s = s.replace(/['\u2019]/g, "");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

export function hashPartition(artistName: string, trackName: string, numRooms: number): number {
  const key = prepareInput(artistName) + " " + prepareInput(trackName);
  const bytes = new TextEncoder().encode(key);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % numRooms;
}

export function currentGeneration(unixTimeMs: number): number {
  return Math.floor(unixTimeMs / GENERATION_MS) % NUM_GENERATIONS;
}

export function generationStartTimeMs(unixTimeMs: number): number {
  return Math.floor(unixTimeMs / GENERATION_MS) * GENERATION_MS;
}

export function generationEndTimeMs(unixTimeMs: number): number {
  return generationStartTimeMs(unixTimeMs) + GENERATION_MS;
}

export function generationPhase(
  unixTimeMs: number,
  warmNextFraction: number,
  routeSwitchFraction: number
): "stable" | "warming-next" | "routing-next" {
  const start = generationStartTimeMs(unixTimeMs);
  const elapsed = unixTimeMs - start;
  if (elapsed < GENERATION_MS * warmNextFraction) return "stable";
  if (elapsed < GENERATION_MS * routeSwitchFraction) return "warming-next";
  return "routing-next";
}

export function roomFileUrl(roomId: number, releaseTags: string[]): string {
  const releaseIndex = Math.floor(roomId / ROOMS_PER_RELEASE);
  const tag = releaseTags[releaseIndex];
  if (!tag) {
    throw new Error(`no release tag for room ${roomId} (releaseIndex ${releaseIndex})`);
  }
  return `${RELEASE_BASE_URL}/${tag}/room-${String(roomId).padStart(4, "0")}.json`;
}

export async function fetchRoomFile(url: string): Promise<Response> {
  const first = await fetch(url, { redirect: "manual" });
  if (first.status >= 300 && first.status < 400) {
    const location = first.headers.get("location");
    if (location) {
      return fetch(location, { redirect: "follow" });
    }
  }
  return first;
}

export interface RoomFilePayload {
  room_id: number;
  dump_key: string;
  expected_count: number;
  records: LyricRecord[];
}

export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 100;

export interface RpcRequest {
  id: number;
  route: string;
  params: Record<string, string>;
}

export interface RpcResponse {
  id: number;
  status: number;
  body: string;
}

export type PartyStub = {
  get(id: string): {
    socket(path?: string): Promise<WebSocket>;
    fetch(pathOrInit?: string | RequestInit): Promise<Response>;
  };
};

let rpcSeq = 0;

export async function warmRoomRpc(
  stub: ReturnType<PartyStub["get"]>
): Promise<void> {
  try {
    const ws = await stub.socket("/rpc");
    ws.send(JSON.stringify({ id: ++rpcSeq, route: "warm", params: {} } satisfies RpcRequest));
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      ws.addEventListener("message", done);
      setTimeout(done, 200);
    });
    try {
      ws.close();
    } catch {}
  } catch {
    // unreachable; retried on a later tick
  }
}

export async function rpcCall(
  stub: ReturnType<PartyStub["get"]>,
  route: string,
  params: Record<string, string>,
  timeoutMs = 30000
): Promise<RpcResponse> {
  const ws = await stub.socket("/rpc");
  const id = ++rpcSeq;
  return new Promise<RpcResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      reject(new Error(`rpc timeout: ${route}`));
    }, timeoutMs);
    ws.addEventListener("message", (event) => {
      try {
        const res = JSON.parse(String(event.data)) as RpcResponse;
        if (res.id === id) {
          clearTimeout(timer);
          try {
            ws.close();
          } catch {}
          resolve(res);
        }
      } catch {
        // ignore malformed messages
      }
    });
    ws.send(JSON.stringify({ id, route, params } satisfies RpcRequest));
  });
}

export function toApiResponse(rec: LyricRecord): Omit<LyricRecord, "nameLower" | "artistNameLower" | "albumNameLower"> {
  return {
    id: rec.id,
    name: rec.trackName,
    trackName: rec.trackName,
    artistName: rec.artistName,
    albumName: rec.albumName,
    duration: rec.duration,
    instrumental: rec.instrumental,
    plainLyrics: rec.plainLyrics,
    syncedLyrics: rec.syncedLyrics,
    lyricsfile: rec.lyricsfile,
  };
}