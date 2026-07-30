import { useEffect, useState } from "react";
import { api, type Settings, type WalletInfo } from "../api.ts";

const NUMERIC_FIELDS: { key: string; label: string; hint: string }[] = [
  {
    key: "RANGE_BINS",
    label: "Range bins (half-width)",
    hint: "New positions span [active-N, active+N]. A bin COUNT, not a price width — a bin is the pool's bin step, so 60 is ±2.4% at bin step 4 but ±61% at bin step 80. Applies to new positions only.",
  },
  {
    key: "EDGE_BUFFER_BINS",
    label: "Edge buffer bins",
    hint: "Rebalance once the active bin is this close to an edge. Must be < range bins; ~20% of it is a reasonable start.",
  },
  { key: "COOLDOWN_MIN", label: "Cooldown (min)", hint: "Minimum minutes between rebalances of the same position." },
  { key: "MIN_FEE_COVER_RATIO", label: "Min fee cover ratio", hint: "Skip unless accrued fees cover this multiple of the estimated cost." },
  {
    key: "RATIO_TOLERANCE_BPS",
    label: "Ratio tolerance (bps)",
    hint: "Token-ratio drift from 50/50 that justifies adding a swap leg. The swap path costs ~30x the atomic one, so higher = cheaper but more one-sided.",
  },
  { key: "MAX_SWAP_PCT_OF_POSITION", label: "Max swap % of position", hint: "Ceiling on how much value one rebalance may swap." },
  { key: "SWAP_SLIPPAGE_BPS", label: "Swap slippage (bps)", hint: "0 = let Jupiter pick (dynamic slippage)." },
  {
    key: "MAX_ACTIVE_BIN_SLIPPAGE",
    label: "Max active-bin slippage",
    hint: "Bins the active bin may move between simulate and land. Bin-step-dependent too: 15 bins is 0.6% at bin step 4, 12% at bin step 80.",
  },
  { key: "PRIORITY_FEE_MICROLAMPORTS", label: "Priority fee (µlamports/CU)", hint: "Raise if transactions fail to confirm under congestion." },
  { key: "COMPUTE_UNIT_LIMIT", label: "Compute unit limit", hint: "Bin-array init and rebalance are compute-heavy." },
  { key: "MIN_SOL_BALANCE", label: "Min SOL balance", hint: "Refuse to act below this, so fees and rent stay payable." },
  {
    key: "MIN_QUOTE_BALANCE_USD",
    label: "Quote buffer floor ($)",
    hint: "Idle quote token kept in the wallet to cover the rebalance instruction's rounding shortfall — an empty ATA turns cents of shortfall into a failed rebalance. 0 disables the check.",
  },
  {
    key: "MAX_TOPUP_USD",
    label: "Max top-up ($)",
    hint: "Ceiling on a single automatic top-up. Must be at least the floor. MIN_SOL_BALANCE is never spent to fund one.",
  },
];

