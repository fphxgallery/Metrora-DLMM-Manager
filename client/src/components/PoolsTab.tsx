import { useCallback, useEffect, useState } from "react";
import { api } from "../api.ts";
import { BinChart, type Bin } from "./BinChart.tsx";
import { ApeForm } from "./ApeForm.tsx";
import { OpenPositionForm } from "./OpenPositionForm.tsx";
import { fmtNum, fmtPct, fmtPrice, fmtUsd } from "../format.ts";

export interface PoolRow {
  address: string;
  name: string;
  binStep: number;
  baseFeePct: number;
  tvl: number;
  currentPrice: number;
  /** Daily fee/TVL percentage. The API calls this "apr"; it is a DAILY rate. */
  feeTvlDailyPct: number;
  volume24h: number;
  fees24h: number;
  hasFarm: boolean;
  isBlacklisted: boolean;
  tokenX: { symbol: string; mint: string; decimals: number; priceUsd: number };
  tokenY: { symbol: string; mint: string; decimals: number; priceUsd: number };
}

export interface PoolDetail {
  address: string;
  name: string;
  binStep: number;
  activeBinId: number;
  activePrice: number;
  baseFeePct: number;
  totalFeePct: number;
  variableFeePct: number;
  maxFeePct: number;
  tvl: number | null;
  feeTvlDailyPct: number | null;
  volume24h: number | null;
  fees24h: number | null;
  isBlacklisted: boolean;
  tokenX: { mint: string; symbol: string; decimals: number; priceUsd: number };
  tokenY: { mint: string; symbol: string; decimals: number; priceUsd: number };
  /** null when no wallet is configured. */
  walletBalances: { x: number; y: number } | null;
  suggestedRange: { minBinId: number; maxBinId: number; rangeBins: number; minPrice: number; maxPrice: number };
  bins: Bin[];
}

/** Common Meteora DLMM bin steps. Exact-match, not a threshold — bin step is a
    pool setting you want a specific value of, not a "more/less than" quantity. */
const BIN_STEPS = [1, 2, 4, 5, 8, 10, 15, 20, 25, 50, 80, 100, 125, 200, 250, 400];

/**
 * A clickable column header. Backed by a real sort field on Meteora's Data
 * API — checked live against the API's own 400 response, which names every
 * field it accepts. Pair name and price have no such field, so those columns
 * stay plain `<th>`s rather than a click that silently does nothing.
 */
function SortHeader({
  field,
  label,
  active,
  dir,
  onSort,
}: {
  field: string;
  label: string;
  active: string;
  dir: "asc" | "desc";
  onSort: (field: string) => void;
}) {
  const isActive = field === active;
  return (
    <th className={`sortable${isActive ? " active" : ""}`}>
      <button type="button" onClick={() => onSort(field)}>
        {label}
        {isActive && <span className="sort-arrow">{dir === "desc" ? "▾" : "▴"}</span>}
      </button>
    </th>
  );
}

