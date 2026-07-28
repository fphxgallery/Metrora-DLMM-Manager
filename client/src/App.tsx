import { useCallback, useEffect, useState } from "react";
import { api, ApiError, clearToken, type Status } from "./api.ts";
import { Login } from "./components/Login.tsx";
import { LogsTab } from "./components/LogsTab.tsx";
import { MetricsTab } from "./components/MetricsTab.tsx";
import { PoolsTab } from "./components/PoolsTab.tsx";
import { PositionsTab } from "./components/PositionsTab.tsx";
import { SettingsTab } from "./components/SettingsTab.tsx";

const TABS = ["POOLS", "POSITIONS", "METRICS", "LOGS", "SETTINGS"] as const;
type Tab = (typeof TABS)[number];

export default function App() {
  const [gate, setGate] = useState<{ state: "checking" | "locked" | "open"; canSetToken: boolean }>({
    state: "checking",
    canSetToken: false,
  });
  const [tab, setTab] = useState<Tab>("POSITIONS");
  const [status, setStatus] = useState<Status | null>(null);

  const check = useCallback(async () => {
    try {
      await api.get("/api/auth/verify");
      setGate({ state: "open", canSetToken: false });
    } catch (e) {
      // The settings endpoint is readable without a token so the gate can tell
      // "wrong token" from "no token configured yet, offer first-run setup".
      let canSetToken = false;
      try {
        const s = await api.get<{ canSetToken: boolean }>("/api/settings");
        canSetToken = s.canSetToken;
      } catch {
        /* still locked */
      }
      if (e instanceof ApiError && e.status === 401) setGate({ state: "locked", canSetToken });
      else setGate({ state: "locked", canSetToken });
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.get<Status>("/api/status"));
    } catch {
      /* transient */
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  useEffect(() => {
    if (gate.state !== "open") return;
    void refreshStatus();
    const id = setInterval(refreshStatus, 10_000);
    return () => clearInterval(id);
  }, [gate.state, refreshStatus]);

  if (gate.state === "checking") return <div className="gate faint">…</div>;
  if (gate.state === "locked") return <Login canSetToken={gate.canSetToken} onAuthed={() => void check()} />;

  return (
    <div className="app">
      <div className="header">
        <span className="brand">DLMM MANAGER</span>
        {status && (
          <>
            <span className="pill">{status.cluster}</span>
            <span className={`pill ${status.dryRun ? "warn" : "bad"}`}>{status.dryRun ? "DRY-RUN" : "LIVE"}</span>
            <span className={`pill ${status.autoRebalance ? "good" : ""}`}>AUTO {status.autoRebalance ? "ON" : "OFF"}</span>
            {status.pendingJournal > 0 && <span className="pill bad">{status.pendingJournal} UNFINISHED</span>}
            <span className="faint">v{status.version}</span>
          </>
        )}
        <button
          className="btn"
          onClick={() => {
            clearToken();
            setGate({ state: "locked", canSetToken: false });
          }}
        >
          LOCK
        </button>
      </div>

      <div className="tabs">
        {TABS.map((t) => (
          <button key={t} className={`tab${tab === t ? " active" : ""}`} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>

      {tab === "POOLS" && <PoolsTab />}
      {tab === "POSITIONS" && <PositionsTab />}
      {tab === "METRICS" && <MetricsTab />}
      {tab === "LOGS" && <LogsTab />}
      {tab === "SETTINGS" && <SettingsTab onChanged={() => void refreshStatus()} />}
    </div>
  );
}