export function SettingsTab({ onChanged }: { onChanged: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [wallet, setWallet] = useState<WalletInfo | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function reload() {
    const [s, w] = await Promise.all([api.get<Settings>("/api/settings"), api.get<WalletInfo>("/api/wallet")]);
    setSettings(s);
    setWallet(w);
    const f: Record<string, string> = {};
    for (const { key } of NUMERIC_FIELDS) f[key] = String(s.config[key] ?? "");
    f.STRATEGY_TYPE = String(s.config.STRATEGY_TYPE ?? "Spot");
    f.AUTO_TOPUP = s.config.AUTO_TOPUP ? "true" : "false";
    setForm(f);
  }

  useEffect(() => {
    void reload().catch((e) => setMsg({ kind: "err", text: String(e.message ?? e) }));
  }, []);

  async function saveConfig() {
    setBusy(true);
    setMsg(null);
    try {
      await api.post("/api/settings/config", form);
      setMsg({ kind: "ok", text: "saved" });
      await reload();
      onChanged();
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function toggleMode(patch: { dryRun?: boolean; autoRebalance?: boolean }) {
    setBusy(true);
    setMsg(null);
    try {
      await api.post("/api/settings/mode", patch);
      await reload();
      onChanged();
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  if (!settings) return <div className="panel faint">loading…</div>;

  const dryRun = Boolean(settings.config.DRY_RUN);
  const auto = Boolean(settings.config.AUTO_REBALANCE);

  return (
    <>
      {msg && <div className={`msg ${msg.kind === "err" ? "err" : "ok"}`}>{msg.text}</div>}

      <div className="panel">
        <h2>Run mode</h2>
        <div className="row">
          <button className={`btn ${dryRun ? "primary" : "danger"}`} disabled={busy} onClick={() => void toggleMode({ dryRun: !dryRun })}>
            {dryRun ? "DRY-RUN — nothing is sent" : "LIVE — transactions are sent"}
          </button>
          <button className={`btn ${auto ? "primary" : ""}`} disabled={busy} onClick={() => void toggleMode({ autoRebalance: !auto })}>
            AUTO-REBALANCE {auto ? "ON" : "OFF"}
          </button>
        </div>
        <div className="faint" style={{ marginTop: 8 }}>
          Both live in data/state.json and override the .env flags, so they survive a container rebuild.
        </div>
      </div>

      <div className="panel">
        <h2>Rebalance thresholds</h2>
        <div className="grid-2">
          <label className="field">
            <span>Strategy type</span>
            <select value={form.STRATEGY_TYPE ?? "Spot"} onChange={(e) => setForm({ ...form, STRATEGY_TYPE: e.target.value })}>
              {settings.strategyTypes.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Auto top-up</span>
            {/* A select, not a text box: the parser treats anything that isn't
                1/true/yes/on as false, so a typo would silently disable it. */}
            <select value={form.AUTO_TOPUP ?? "true"} onChange={(e) => setForm({ ...form, AUTO_TOPUP: e.target.value })}>
              <option value="true">ON — swap SOL to refill the buffer</option>
              <option value="false">OFF — warn instead</option>
            </select>
            <span className="faint" style={{ textTransform: "none", letterSpacing: 0, fontSize: 11 }}>
              With it off, a dry buffer is a log line and a Telegram alert; the rebalance still proceeds either way.
            </span>
          </label>
          {NUMERIC_FIELDS.map((f) => (
            <label className="field" key={f.key}>
              <span>{f.label}</span>
              <input value={form[f.key] ?? ""} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
              <span className="faint" style={{ textTransform: "none", letterSpacing: 0, fontSize: 11 }}>
                {f.hint}
              </span>
            </label>
          ))}
        </div>
        <button className="btn primary" disabled={busy} onClick={() => void saveConfig()}>
          SAVE
        </button>
        <div className="faint" style={{ marginTop: 8 }}>
          Values are validated before they are written — a bad value is rejected, not persisted.
        </div>
      </div>

      <TelegramPanel settings={settings} onSaved={reload} />
      <WalletPanel wallet={wallet} onChanged={reload} />
    </>
  );
}

function TelegramPanel({ settings, onSaved }: { settings: Settings; onSaved: () => Promise<void> }) {
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState(settings.telegram.chatId);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<unknown>, okText: string) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ kind: "ok", text: okText });
      await onSaved();
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <h2>
        Telegram alerts{" "}
        <span className={`pill ${settings.telegram.configured ? "good" : ""}`}>
          {settings.telegram.configured ? "configured" : "off"}
        </span>
      </h2>
      {msg && <div className={`msg ${msg.kind === "err" ? "err" : "ok"}`}>{msg.text}</div>}
      <div className="grid-2">
        <label className="field">
          <span>Bot token</span>
          <input type="password" value={botToken} onChange={(e) => setBotToken(e.target.value)} placeholder="leave blank to keep" />
        </label>
        <label className="field">
          <span>Chat id</span>
          <input value={chatId} onChange={(e) => setChatId(e.target.value)} />
        </label>
      </div>
      <div className="row">
        <button
          className="btn primary"
          disabled={busy}
          onClick={() =>
            void run(
              () => api.post("/api/settings/telegram", { ...(botToken ? { botToken } : {}), chatId }),
              "saved",
            )
          }
        >
          SAVE
        </button>
        <button className="btn" disabled={busy} onClick={() => void run(() => api.post("/api/settings/telegram/test"), "test sent")}>
          SEND TEST
        </button>
      </div>
    </div>
  );
}

function WalletPanel({ wallet, onChanged }: { wallet: WalletInfo | null; onChanged: () => Promise<void> }) {
  const [secret, setSecret] = useState("");
  const [force, setForce] = useState(false);
  const [mnemonic, setMnemonic] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  if (!wallet) return null;

  async function run(fn: () => Promise<unknown>, okText: string) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ kind: "ok", text: okText });
      await onChanged();
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <h2>Hot wallet</h2>
      <div className="tile" style={{ marginBottom: 12 }}>
        <div className="label">Address</div>
        <div className="value" style={{ fontSize: 13, wordBreak: "break-all" }}>
          {wallet.publicKey ?? <span className="faint">no keypair at {wallet.path}</span>}
        </div>
      </div>

      {!wallet.uiEnabled ? (
        <div className="faint">
          Wallet creation and import from the browser are disabled. Set <code>ENABLE_WALLET_UI=true</code> (an API token is
          required first), or use <code>npm run wallet -- create|import</code> on the host.
        </div>
      ) : (
        <>
          {msg && <div className={`msg ${msg.kind === "err" ? "err" : "ok"}`}>{msg.text}</div>}

          {mnemonic && (
            <div className="msg" style={{ borderColor: "var(--warn)" }}>
              <b className="warn">SEED PHRASE — shown once, never stored.</b> Write it down offline now. Anyone with it
              controls the funds.
              <div style={{ marginTop: 8, color: "var(--text)" }}>{mnemonic}</div>
              <button className="btn" style={{ marginTop: 8 }} onClick={() => setMnemonic("")}>
                I HAVE WRITTEN IT DOWN
              </button>
            </div>
          )}

          <label className="field">
            <span>Import: seed phrase, base58 secret, or JSON array</span>
            <textarea rows={3} value={secret} onChange={(e) => setSecret(e.target.value)} />
          </label>
          <label className="row" style={{ marginBottom: 10 }}>
            <input type="checkbox" style={{ width: "auto" }} checked={force} onChange={(e) => setForce(e.target.checked)} />
            <span className="faint">overwrite the existing keypair (destroys the old key)</span>
          </label>
          <div className="row">
            <button
              className="btn"
              disabled={busy || !secret.trim()}
              onClick={() =>
                void run(async () => {
                  await api.post("/api/wallet/import", { secret, force });
                  setSecret("");
                }, "wallet imported")
              }
            >
              IMPORT
            </button>
            <button
              className="btn primary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const r = await api.post<{ mnemonic: string }>("/api/wallet/create", { force });
                  setMnemonic(r.mnemonic);
                }, "wallet created")
              }
            >
              CREATE NEW
            </button>
          </div>
        </>
      )}
    </div>
  );
}
