import { useCallback, useEffect, useState } from "react";
import { api } from "../api.ts";
import { fmtAgo, fmtNum, fmtPct, fmtUsd, shortPk } from "../format.ts";
import { HistoryCharts } from "./HistoryCharts.tsx";

interface RebalanceRecord {
  ts: number;
  positionPk: string;
  path: "A" | "B";
  fromRange: [number, number];
  toRange: [number, number];
  costLamports: number;
  rentLamports: number;
  sigs: string[];
}

// Only what this tab still reads. The totals that used to sit in an "all time"
// panel now come from /api/history with tf=ALL, so the chart and the lifetime
// figures cannot drift apart.
interface Metrics {
  solPriceUsd: number;
  pathA: number;
  pathB: number;
  medianGapMin: number | null;
  minGapMin: number | null;
  /** The cooldown the measured gaps were subject to — the yardstick for "short". */
  cooldownMin: number;
  recent: RebalanceRecord[];
  perPosition: {
    positionPk: string;
    pairName?: string;
    auto: boolean;
    rebalanceCount: number;
    lastRebalanceAt?: number;
    timeInRangePct: number | null;
  }[];
}

interface JournalEntry {
  id: string;
  positionPk: string;
  path: "A" | "B";
  phase: string;
  targetMinBinId: number;
  targetMaxBinId: number;
  startedAt: number;
  error?: string;
  sigs: string[];
}

export function MetricsTab() {
  const [m, setM] = useState<Metrics | null>(null);
  const [journal, setJournal] = useState<{ pending: JournalEntry[]; all: JournalEntry[] } | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [metrics, j] = await Promise.all([
        api.get<Metrics>("/api/metrics"),
        api.get<{ pending: JournalEntry[]; all: JournalEntry[] }>("/api/journal"),
      ]);
      setM(metrics);
      setJournal(j);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  if (error) return <div className="msg err">{error}</div>;
  if (!m) return <div className="panel faint">loading…</div>;

  return (
    <>
      {journal && journal.pending.length > 0 && (
        <div className="panel" style={{ borderColor: "var(--bad)" }}>
          <h2 className="bad">Unfinished rebalances</h2>
          <div className="faint" style={{ marginBottom: 10 }}>
            These stopped part-way. Funds may be sitting in the wallet rather than in the position — the app resumes
            them at the next restart.
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Position</th>
                  <th>Path</th>
                  <th>Stopped at</th>
                  <th>Target range</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {journal.pending.map((j) => (
                  <tr key={j.id}>
                    <td>{fmtAgo(j.startedAt)}</td>
                    <td>{shortPk(j.positionPk)}</td>
                    <td>{j.path}</td>
                    <td className="bad">{j.phase}</td>
                    <td>
                      {j.targetMinBinId}…{j.targetMaxBinId}
                    </td>
                    <td className="faint">{j.error ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* A reset clears the cost ledger, which is also what the tiles and the
          RECENT REBALANCES table below are built from — without this they keep
          showing the cleared rows until the 30s poll catches up. */}
      <HistoryCharts
        cadence={{ medianGapMin: m.medianGapMin, minGapMin: m.minGapMin, cooldownMin: m.cooldownMin }}
        onReset={load}
      />

      {/* One line per position instead of a table. Every figure here belongs to the
          POSITION rather than to the chart's window, which is why it is not a tile
          row: mixing the two invites reading a lifetime number as a windowed one. */}
      {m.perPosition.length > 0 && (
        <div className="panel">
          {m.perPosition.map((p) => (
            <div className="pos-line" key={p.positionPk}>
              <b>{p.pairName ?? "—"}</b>
              <span className="faint">{shortPk(p.positionPk)}</span>
              {p.auto ? <span className="pill good">auto</span> : <span className="pill">manual</span>}
              <span>{p.timeInRangePct == null ? "—" : fmtPct(p.timeInRangePct, 1)} in range</span>
              <span>
                {fmtNum(p.rebalanceCount)} rebalances
                {/* pathA/pathB are totals across every managed position, so the split
                    is only truthful next to a position when there is just the one.
                    With two, each line would claim the other's rebalances.
                    The count itself comes from the position and the split from the
                    cost ledger, so after a history reset the ledger is empty while
                    the count is not — "4 rebalances (0 atomic · 0 swap)" reads as a
                    bug. Drop the split until the ledger has something to say. */}
                {m.perPosition.length === 1 && m.pathA + m.pathB > 0 && (
                  <span className="faint">
                    {" "}
                    ({m.pathA} atomic · {m.pathB} swap)
                  </span>
                )}
              </span>
              <span className="faint">last {fmtAgo(p.lastRebalanceAt)}</span>
            </div>
          ))}
        </div>
      )}

      <div className="panel">
        <h2>Recent rebalances</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Position</th>
                <th>Path</th>
                <th>Range</th>
                <th>Cost</th>
                <th>Txs</th>
              </tr>
            </thead>
            <tbody>
              {m.recent.length === 0 && (
                <tr>
                  <td colSpan={6} className="faint">
                    no rebalances yet
                  </td>
                </tr>
              )}
              {m.recent.map((r) => (
                <tr key={`${r.ts}-${r.positionPk}`}>
                  <td>{fmtAgo(r.ts)}</td>
                  <td>{shortPk(r.positionPk)}</td>
                  <td>{r.path === "A" ? "atomic" : "swap"}</td>
                  <td>
                    {r.fromRange[0]}…{r.fromRange[1]} → {r.toRange[0]}…{r.toRange[1]}
                  </td>
                  <td>{fmtUsd(((r.costLamports + r.rentLamports) / 1e9) * m.solPriceUsd)}</td>
                  <td className="faint">{r.sigs.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

