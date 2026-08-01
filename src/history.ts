import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * One reading of a position's economics, taken on a timer.
 *
 * The Data API only ever reports the CURRENT state of a position — there is no
 * historical endpoint — so a chart over time is only possible if we write the
 * samples down ourselves as they happen. Nothing can backfill a window that was
 * never sampled.
 */
export interface PnlSample {
  ts: number;
  positionPk: string;
  /** Fees the position has earned all-time, claimed and unclaimed, in USD. */
  feesUsd: number;
  /** Position PnL in USD, which INCLUDES price divergence, not just fees. */
  pnlUsd: number;
}

/**
 * Append-only sample log, one JSON object per line, in its own file.
 *
 * Deliberately NOT part of state.json. At 15-minute sampling a single position
 * produces ~8,600 rows over a 90-day retention window, and state.json is
 * rewritten in full on every mutation — folding samples in would mean rewriting
 * megabytes each time a poll counter moved. Appending a line costs nothing and
 * cannot corrupt the state file that stands between a crash and stranded funds.
 */
export class SampleLog {
  private file: string;
  private cache?: { mtimeKey: string; rows: PnlSample[] };

  constructor(dataDir: string) {
    this.file = join(dataDir, "samples.jsonl");
  }

  append(samples: PnlSample[]): void {
    if (samples.length === 0) return;
    appendFileSync(this.file, samples.map((s) => JSON.stringify(s)).join("\n") + "\n");
    this.cache = undefined;
  }

  /** Every sample at or after `sinceTs`, oldest first. */
  read(sinceTs = 0): PnlSample[] {
    return this.all().filter((s) => s.ts >= sinceTs);
  }

  /** Timestamp of the earliest sample held, or undefined when the log is empty. */
  earliest(): number | undefined {
    return this.all()[0]?.ts;
  }

  /**
   * Drops samples older than the retention window. Called at boot rather than on
   * every append: rewriting the file is the expensive operation here, and a log
   * slightly over retention costs nothing but disk.
   */
  prune(maxAgeMs: number): number {
    const rows = this.all();
    if (rows.length === 0) return 0;
    const cutoff = Date.now() - maxAgeMs;
    const keep = rows.filter((s) => s.ts >= cutoff);
    if (keep.length === rows.length) return 0;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, keep.map((s) => JSON.stringify(s)).join("\n") + (keep.length ? "\n" : ""));
    renameSync(tmp, this.file);
    this.cache = undefined;
    return rows.length - keep.length;
  }

  /**
   * Drops every sample. Returns how many rows were removed.
   *
   * Written through a temp file and renamed, like `prune`, so a crash mid-write
   * leaves the old log intact rather than a half-truncated one. The sampler may
   * append again moments later; that is fine, since append recreates the file.
   */
  clear(): number {
    const n = this.all().length;
    if (n === 0) return 0;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, "");
    renameSync(tmp, this.file);
    this.cache = undefined;
    return n;
  }

  private all(): PnlSample[] {
    if (!existsSync(this.file)) return [];
    // Re-parsing 8k lines per request is wasteful when nothing has changed, and
    // the file only ever grows by appends, so size+mtime is a sound cache key.
    const raw = readFileSync(this.file, "utf8");
    const key = `${raw.length}`;
    if (this.cache?.mtimeKey === key) return this.cache.rows;
    const rows: PnlSample[] = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        const s = JSON.parse(line) as PnlSample;
        // A truncated final line is expected if the process died mid-append.
        if (typeof s.ts === "number" && typeof s.positionPk === "string") rows.push(s);
      } catch {
        /* skip the partial line */
      }
    }
    rows.sort((a, b) => a.ts - b.ts);
    this.cache = { mtimeKey: key, rows };
    return rows;
  }
}

/** A point on a chart: a timestamp and one USD figure. */
export interface SeriesPoint {
  ts: number;
  usd: number;
}

/**
 * Collapses per-position samples into one series by summing across the positions
 * sampled at the same moment.
 *
 * The sampler writes every managed position under a single shared timestamp, so
 * grouping on `ts` recovers the portfolio-wide figure. Summing across arbitrary
 * timestamps instead would let a position that happened to be sampled twice in a
 * window double-count.
 */
export function aggregateByTs(
  samples: PnlSample[],
  pick: (s: PnlSample) => number,
): SeriesPoint[] {
  const byTs = new Map<number, number>();
  for (const s of samples) byTs.set(s.ts, (byTs.get(s.ts) ?? 0) + pick(s));
  return [...byTs.entries()].sort((a, b) => a[0] - b[0]).map(([ts, usd]) => ({ ts, usd }));
}

/**
 * Thins a series to at most `max` points, keeping the last reading in each bucket
 * and always the final point.
 *
 * A 90-day window at 15-minute sampling is ~8,600 points for a chart a few
 * hundred pixels wide. Sending them all makes the response large and the SVG
 * path enormous for no visible gain. The LAST reading per bucket is kept rather
 * than an average because these are cumulative totals — averaging would drag
 * every point below the true running total.
 */
export function downsample(points: SeriesPoint[], max: number): SeriesPoint[] {
  if (points.length <= max) return points;
  const bucketMs = (points[points.length - 1].ts - points[0].ts) / max;
  if (bucketMs <= 0) return points.slice(-max);
  const out: SeriesPoint[] = [];
  let bucket = -1;
  for (const p of points) {
    const b = Math.floor((p.ts - points[0].ts) / bucketMs);
    if (b !== bucket) {
      out.push(p);
      bucket = b;
    } else {
      out[out.length - 1] = p;
    }
  }
  const last = points[points.length - 1];
  if (out[out.length - 1].ts !== last.ts) out.push(last);
  return out;
}
