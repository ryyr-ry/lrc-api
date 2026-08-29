// TEST CONFIG - pointing at rooms-test release
export const TOTAL_ROOMS = 100;
export const ROOMS_PER_RELEASE = 900;
export const RELEASE_BASE_URL = "https://github.com/ryyr-ry/lrc-api/releases/download";
export const RELEASE_TAGS = [
  "rooms-test",
];
export const GENERATION_HOURS = 3;
export const NUM_GENERATIONS = 8;
export const WARM_NEXT_FRACTION = 0.833;
export const LOAD_MAX_ATTEMPTS = 5;
export const LOAD_RETRY_BASE_DELAY_MS = 2000;
export const VERSION = "0.2.0";
export const DB_LIST_URL = "https://lrclib-db-dumps.bu3nnyut4y9jfkdg.workers.dev/";
export const WARM_CRON_NAME = "warm";
export const NUM_SUPERS = 2;
export const NUM_SUBS = 1;
export const NUM_AGGREGATORS = 4;
export const CHUNKS_PER_AGG = 50;
export const SUBS_PER_SUPER = 4;