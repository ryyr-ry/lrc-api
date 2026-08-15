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

export function prepareInput(text: string): string {
  const punct = /[`~!@#$%^&*()_|+\-=?;:",.<>{}[\]\\/\0\n]/g;
  let s = text.normalize("NFKC").toLowerCase();
  s = s.replace(punct, " ");
  s = s.replace(/['\u2019]/g, "");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

export function hashPartition(artistName: string, trackName: string, numChunks: number): number {
  const key = prepareInput(artistName) + " " + prepareInput(trackName);
  const bytes = new TextEncoder().encode(key);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % numChunks;
}

export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 100;

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
