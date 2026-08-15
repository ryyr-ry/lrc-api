import type { Request as PartyRequest, Room, Server } from "partykit/server";

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

  async onRequest(req: PartyRequest): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/warm") {
      return new Response("OK", { status: 200 });
    }

    if (path === "/info") {
      return new Response(
        JSON.stringify({
          loaded: this.loaded,
          loadTimeMs: this.loadTimeMs,
          lookupSize: this.lookup?.length ?? 0,
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    if (path === "/lookup") {
      if (!this.lookup) {
        return new Response(JSON.stringify({ error: "Index not loaded" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
      const idStr = url.searchParams.get("id");
      if (!idStr) {
        return new Response(JSON.stringify({ error: "id required" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      const id = parseInt(idStr, 10);
      if (isNaN(id) || id < 0 || id >= this.lookup.length) {
        return new Response(JSON.stringify({ error: "id out of range" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      const chunk = this.lookup[id];
      return new Response(JSON.stringify({ chunk }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
}
