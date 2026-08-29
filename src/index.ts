import type { RpcRequest } from "./types";
import { fetchRoomFile } from "./types";
import { RELEASE_TAGS, LOAD_MAX_ATTEMPTS, LOAD_RETRY_BASE_DELAY_MS, INDEX_FILES } from "./config";
import type { Request as PartyRequest, Room, Server, Connection } from "partykit/server";

export type IndexState = "unloaded" | "loading" | "ready";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const INDEX_FILENAMES: string[] = [];
for (let i = 0; i < INDEX_FILES; i++) {
  INDEX_FILENAMES.push(`index-${i}.bin`);
}

export default class IndexServer implements Server {
  room: Room;
  state: IndexState = "unloaded";
  lookup: Uint16Array | null = null;
  loadTimeMs = 0;
  lastError = "";
  loadAttempts = 0;

  private loadPromise: Promise<boolean> | null = null;

  constructor(room: Room) {
    this.room = room;
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

  private indexFileUrl(filename: string): string {
    const tag = RELEASE_TAGS[RELEASE_TAGS.length - 1];
    if (!tag) {
      throw new Error("no release tag for index files");
    }
    return `https://github.com/ryyr-ry/lrc-api/releases/download/${tag}/${filename}`;
  }

  private async tryLoad(): Promise<boolean> {
    this.state = "loading";
    const t0 = Date.now();

    for (let attempt = 0; attempt < LOAD_MAX_ATTEMPTS; attempt++) {
      try {
        const buffers: ArrayBuffer[] = [];
        for (const filename of INDEX_FILENAMES) {
          const url = this.indexFileUrl(filename);
          const res = await fetchRoomFile(url);
          if (!res.ok) {
            this.lastError = `fetch ${url} -> ${res.status}`;
            throw new Error(this.lastError);
          }
          buffers.push(await res.arrayBuffer());
        }

        let totalBytes = 0;
        for (const buf of buffers) {
          totalBytes += buf.byteLength;
        }

        const merged = new ArrayBuffer(totalBytes);
        const view = new Uint16Array(merged);
        let offset = 0;
        for (const ab of buffers) {
          const partView = new Uint16Array(ab);
          view.set(partView, offset);
          offset += partView.length;
        }

        this.lookup = view;
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
        message: `index not ready (${this.state}): ${this.lastError}`,
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
        state: this.state,
        lookupSize: this.lookup?.length ?? 0,
        loadTimeMs: this.loadTimeMs,
        loadAttempts: this.loadAttempts,
        lastError: this.lastError,
      });
    }

    const g = this.gate();
    if (g) return g;

    if (route === "lookup") {
      const idStr = url.searchParams.get("id");
      if (!idStr) {
        return jsonResponse({ error: "id required" }, 400);
      }
      const id = parseInt(idStr, 10);
      if (isNaN(id) || id < 0 || !this.lookup || id >= this.lookup.length) {
        return jsonResponse({ error: "id out of range" }, 400);
      }
      const chunk = this.lookup[id];
      return jsonResponse({ chunk });
    }

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
    if (route === "lookup") {
      const idStr = url.searchParams.get("id");
      if (!idStr) {
        return jsonResponse({ error: "id required" }, 400);
      }
      const id = parseInt(idStr, 10);
      if (isNaN(id) || id < 0 || !this.lookup || id >= this.lookup.length) {
        return jsonResponse({ error: "id out of range" }, 400);
      }
      const chunk = this.lookup[id];
      return jsonResponse({ chunk });
    }
    return jsonResponse({ error: "Not found" }, 404);
  }

  async onAlarm() {
    if (this.state !== "ready") {
      await this.ensureLoaded();
    }
    await this.room.storage.setAlarm(Date.now() + 60 * 1000);
  }
}