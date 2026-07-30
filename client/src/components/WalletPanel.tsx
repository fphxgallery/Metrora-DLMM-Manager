import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api.ts";
import { fmtAmount, fmtUsd, shortPk } from "../format.ts";

export interface TokenAccountView {
  pubkey: string;
  mint: string;
  programId: string;
  amountRaw: string;
  decimals: number;
  uiAmount: number;
  rentLamports: number;
  symbol: string | null;
  usdPrice: number | null;
  usdValue: number | null;
  lockedReason: string | null;
  inUse: boolean;
  unwrapsToSol: boolean;
}

export interface WalletTokens {
  wallet: string | null;
  solBalance: number;
  solPriceUsd: number;
  totalUsd: number;
  reclaimableLamports: number;
  protectionComplete: boolean;
  accounts: TokenAccountView[];
}

const LAMPORTS = 1_000_000_000;

/** Jupiter knows most mints; an airdrop it has never seen still needs a name. */
function label(a: TokenAccountView): string {
  return a.symbol ?? shortPk(a.mint);
}

/**
 * The wallet bar: every balance as a chip, with the token accounts behind an
 * expander.
 *
 * The chips answer "what do I hold"; the table answers "which of these accounts
 * is costing me rent, and may I close it". They are separate because closing
 * signs a transaction against real funds, and some accounts must not be closed
 * at all — the table is the only place with room to say which and why.
 */
