import { describe, test, expect } from "bun:test";
import {
  prepareInput,
  hashPartition,
  currentGeneration,
  generationPhase,
  roomFileUrl,
  GENERATION_MS,
} from "../src/types";
import { NUM_GENERATIONS } from "../src/config";

describe("prepareInput", () => {
  test("lowercases and strips punctuation", () => {
    expect(prepareInput("Shape of You!")).toBe("shape of you");
  });
  test("removes apostrophes entirely", () => {
    expect(prepareInput("Don't Stop")).toBe("dont stop");
    expect(prepareInput("Don\u2019t Stop")).toBe("dont stop");
  });
  test("NFKC normalizes fullwidth characters", () => {
    expect(prepareInput("\uFF21\uFF22")).toBe("ab");
  });
  test("collapses whitespace", () => {
    expect(prepareInput("  a   b  ")).toBe("a b");
  });
  test("empty input returns empty string", () => {
    expect(prepareInput("")).toBe("");
  });
});

describe("hashPartition", () => {
  test("matches Python generate_manifest.py fnv1a parity", () => {
    expect(hashPartition("Ed Sheeran", "Shape of You", 3200)).toBe(1183);
    expect(hashPartition("Ed Sheeran", "Castle on the Hill", 3200)).toBe(711);
    expect(hashPartition("The Weeknd", "Blinding Lights", 3200)).toBe(764);
    expect(hashPartition("YOASOBI", "\u30A2\u30A4\u30C9\u30EB", 3200)).toBe(381);
    expect(hashPartition("YOASOBI", "Monster", 3200)).toBe(669);
  });
  test("is deterministic across calls", () => {
    expect(hashPartition("a", "b", 100)).toBe(hashPartition("a", "b", 100));
  });
  test("always returns within range", () => {
    for (let i = 0; i < 1000; i++) {
      const r = hashPartition(`artist${i}`, `track${i}`, 123);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(123);
    }
  });
});

describe("currentGeneration", () => {
  test("0 mod 8 returns generation 0 at epoch", () => {
    expect(currentGeneration(0)).toBe(0);
  });
  test("3 hours later is generation 1", () => {
    expect(currentGeneration(GENERATION_MS)).toBe(1);
  });
  test("24 hours later wraps to generation 0", () => {
    expect(currentGeneration(24 * 3600 * 1000)).toBe(0);
  });
  test("every generation appears exactly once in a day", () => {
    const seen = new Set<number>();
    for (let h = 0; h < 24; h += 3) {
      seen.add(currentGeneration(h * 3600 * 1000));
    }
    expect(seen.size).toBe(NUM_GENERATIONS);
  });
});

describe("generationPhase", () => {
  test("early in generation is stable", () => {
    expect(generationPhase(0, 0.833)).toBe("stable");
  });
  test("middle of generation is stable", () => {
    expect(generationPhase(GENERATION_MS * 0.5, 0.833)).toBe("stable");
  });
  test("after warm-next fraction is warming-next", () => {
    expect(generationPhase(GENERATION_MS * 0.85, 0.833)).toBe("warming-next");
  });
  test("near the end of generation is warming-next", () => {
    expect(generationPhase(GENERATION_MS * 0.99, 0.833)).toBe("warming-next");
  });
  test("exactly at warm-next boundary is warming-next", () => {
    expect(generationPhase(GENERATION_MS * 0.833, 0.833)).toBe("warming-next");
  });
});

describe("roomFileUrl", () => {
  const tags = ["rooms-x-r0", "rooms-x-r1", "rooms-x-r2", "rooms-x-r3"];
  test("computes release index from room id deterministically", () => {
    expect(roomFileUrl(0, tags)).toBe(
      "https://github.com/ryyr-ry/lrc-api/releases/download/rooms-x-r0/room-0000.json.gz"
    );
    expect(roomFileUrl(899, tags)).toBe(
      "https://github.com/ryyr-ry/lrc-api/releases/download/rooms-x-r0/room-0899.json.gz"
    );
    expect(roomFileUrl(900, tags)).toBe(
      "https://github.com/ryyr-ry/lrc-api/releases/download/rooms-x-r1/room-0900.json.gz"
    );
    expect(roomFileUrl(3199, tags)).toBe(
      "https://github.com/ryyr-ry/lrc-api/releases/download/rooms-x-r3/room-3199.json.gz"
    );
  });
  test("pads room id to 4 digits", () => {
    expect(roomFileUrl(7, tags)).toBe(
      "https://github.com/ryyr-ry/lrc-api/releases/download/rooms-x-r0/room-0007.json.gz"
    );
  });
  test("throws for room id beyond release tags", () => {
    expect(() => roomFileUrl(9999, tags)).toThrow();
  });
});