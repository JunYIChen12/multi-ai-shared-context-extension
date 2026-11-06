import type { Clock } from "./types.js";

export function systemClock(): Clock {
  return {
    now: () => new Date().toISOString(),
    id: () => crypto.randomUUID(),
  };
}

export function createTestClock(start = "2026-11-06T00:00:00.000Z"): Clock {
  let n = 0;
  return {
    now: () => {
      n += 1;
      return `${start.slice(0, 19)}.${String(n).padStart(3, "0")}Z`;
    },
    id: () => {
      n += 1;
      return `id-${n}`;
    },
  };
}