export function WalletPanel({
  solBalance,
  wallet,
  onRefresh,
}: {
  solBalance: number | undefined;
  wallet: string | null | undefined;
  onRefresh: () => void | Promise<void>;
}) {
  const [data, setData] = useState<WalletTokens | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const d = await api.get<WalletTokens>("/api/wallet/tokens");
      setData(d);
      // Drop anything that has since become unclosable rather than leaving a
      // stale tick behind — the server would refuse it anyway.
      setPicked((prev) => {
        const live = new Set(d.accounts.filter((a) => a.lockedReason === null).map((a) => a.pubkey));
        return new Set([...prev].filter((p) => live.has(p)));
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);

  /**
   * The table's rows. A managed position's own token accounts are dropped
   * entirely rather than shown disabled: they can never be closed, so a row
   * offering nothing to do is just noise. They still appear as chips, and the
   * server blocks them regardless of what this list contains.
   */
  const listed = useMemo(
    () => (data?.accounts ?? []).filter((a) => !a.inUse),
    [data],
  );
  const closable = useMemo(() => (data?.accounts ?? []).filter((a) => a.lockedReason === null), [data]);
  const pickedRent = useMemo(
    () => closable.filter((a) => picked.has(a.pubkey)).reduce((s, a) => s + a.rentLamports, 0),
    [closable, picked],
  );

  const solUsd = (data?.solBalance ?? solBalance ?? 0) * (data?.solPriceUsd ?? 0);

  async function claim() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.post<{ dryRun: boolean; signature?: string; closed: string[]; reclaimedLamports: number }>(
        "/api/wallet/close-accounts",
        { accounts: [...picked] },
      );
      setMsg({
        kind: "ok",
        text: r.dryRun
          ? `DRY-RUN — would close ${r.closed.length} account(s) for ${(r.reclaimedLamports / LAMPORTS).toFixed(5)} SOL`
          : `closed ${r.closed.length} account(s), reclaimed ${(r.reclaimedLamports / LAMPORTS).toFixed(5)} SOL`,
      });
      setPicked(new Set());
      await load();
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  const addr = data?.wallet ?? wallet ?? null;

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="row" style={{ gap: 16, marginBottom: data ? 8 : 0 }}>
            <span className="faint">wallet</span>
            <span>{addr ? shortPk(addr) : <span className="warn">none — create one in SETTINGS</span>}</span>
            {data && (
              <>
                <span className="faint">total</span>
                <span>{fmtUsd(data.totalUsd)}</span>
              </>
            )}
          </div>

          <div className="wal-chips">
            <span className="chip">
              <span className="sym">SOL</span>
              <span className="amt">{fmtAmount(data?.solBalance ?? solBalance)}</span>
              {solUsd > 0 && <span className="usd">{fmtUsd(solUsd)}</span>}
            </span>
            {(data?.accounts ?? [])
              .filter((a) => a.uiAmount > 0)
              .map((a) => (
                <span key={a.pubkey} className="chip" title={a.mint}>
                  <span className="sym">{label(a)}</span>
                  <span className="amt">{fmtAmount(a.uiAmount)}</span>
                  {a.usdValue !== null && <span className="usd">{fmtUsd(a.usdValue)}</span>}
                </span>
              ))}
          </div>
        </div>

        {/* Refresh on top, the expander beneath it — both right-aligned, so the
            claim state reads as part of the action column rather than the
            wallet's identity line. */}
        <div className="wal-actions">
          <button
            className="btn"
            disabled={busy}
            onClick={() => {
              void load();
              void onRefresh();
            }}
          >
            {busy ? "…" : "REFRESH"}
          </button>
          {listed.length > 0 && (
            <button className="chip link" onClick={() => setOpen((v) => !v)}>
              {open ? "▴" : "▾"} {listed.length} TOKEN ACCOUNT{listed.length === 1 ? "" : "S"}
              {data!.reclaimableLamports > 0 && (
                <span className="warn"> · {(data!.reclaimableLamports / LAMPORTS).toFixed(5)} SOL CLAIMABLE</span>
              )}
            </button>
          )}
        </div>
      </div>

      {error && <div className="msg err" style={{ marginTop: 10 }}>{error}</div>}

      {open && data && listed.length > 0 && (
        <>
          <table className="wal">
            <thead>
              <tr>
                <th style={{ width: 24 }} />
                <th>TOKEN</th>
                <th className="num">BALANCE</th>
                <th className="num">USD</th>
                <th className="num">RENT</th>
                <th>ACCOUNT</th>
              </tr>
            </thead>
            <tbody>
              {listed.map((a) => (
                <tr key={a.pubkey}>
                  <td>
                    <input
                      type="checkbox"
                      style={{ width: "auto" }}
                      // Hard-blocked, not merely warned: closing an in-use account
                      // costs the same rent again on the next rebalance.
                      disabled={a.lockedReason !== null}
                      checked={picked.has(a.pubkey)}
                      onChange={(e) =>
                        setPicked((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(a.pubkey);
                          else next.delete(a.pubkey);
                          return next;
                        })
                      }
                    />
                  </td>
                  <td title={a.mint}>{label(a)}</td>
                  <td className="num">{a.uiAmount === 0 ? "0" : fmtAmount(a.uiAmount)}</td>
                  {/* An empty account's "$0.00" is noise — the point of the row is its rent. */}
                  <td className="num">
                    {a.usdValue === null || a.uiAmount === 0 ? <span className="faint">—</span> : fmtUsd(a.usdValue)}
                  </td>
                  <td className={`num ${a.lockedReason === null ? "warn" : "faint"}`}>
                    {(a.rentLamports / LAMPORTS).toFixed(5)}
                  </td>
                  <td>
                    {a.lockedReason === null ? (
                      <span className="tag rent">{a.unwrapsToSol ? "UNWRAPS TO SOL" : "CLOSABLE"}</span>
                    ) : (
                      <span className="tag">{a.lockedReason}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {msg && <div className={`msg ${msg.kind === "err" ? "err" : "ok"}`} style={{ marginTop: 10 }}>{msg.text}</div>}

          <div className="row" style={{ justifyContent: "space-between", marginTop: 10 }}>
            <span className="faint">
              {picked.size === 0 ? (
                closable.length > 0 ? (
                  `${closable.length} account(s) closable · ${(data.reclaimableLamports / LAMPORTS).toFixed(5)} SOL`
                ) : (
                  "nothing to claim — every account listed holds a balance"
                )
              ) : (
                <>
                  {picked.size} selected · reclaims <b className="warn">{(pickedRent / LAMPORTS).toFixed(5)} SOL</b>
                  {data.solPriceUsd > 0 && ` (${fmtUsd((pickedRent / LAMPORTS) * data.solPriceUsd)})`}
                </>
              )}
            </span>
            <button className="btn primary" disabled={busy || picked.size === 0} onClick={() => void claim()}>
              CLAIM RENT
            </button>
          </div>

          {!data.protectionComplete && (
            <div className="msg" style={{ marginTop: 10, borderColor: "var(--warn)" }}>
              <b className="warn">A pool's tokens could not be read.</b> A managed position's accounts are normally
              hidden here; right now one may be listed that should not be. The claim itself still refuses them.
            </div>
          )}
        </>
      )}
    </div>
  );
}
