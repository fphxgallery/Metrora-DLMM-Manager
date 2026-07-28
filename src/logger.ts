import pino from "pino";
import { Writable } from "node:stream";

export interface LogEntry {
  seq: number;
  time?: string;
  level: number;
  msg?: string;
  [k: string]: unknown;
}

// In-memory ring buffer so the LOGS tab can show recent output. Everything still
// goes to stdout as JSON lines (journald / docker logs) — this only tees.
const MAX = 1000;
let ring: LogEntry[] = [];
let seq = 0;

const bufferStream = new Writable({
  write(chunk, _enc, cb) {
    for (const line of chunk.toString().split("\n")) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as Record<string, unknown>;
        ring.push({ seq: seq++, ...o } as LogEntry);
        if (ring.length > MAX) ring.shift();
      } catch {
        /* ignore non-JSON lines */
      }
    }
    cb();
  },
});

/** Logs newer than `since` (a seq). since < 0 => the recent tail. */
export function getLogs(since = -1): { logs: LogEntry[]; lastSeq: number } {
  const logs = since < 0 ? ring.slice(-300) : ring.filter((e) => e.seq > since);
  return { logs, lastSeq: seq - 1 };
}

export function clearLogs(): void {
  ring = [];
}

const level = process.env.LOG_LEVEL || "info";

export const logger = pino(
  {
    level,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  // multistream defaults each stream to "info"; set it on both so debug-level
  // trigger evaluations reach stdout AND the ring buffer.
  pino.multistream([
    { stream: process.stdout, level },
    { stream: bufferStream, level },
  ]),
);

export type Logger = typeof logger;
