import type { RpcRequest } from "./types";
import type { Request as PartyRequest, Room, Server, Connection } from "partykit/server";

export default class IndexServer implements Server {
  room: Room;
  loaded = false;
  loadTimeMs = 0;
  lookup: Uint16Array | null = null;

  constructor(room: Room) {
    this.room = room;
  }

  async onStart() {
    const t0 = Date.now();
    const buffers: ArrayBuffer[] = [];

    for (let part = 0; ; part++) {
      const path = `/data/index-${part}.bin`;
      try {
        const res = await this.room.context.assets.fetch(path);
        if (!res || res.status !== 200) break;
        const ab = await res.arrayBuffer();
        buffers.push(ab);
      } catch (e) {
        console.error(`Failed to load ${path}: ${e}`);
        break;
      }
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
    this.loaded = true;
    this.loadTimeMs = Date.now() - t0;
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
    if (req.route === "warm") {
      return { status: 200, body: "OK" };
    }
    if (req.route !== "lookup") {
      return { status: 404, body: JSON.stringify({ error: "Not found" }) };
    }
    if (!this.lookup) {
      return { status: 503, body: JSON.stringify({ error: "Index not loaded" }) };
    }
    const idStr = req.params.id;
    if (!idStr) {
      return { status: 400, body: JSON.stringify({ error: "id required" }) };
    }
    const id = parseInt(idStr, 10);
    if (isNaN(id) || id < 0 || id >= this.lookup.length) {
      return { status: 400, body: JSON.stringify({ error: "id out of range" }) };
    }
    const chunk = this.lookup[id];
    return { status: 200, body: JSON.stringify({ chunk }) };
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
          loaded: this.loaded,
          loadTimeMs: this.loadTimeMs,
          lookupSize: this.lookup?.length ?? 0,
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    if (route === "lookup") {
      const params: Record<string, string> = {};
      for (const [k, v] of url.searchParams.entries()) {
        params[k] = v;
      }
      const result = await this.routeRpc({ id: 0, route: "lookup", params });
      return new Response(result.body, {
        status: result.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
}
