import { describe, test, expect } from "bun:test";
import { roomFileUrl, fetchRoomFile } from "../src/types";
import { RELEASE_TAGS } from "../src/config";

const roomIds = [3, 19, 47, 52, 60, 70, 79, 84, 93, 98];

async function fetchJson(url: string): Promise<{ status: number; text: string }> {
  let lastStatus = 0;
  let lastText = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchRoomFile(url);
      const text = await res.text();
      lastStatus = res.status;
      lastText = text;
      if (res.status === 200 && text.startsWith("{")) {
        return { status: res.status, text };
      }
    } catch (e) {
      lastText = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  return { status: lastStatus, text: lastText };
}

describe("real room fetch from GitHub Releases", () => {
  test("room file exists and has valid payload structure", async () => {
    const url = roomFileUrl(3, RELEASE_TAGS);
    const { status, text } = await fetchJson(url);
    expect(status).toBe(200);
    const payload = JSON.parse(text);
    expect(payload.room_id).toBe(3);
    expect(typeof payload.expected_count).toBe("number");
    expect(Array.isArray(payload.records)).toBe(true);
    expect(payload.records.length).toBe(payload.expected_count);
  });

  test("all test room files are fetchable sequentially", async () => {
    for (const rid of roomIds) {
      const url = roomFileUrl(rid, RELEASE_TAGS);
      const { status } = await fetchJson(url);
      expect(status).toBe(200);
    }
  });

  test("all test room files are fetchable concurrently", async () => {
    const results = await Promise.all(
      roomIds.map(async (rid) => {
        const { status } = await fetchJson(roomFileUrl(rid, RELEASE_TAGS));
        return { rid, status };
      })
    );
    for (const r of results) {
      expect(r.status, `room ${r.rid}`).toBe(200);
    }
  });

  test("missing room returns 404", async () => {
    const url = roomFileUrl(1, RELEASE_TAGS);
    const res = await fetchRoomFile(url);
    expect(res.status).toBe(404);
  });

  test("index files are fetchable", async () => {
    const tag = RELEASE_TAGS[RELEASE_TAGS.length - 1];
    for (const f of ["index-0.bin", "index-1.bin", "index-2.bin", "index-3.bin"]) {
      const res = await fetchRoomFile(
        `https://github.com/ryyr-ry/lrc-api/releases/download/${tag}/${f}`
      );
      expect(res.status, f).toBe(200);
    }
  });

  test("room json is not double-gzipped", async () => {
    const url = roomFileUrl(3, RELEASE_TAGS);
    const { status, text } = await fetchJson(url);
    expect(status).toBe(200);
    expect(text.startsWith("{")).toBe(true);
  });
});