export function PoolsTab() {
  const [query, setQuery] = useState("");
  const [sortField, setSortField] = useState("volume_24h");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [minTvl, setMinTvl] = useState("10000");
  // "" means no filter — Meteora's exact-match grammar has no wildcard, so
  // "any bin step" has to be the absence of the clause rather than a value.
  const [binStep, setBinStep] = useState("");
  const [rows, setRows] = useState<PoolRow[]>([]);
  const [selected, setSelected] = useState<PoolDetail | null>(null);
  // Ape replaces the open form rather than sitting beside it — two ways to spend
  // the same wallet, side by side, is a way to click the wrong one.
  const [aping, setAping] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const search = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const params = new URLSearchParams({ sort_by: `${sortField}:${sortDir}`, page_size: "25" });
      if (query.trim()) params.set("query", query.trim());
      // Blacklisted pools are excluded always; the TVL floor keeps dust pools
      // (where a position's rent outweighs any fee it could earn) off the list.
      const filters = ["is_blacklisted=false"];
      if (Number(minTvl) > 0) filters.push(`tvl>${Number(minTvl)}`);
      if (binStep) filters.push(`bin_step=${binStep}`);
      params.set("filter_by", filters.join(" && "));
      const res = await api.get<{ pools: PoolRow[] }>(`/api/pools?${params}`);
      setRows(res.pools);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [query, sortField, sortDir, minTvl, binStep]);

  useEffect(() => {
    void search();
    // Re-run on sort/filter changes; typing is submitted explicitly.
  }, [sortField, sortDir, minTvl, binStep]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Clicking a header sorts by it, descending first — the default for every
      column here (bin step included) is "most first". A second click on the
      same column flips direction; clicking a different column resets to desc. */
  function toggleSort(field: string) {
    if (field === sortField) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else {
      setSortField(field);
      setSortDir("desc");
    }
  }

  async function select(address: string) {
    setError("");
    try {
      setSelected(await api.get<PoolDetail>(`/api/pools/${address}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <>
      <div className="panel">
        <h2>Find a pool</h2>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
        >
          <input
            style={{ flex: 2, minWidth: 180 }}
            placeholder="token, pair name, or pool address"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select style={{ flex: 1, minWidth: 110 }} value={binStep} onChange={(e) => setBinStep(e.target.value)}>
            <option value="">any bin step</option>
            {BIN_STEPS.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
          <select style={{ flex: 1, minWidth: 130 }} value={minTvl} onChange={(e) => setMinTvl(e.target.value)}>
            <option value="0">any TVL</option>
            <option value="10000">TVL &gt; $10k</option>
            <option value="100000">TVL &gt; $100k</option>
            <option value="1000000">TVL &gt; $1M</option>
          </select>
          <button className="btn primary" disabled={busy}>
            {busy ? "…" : "SEARCH"}
          </button>
        </form>
      </div>

      {error && <div className="msg err">{error}</div>}

      {/* Between the search panel and the results table, not below the table:
          INSPECT is how you get here, so the answer belongs above the list you
          just clicked out of, not past it. */}
      {selected && (
        <>
          <PoolDetailPanel detail={selected} onClose={() => setSelected(null)} onApe={() => setAping(true)} />
          {aping ? (
            <ApeForm
              pool={selected}
              onOpened={() => void select(selected.address)}
              onClose={() => setAping(false)}
            />
          ) : (
            <OpenPositionForm pool={selected} onOpened={() => void select(selected.address)} />
          )}
        </>
      )}

      <div className="panel">
        <h2>Pools</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Pair</th>
                <SortHeader field="bin_step" label="Bin step" active={sortField} dir={sortDir} onSort={toggleSort} />
                <SortHeader field="fee_pct" label="Base fee" active={sortField} dir={sortDir} onSort={toggleSort} />
                <th>Price</th>
                <SortHeader field="tvl" label="TVL" active={sortField} dir={sortDir} onSort={toggleSort} />
                <SortHeader field="volume_24h" label="Vol 24h" active={sortField} dir={sortDir} onSort={toggleSort} />
                <SortHeader field="fee_24h" label="Fees 24h" active={sortField} dir={sortDir} onSort={toggleSort} />
                <SortHeader
                  field="fee_tvl_ratio_24h"
                  label="Fee/TVL daily"
                  active={sortField}
                  dir={sortDir}
                  onSort={toggleSort}
                />
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={9} className="faint">
                    {busy ? "searching…" : "no pools"}
                  </td>
                </tr>
              )}
              {rows.map((p) => (
                <tr key={p.address}>
                  <td>
                    {p.name} {p.hasFarm && <span className="pill good">farm</span>}
                  </td>
                  <td>{p.binStep}</td>
                  <td>{fmtPct(p.baseFeePct)}</td>
                  <td>{fmtPrice(p.currentPrice)}</td>
                  <td>{fmtUsd(p.tvl)}</td>
                  <td>{fmtUsd(p.volume24h)}</td>
                  <td>{fmtUsd(p.fees24h)}</td>
                  <td>{fmtPct(p.feeTvlDailyPct, 3)}</td>
                  <td>
                    <button className="btn" onClick={() => void select(p.address)}>
                      INSPECT
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function PoolDetailPanel({
  detail,
  onClose,
  onApe,
}: {
  detail: PoolDetail;
  onClose: () => void;
  onApe: () => void;
}) {
  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>
          {detail.name} <span className="faint">bin step {detail.binStep}</span>
        </h2>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn primary" onClick={onApe}>
            APE
          </button>
          <button className="btn" onClick={onClose}>
            CLOSE
          </button>
        </div>
      </div>

      <div className="tiles" style={{ margin: "12px 0" }}>
        <Tile label="Active price" value={fmtPrice(detail.activePrice)} sub={`bin ${detail.activeBinId}`} />
        <Tile label="Fee now" value={fmtPct(detail.totalFeePct)} sub={`base ${fmtPct(detail.baseFeePct)} + var ${fmtPct(detail.variableFeePct)}`} />
        <Tile label="TVL" value={detail.tvl == null ? "—" : fmtUsd(detail.tvl)} />
        <Tile label="Vol 24h" value={detail.volume24h == null ? "—" : fmtUsd(detail.volume24h)} />
        <Tile label="Fees 24h" value={detail.fees24h == null ? "—" : fmtUsd(detail.fees24h)} />
        {/* Not an APY: Meteora's own annualised figure is naive compounding of this
            same daily rate, and on a thin pool with one good day it overflows to
            nonsense (up to their 2^64-1 sentinel). This daily rate is the number
            that's actually true right now. */}
        <Tile label="Fee/TVL 24h" value={detail.feeTvlDailyPct == null ? "—" : fmtPct(detail.feeTvlDailyPct, 3)} />
      </div>

      <BinChart
        bins={detail.bins}
        activeBinId={detail.activeBinId}
        range={detail.suggestedRange}
        symbolX={detail.tokenX.symbol}
        symbolY={detail.tokenY.symbol}
      />

      <div className="faint" style={{ marginTop: 10 }}>
        Dashed band = the default range for a new position here: ±{detail.suggestedRange.rangeBins} bins,{" "}
        {fmtPrice(detail.suggestedRange.minPrice)} – {fmtPrice(detail.suggestedRange.maxPrice)} (
        {fmtNum(detail.suggestedRange.maxBinId - detail.suggestedRange.minBinId + 1)} bins wide).
      </div>
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="tile">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="faint">{sub}</div>}
    </div>
  );
}
