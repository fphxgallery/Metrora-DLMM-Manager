import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api.ts";
import { fmtAmount, fmtPrice, fmtUsd, shortPk } from "../format.ts";
import type { TokenAccountView, WalletTokens } from "./WalletPanel.tsx";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/**
 * The two tokens almost every manual swap ends in.
 *
 * Offered as chips before anything is typed, so consolidating dust does not
 * begin with a search for a mint you already know by heart. Hard-coded rather
 * than looked up: these two addresses are fixed, and a picker that has to wait
 * on a network round trip to show its own defaults is a picker that flickers.
 */
const COMMON = [
  { mint: SOL_MINT, symbol: "SOL" },
  { mint: USDC_MINT, symbol: "USDC" },
];

/**
 * A token's logo, degrading to its initials.
 *
 * Most long-tail mints have no icon in Jupiter's index — ONyc and CATE in this
 * very wallet do not — so the fallback is the ordinary case, not the error
 * case. It is a sized element either way, because a missing image must never
 * collapse a row and shift the column beside it.
 *
 * The colour is derived from the mint, so a token keeps the same disc every
 * time rather than changing identity between renders.
 */
function TokenIcon({ icon, symbol, mint }: { icon?: string | null; symbol?: string | null; mint: string }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [icon]);

  if (icon && !broken) {
    return <img className="tk" src={icon} alt="" loading="lazy" onError={() => setBroken(true)} />;
  }
  let hash = 0;
  for (let i = 0; i < mint.length; i++) hash = (hash * 31 + mint.charCodeAt(i)) >>> 0;
  return (
    <span className="tk-fb" style={{ background: `hsl(${hash % 360} 45% 68%)` }}>
      {(symbol ?? mint).slice(0, 2).toUpperCase()}
    </span>
  );
}

interface SwapPlan {
  inputMint: string;
  outputMint: string;
  inSymbol: string;
  outSymbol: string;
  inDecimals: number;
  outDecimals: number;
  amountIn: number;
  quotedOut: number;
  minOut: number;
  rate: number;
  priceImpactBps: number;
  slippageBps: number;
  route: string;
  inUsd: number | null;
  outUsd: number | null;
  valueDeltaPct: number | null;
  available: number;
  inUseWarning: string | null;
}

interface SwapResult {
  plan: SwapPlan;
  send: { signature?: string; feeLamports?: number };
  received: number;
}

interface TokenSearchResult {
  mint: string;
  symbol: string | null;
  name: string | null;
  usdPrice: number | null;
  decimals: number | null;
  icon: string | null;
  verified: boolean;
  liquidity: number | null;
}

/** What either leg of the swap needs to know about its token. */
interface Side {
  mint: string;
  symbol: string;
  icon: string | null;
  /** Human units held, or null when the wallet holds none. */
  balance: number | null;
  usdPrice: number | null;
}

/**
 * Manual swaps, and the wallet they run on.
 *
 * The card is the familiar sell/buy pair because that is the shape everyone
 * already reads, but the two-step PREVIEW -> CONFIRM is this app's, not a DEX's:
 * the quote is the only place the route and the price impact appear, and it
 * costs nothing to look. Nothing here is a trading screen — one balance in, one
 * balance out.
 *
 * The wallet list beside it is not decoration. Every swap that matters starts
 * with "what am I actually holding", and clicking a row is the fastest way to
 * answer it and act on it in the same gesture.
 */
