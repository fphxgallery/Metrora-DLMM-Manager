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

interface Metrics {
  solPriceUsd: number;
  rebalanceCount: number;
  pathA: number;
  pathB: number;
  costLamports: number;
  costUsd: number;
  /** Rebalances of positions no longer managed — excluded from every figure above. */
  retiredCount: number;
  retiredCostUsd: number;
  feesEarnedUsd: number;
  netUsd: number;
  costDragPct: number | null;
  timeInRangePct: number | null;
  pollsTotal: number;
  medianGapMin: number | null;
  minGapMin: number | null;
  /** The cooldown the measured gaps were subject to — the yardstick for "short". */
  cooldownMin: number;
  managed: number;
  autoManaged: number;
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

  // Churn is the position re-centring about as fast as the cooldown permits, so
  // the yardstick is the cooldown those gaps were subject to — not a fixed number,
  // which would read as alarming on a 60-minute cooldown and unremarkable on a
  // 5-minute one. The floor covers COOLDOWN_MIN=0, where every gap would qualify.
  const churning = m.medianGapMin != null && m.medianGapMin <= Math.max(m.cooldownMin * 1.5, 5);

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

      <HistoryCharts />

      <div className="panel">
        <h2>All time</h2>
        <div className="tiles">
          <Tile label="Fees earned" value={fmtUsd(m.feesEarnedUsd)} sub="managed positions" cls="good" />
          <Tile
            label="Rebalance cost"
            value={fmtUsd(m.costUsd)}
            sub={`${fmtNum(m.costLamports / 1e9, 5)} SOL in fees + rent`}
            cls="bad"
          />
          <Tile
            label="Net"
            value={fmtUsd(m.netUsd)}
            sub="fees earned minus rebalance cost"
            cls={m.netUsd >= 0 ? "good" : "bad"}
          />
          <Tile
            label="Cost drag"
            value={m.costDragPct == null ? "—" : fmtPct(m.costDragPct, 1)}
            sub="share of fee income spent rebalancing"
            cls={m.costDragPct != null && m.costDragPct > 50 ? "bad" : undefined}
          />
        </div>
        {m.retiredCount > 0 && (
          <p className="note">
            Excludes {fmtNum(m.retiredCount)} rebalance{m.retiredCount === 1 ? "" : "s"} of closed positions
            ({fmtUsd(m.retiredCostUsd)}). Fee income can only be read for positions still managed, so counting
            that spending here would compare a closed position's cost with a current one's earnings.
          </p>
        )}
      </div>

      <div className="panel">
        <h2>Behaviour</h2>
        <div className="tiles">
          <Tile
            label="Time in range"
            value={m.timeInRangePct == null ? "—" : fmtPct(m.timeInRangePct, 1)}
            sub={`${fmtNum(m.pollsTotal)} polls sampled`}
          />
          <Tile label="Rebalances" value={fmtNum(m.rebalanceCount)} sub={`${m.pathA} atomic · ${m.pathB} with swap`} />
          <Tile
            label="Median gap"
            value={m.medianGapMin == null ? "—" : `${fmtNum(m.medianGapMin)}m`}
            // The shortest gap is the sharper churn reading, so it stays visible
            // next to the value now that the guidance occupies the sub slot.
            valueNote={m.minGapMin == null ? undefined : `shortest ${fmtNum(m.minGapMin)}m`}
            // One flag drives the colour and the advice, so the tile cannot show an
            // unremarkable number with a fix suggested underneath it.
            sub={churning ? "Raise COOLDOWN_MIN or widen RANGE_BINS." : undefined}
            cls={churning ? "warn" : undefined}
          />
          <Tile label="Managed" value={fmtNum(m.managed)} sub={`${m.autoManaged} on auto`} />
        </div>
      </div>

      {m.perPosition.length > 0 && (
        <div className="panel">
          <h2>Per position</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Pair</th>
                  <th>Position</th>
                  <th>Auto</th>
                  <th>Rebalances</th>
                  <th>Last</th>
                  <th>Time in range</th>
                </tr>
              </thead>
              <tbody>
                {m.perPosition.map((p) => (
                  <tr key={p.positionPk}>
                    <td>{p.pairName ?? "—"}</td>
                    <td>{shortPk(p.positionPk)}</td>
                    <td>{p.auto ? <span className="pill good">on</span> : <span className="pill">off</span>}</td>
                    <td>{fmtNum(p.rebalanceCount)}</td>
                    <td>{fmtAgo(p.lastRebalanceAt)}</td>
                    <td>{p.timeInRangePct == null ? "—" : fmtPct(p.timeInRangePct, 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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

function Tile({
  label,
  value,
  valueNote,
  sub,
  cls,
}: {
  label: string;
  value: string;
  /** A secondary figure kept on the value line, for tiles whose sub carries prose. */
  valueNote?: string;
  sub?: string;
  cls?: string;
}) {
  return (
    <div className="tile">
      <div className="label">{label}</div>
      <div className={`value ${cls ?? ""}`}>
        {value}
        {valueNote && <span className="value-note">{valueNote}</span>}
      </div>
      {sub && <div className="faint">{sub}</div>}
    </div>
  );
}
