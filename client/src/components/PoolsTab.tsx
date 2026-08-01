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

const SORTS = [
  { value: "volume_24h:desc", label: "Volume 24h" },
  { value: "tvl:desc", label: "TVL" },
  { value: "fee_tvl_ratio_24h:desc", label: "Fee/TVL 24h" },
  { value: "fee_tvl_ratio_1h:desc", label: "Fee/TVL 1h" },
  { value: "pool_created_at:desc", label: "Newest" },
];

export function PoolsTab() {
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState(SORTS[0].value);
  const [minTvl, setMinTvl] = useState("10000");
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
      const params = new URLSearchParams({ sort_by: sortBy, page_size: "25" });
      if (query.trim()) params.set("query", query.trim());
      // Blacklisted pools are excluded always; the TVL floor keeps dust pools
      // (where a position's rent outweighs any fee it could earn) off the list.
      const filters = ["is_blacklisted=false"];
      if (Number(minTvl) > 0) filters.push(`tvl>${Number(minTvl)}`);
      params.set("filter_by", filters.join(" && "));
      const res = await api.get<{ pools: PoolRow[] }>(`/api/pools?${params}`);
      setRows(res.pools);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [query, sortBy, minTvl]);

  useEffect(() => {
    void search();
    // Re-run on sort/filter changes; typing is submitted explicitly.
  }, [sortBy, minTvl]); // eslint-disable-line react-hooks/exhaustive-deps

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
          <select style={{ flex: 1, minWidth: 140 }} value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
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

      <div className="panel">
        <h2>Pools</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Pair</th>
                <th>Bin step</th>
                <th>Base fee</th>
                <th>Price</th>
                <th>TVL</th>
                <th>Vol 24h</th>
                <th>Fees 24h</th>
                <th>Fee/TVL daily</th>
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