export function SwapTab() {
  const [wallet, setWallet] = useState<WalletTokens | null>(null);
  const [walletError, setWalletError] = useState("");
  const [minSol, setMinSol] = useState<number | null>(null);
  const [commonIcons, setCommonIcons] = useState<Record<string, string>>({});

  const [inMint, setInMint] = useState<string>(SOL_MINT);
  const [outMint, setOutMint] = useState<string>("");
  const [outToken, setOutToken] = useState<TokenSearchResult | null>(null);
  const [amount, setAmount] = useState("");

  const [plan, setPlan] = useState<SwapPlan | null>(null);
  const [result, setResult] = useState<SwapResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [logs, setLogs] = useState<string[] | null>(null);
  const [picking, setPicking] = useState<"in" | "out" | null>(null);

  const load = useCallback(async () => {
    try {
      setWallet(await api.get<WalletTokens>("/api/wallet/tokens"));
      setWalletError("");
    } catch (e) {
      setWalletError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);

  /**
   * Icons for the two default tokens, looked up once.
   *
   * Native SOL is not a token account, so the wallet listing carries no icon for
   * it and the most-used token on the screen would otherwise be the one grey
   * disc. Fetched rather than hard-coded: a URL pinned in the source is a URL
   * that rots silently, and the search endpoint already answers this exact
   * question. Failure costs the logos and nothing else.
   */
  useEffect(() => {
    api
      .get<{ tokens: TokenSearchResult[] }>(`/api/tokens/search?q=${COMMON.map((c) => c.mint).join(",")}`)
      .then((r) => {
        const out: Record<string, string> = {};
        for (const t of r.tokens) if (t.icon) out[t.mint] = t.icon;
        setCommonIcons(out);
      })
      .catch(() => setCommonIcons({}));
  }, []);

  useEffect(() => {
    api
      .get<{ config: { MIN_SOL_BALANCE?: number } }>("/api/settings")
      .then((r) => setMinSol(r.config?.MIN_SOL_BALANCE ?? null))
      .catch(() => setMinSol(null));
  }, []);

  /**
   * Native SOL folded in as a row of its own.
   *
   * The wallet's SOL is not a token account, so it never appears in `accounts` —
   * but it is the balance most swaps start from, and leaving it out would make
   * the list read as "you hold no SOL".
   */
  const holdings = useMemo<TokenAccountView[]>(() => {
    if (!wallet) return [];
    const sol: TokenAccountView = {
      pubkey: "native",
      mint: SOL_MINT,
      programId: "",
      amountRaw: "0",
      decimals: 9,
      uiAmount: wallet.solBalance,
      rentLamports: 0,
      symbol: "SOL",
      // The wSOL account, if there is one, carries an icon; usually there is
      // none, and the looked-up default fills in.
      icon: wallet.accounts.find((a) => a.mint === SOL_MINT)?.icon ?? commonIcons[SOL_MINT] ?? null,
      usdPrice: wallet.solPriceUsd || null,
      usdValue: wallet.solBalance * (wallet.solPriceUsd || 0),
      lockedReason: null,
      inUse: false,
      unwrapsToSol: false,
    };
    // A wSOL account is the same asset as the native balance and would read as
    // a duplicate row; its balance is spendable through the native one anyway.
    const rest = wallet.accounts.filter((a) => a.mint !== SOL_MINT);
    return [sol, ...rest];
  }, [wallet, commonIcons]);

  const sell = useMemo<Side>(() => {
    const held = holdings.find((h) => h.mint === inMint);
    return {
      mint: inMint,
      symbol: held?.symbol ?? shortPk(inMint),
      icon: held?.icon ?? null,
      balance: held ? held.uiAmount : null,
      usdPrice: held?.usdPrice ?? null,
    };
  }, [holdings, inMint]);

  const buy = useMemo<Side>(() => {
    const held = holdings.find((h) => h.mint === outMint);
    return {
      mint: outMint,
      symbol: outToken?.symbol ?? held?.symbol ?? (outMint ? shortPk(outMint) : ""),
      icon: outToken?.icon ?? held?.icon ?? null,
      balance: held ? held.uiAmount : null,
      usdPrice: outToken?.usdPrice ?? held?.usdPrice ?? null,
    };
  }, [holdings, outMint, outToken]);

  // Any edit invalidates the quote it was priced on. A stale plan must never sit
  // above a live CONFIRM button.
  function edit(fn: () => void) {
    setPlan(null);
    setResult(null);
    setError("");
    setLogs(null);
    fn();
  }

  async function call<T>(path: string, then: (v: T) => void) {
    setBusy(true);
    setError("");
    setLogs(null);
    try {
      then(await api.post<T>(path, { inputMint: inMint, outputMint: outMint, amount: Number(amount) }));
    } catch (e) {
      const err = e as { message?: string; logs?: string[] };
      setError(err.message ?? String(e));
      setLogs(err.logs ?? null);
    } finally {
      setBusy(false);
    }
  }

  function flip() {
    edit(() => {
      const a = inMint;
      setInMint(outMint || SOL_MINT);
      setOutMint(a);
      setOutToken(null);
      setAmount("");
    });
  }

  /**
   * What MAX may actually offer.
   *
   * The server withholds MIN_SOL_BALANCE from every SOL swap, so the raw wallet
   * balance is not spendable and MAX must not hand back a number the preview
   * will refuse. Everything else is spendable in full.
   */
  const spendable = useMemo(() => {
    if (sell.balance == null) return null;
    if (sell.mint !== SOL_MINT) return sell.balance;
    return Math.max(0, sell.balance - (minSol ?? 0));
  }, [sell, minSol]);

  const usdIn = sell.usdPrice != null && Number(amount) > 0 ? Number(amount) * sell.usdPrice : null;
  const ready = Number(amount) > 0 && !!inMint && !!outMint && inMint !== outMint;

  return (
    <div className="swap-wrap">
      {/* ------------------------------------------------------------ card -- */}
      <div className="panel" style={{ margin: 0 }}>
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
          <h2 style={{ margin: 0 }}>Swap</h2>
          {wallet?.wallet && <span className="faint">{shortPk(wallet.wallet)}</span>}
        </div>

        <div className="sw-leg">
          <div className="sw-leg-top">
            <span className="lbl">Sell</span>
            <span className="sw-bal">
              {spendable != null ? `${fmtAmount(spendable)} ${sell.symbol}` : "—"}
              <button
                className="btn sm"
                disabled={!spendable}
                onClick={() => edit(() => setAmount(String((spendable ?? 0) / 2)))}
              >
                HALF
              </button>
              <button className="btn sm" disabled={!spendable} onClick={() => edit(() => setAmount(String(spendable ?? 0)))}>
                MAX
              </button>
            </span>
          </div>
          <div className="sw-body">
            <button className="sw-token" onClick={() => setPicking(picking === "in" ? null : "in")}>
              <TokenIcon icon={sell.icon} symbol={sell.symbol} mint={sell.mint} />
              {sell.symbol || "SELECT"} ▾
            </button>
            <div className="sw-amt">
              <input
                value={amount}
                inputMode="decimal"
                placeholder="0.0"
                onChange={(e) => edit(() => setAmount(e.target.value))}
              />
              <div className="usd">{usdIn != null ? fmtUsd(usdIn) : " "}</div>
            </div>
          </div>
        </div>

        <div className="sw-flip">
          <button onClick={flip} title="Swap the two sides">
            ⇅
          </button>
        </div>

        <div className="sw-leg">
          <div className="sw-leg-top">
            <span className="lbl">Buy</span>
            <span className="sw-bal">{buy.balance != null ? `${fmtAmount(buy.balance)} ${buy.symbol}` : " "}</span>
          </div>
          <div className="sw-body">
            <button className="sw-token" onClick={() => setPicking(picking === "out" ? null : "out")}>
              {buy.mint ? (
                <TokenIcon icon={buy.icon} symbol={buy.symbol} mint={buy.mint} />
              ) : (
                <span className="tk-fb">?</span>
              )}
              {buy.symbol || "SELECT"} ▾
            </button>
            <div className="sw-amt">
              <input value={plan ? fmtAmount(plan.quotedOut) : ""} placeholder="0.0" readOnly />
              <div className="usd">
                {plan?.outUsd != null ? (
                  <>
                    {fmtUsd(plan.outUsd)}
                    {plan.valueDeltaPct != null && (
                      <span className={plan.valueDeltaPct < -1 ? "bad" : "good"}>
                        {` (${plan.valueDeltaPct >= 0 ? "+" : ""}${plan.valueDeltaPct.toFixed(2)}%)`}
                      </span>
                    )}
                  </>
                ) : (
                  " "
                )}
              </div>
            </div>
          </div>
        </div>

        {picking && (
          <TokenPicker
            mode={picking}
            holdings={holdings}
            commonIcons={commonIcons}
            onClose={() => setPicking(null)}
            onPick={(mint, token) =>
              edit(() => {
                if (picking === "in") setInMint(mint);
                else {
                  setOutMint(mint);
                  setOutToken(token);
                }
                setPicking(null);
              })
            }
          />
        )}

        {plan && !result && (
          <div className="sw-quote">
            <Line label="Rate">
              1 {plan.inSymbol} ≈ {fmtAmount(plan.rate)} {plan.outSymbol}
            </Line>
            <Line label="Price impact">
              <span className={plan.priceImpactBps > 100 ? "warn" : "good"}>
                {(plan.priceImpactBps / 100).toFixed(2)}%
              </span>
            </Line>
            <Line label="Slippage">{(plan.slippageBps / 100).toFixed(2)}%</Line>
            <Line label="Minimum received">
              {fmtAmount(plan.minOut)} {plan.outSymbol}
            </Line>
            <Line label="Route">{plan.route}</Line>
          </div>
        )}

        {plan?.inUseWarning && !result && <div className="msg warn">{plan.inUseWarning}</div>}
        {error && <div className="msg err">{error}</div>}
        {logs && (
          <pre className="logs" style={{ height: 160 }}>
            {logs.join("\n")}
          </pre>
        )}

        {result && (
          <div className="msg ok">
            Swapped {fmtAmount(result.plan.amountIn)} {result.plan.inSymbol} → {fmtAmount(result.received)}{" "}
            {result.plan.outSymbol}
            {result.send.signature ? `. ${shortPk(result.send.signature)}` : "."}
          </div>
        )}

        <div className="row" style={{ gap: 8, marginTop: 12 }}>
          {!plan || result ? (
            <button
              className="btn"
              disabled={busy || !ready}
              onClick={() => void call<SwapPlan>("/api/swap/preview", setPlan)}
            >
              {busy ? "…" : "PREVIEW"}
            </button>
          ) : (
            <>
              <button
                className="btn primary"
                disabled={busy}
                onClick={() =>
                  void call<SwapResult>("/api/swap", (r) => {
                    setResult(r);
                    setPlan(null);
                    setAmount("");
                    void load();
                  })
                }
              >
                {busy ? "…" : "CONFIRM — SWAP"}
              </button>
              <button className="btn" disabled={busy} onClick={() => edit(() => undefined)}>
                CANCEL
              </button>
            </>
          )}
        </div>
      </div>

      {/* --------------------------------------------------------- wallet -- */}
      <div className="panel" style={{ margin: 0 }}>
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
          <h2 style={{ margin: 0 }}>Wallet</h2>
          <span style={{ fontSize: 16 }}>{wallet ? fmtUsd(wallet.totalUsd) : "—"}</span>
        </div>
        {walletError && <div className="msg err">{walletError}</div>}
        <div className="faint sw-hint">Click a row to sell it.</div>

        {holdings.map((h) => (
          <button
            key={h.pubkey}
            className={`hold-row${h.mint === inMint ? " on" : ""}`}
            onClick={() => edit(() => setInMint(h.mint))}
          >
            <TokenIcon icon={h.icon} symbol={h.symbol} mint={h.mint} />
            <span className="sym">
              {h.symbol ?? shortPk(h.mint)}
              {h.inUse && <span className="tag">in use</span>}
              {h.usdPrice == null && <span className="tag">unpriced</span>}
            </span>
            <span className="amt">
              {fmtAmount(h.uiAmount)}
              <span className="usd">{h.usdValue != null ? fmtUsd(h.usdValue) : "—"}</span>
            </span>
          </button>
        ))}

        {/* The one number that would otherwise read as a bug: MAX never offers the
            whole SOL balance, because the fee reserve is withheld server-side. */}
        <div className="sw-quote">
          <Line label="SOL kept back for fees">
            {minSol != null ? `${minSol} SOL` : "MIN_SOL_BALANCE"}
          </Line>
        </div>
      </div>
    </div>
  );
}

/**
 * The token list.
 *
 * The sell side offers only what the wallet holds — anything else is a swap that
 * cannot be funded. The buy side searches Jupiter's whole index, and shows the
 * MINT on every row: the search is fuzzy and symbols are not unique, which has
 * already cost this project once, when a name search matched a counterfeit SOL.
 */
function TokenPicker({
  mode,
  holdings,
  commonIcons,
  onPick,
  onClose,
}: {
  mode: "in" | "out";
  holdings: TokenAccountView[];
  commonIcons: Record<string, string>;
  onPick: (mint: string, token: TokenSearchResult | null) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<TokenSearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (mode !== "out" || q.trim().length < 2) {
      setHits([]);
      return;
    }
    // Debounced: this reaches Jupiter, and a request per keystroke would be
    // rate-limited into uselessness.
    const id = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await api.get<{ tokens: TokenSearchResult[] }>(`/api/tokens/search?q=${encodeURIComponent(q.trim())}`);
        setHits(r.tokens);
      } catch {
        setHits([]);
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => clearTimeout(id);
  }, [q, mode]);

  const own = holdings.filter((h) => !q || (h.symbol ?? h.mint).toLowerCase().includes(q.toLowerCase()));
  const dupes = new Set(
    hits.map((t) => t.symbol?.toUpperCase()).filter((s, i, a) => s && a.indexOf(s) !== i),
  );

  return (
    <div className="sw-picker">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <span className="faint">{mode === "in" ? "Sell which token" : "Buy which token"}</span>
        <button className="btn sm" onClick={onClose}>
          CLOSE
        </button>
      </div>
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={mode === "in" ? "Filter your holdings" : "Symbol, name, or paste a mint address"}
        style={{ width: "100%", marginBottom: 8 }}
      />

      {/*
        Cold state on the buy side: the two obvious destinations, then what the
        wallet already holds. Buying back into a token you own is the common
        case, and neither list costs a network round trip — so the picker is
        useful the instant it opens rather than after a search.
      */}
      {mode === "out" && q.trim().length < 2 && (
        <>
          <div className="quick">
            {COMMON.map((c) => (
              <button key={c.mint} onClick={() => onPick(c.mint, null)}>
                <TokenIcon
                  icon={holdings.find((h) => h.mint === c.mint)?.icon ?? commonIcons[c.mint]}
                  symbol={c.symbol}
                  mint={c.mint}
                />
                {c.symbol}
              </button>
            ))}
          </div>
          {holdings.length > 0 && <div className="pick-sec">Already in your wallet</div>}
        </>
      )}

      {mode === "in" || (mode === "out" && q.trim().length < 2)
        ? own.map((h) => (
            <button key={h.pubkey} className="hold-row" onClick={() => onPick(h.mint, null)}>
              <TokenIcon icon={h.icon} symbol={h.symbol} mint={h.mint} />
              <span className="sym">
                {h.symbol ?? shortPk(h.mint)}
                {h.inUse && <span className="tag">in use</span>}
              </span>
              <span className="amt">
                {fmtAmount(h.uiAmount)}
                <span className="usd">{h.usdValue != null ? fmtUsd(h.usdValue) : "—"}</span>
              </span>
            </button>
          ))
        : hits.map((t) => (
            <button key={t.mint} className="hold-row" onClick={() => onPick(t.mint, t)}>
              <TokenIcon icon={t.icon} symbol={t.symbol} mint={t.mint} />
              <span className="sym">
                {t.symbol ?? shortPk(t.mint)}
                {!t.verified && <span className="tag warn">unverified</span>}
                <span className="sub">{t.name ?? ""}</span>
              </span>
              {/* fmtPrice, not fmtUsd: a unit price here is routinely a
                  fraction of a cent, and fmtUsd renders every meme token as
                  "$0.0000" — which is exactly the row you need to tell apart
                  from the counterfeit beside it. */}
              <span className="amt">
                {t.usdPrice != null ? `$${fmtPrice(t.usdPrice)}` : "—"}
                <span className="usd">{shortPk(t.mint)}</span>
              </span>
            </button>
          ))}

      {mode === "out" && searching && <div className="faint sw-hint">searching…</div>}
      {mode === "out" && dupes.size > 0 && (
        <div className="msg warn">
          More than one mint answers to that symbol. Jupiter's token search is fuzzy — check the mint address, not the
          ticker.
        </div>
      )}
    </div>
  );
}

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="sw-line">
      <span>{label}</span>
      <b>{children}</b>
    </div>
  );
}
