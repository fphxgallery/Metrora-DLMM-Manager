import { useState } from "react";
import { api, setToken } from "../api.ts";

/**
 * Full-page gate. Nothing else renders until /api/auth/verify accepts the token,
 * so an unauthenticated visitor never sees wallet or position data.
 *
 * When no token exists yet AND the request is local, the server allows a
 * first-run setup — that path is offered here so a fresh install is usable
 * without hand-editing .env.
 */
export function Login({ canSetToken, onAuthed }: { canSetToken: boolean; onAuthed: () => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function unlock(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      setToken(value.trim());
      await api.get("/api/auth/verify");
      onAuthed();
    } catch (err) {
      setToken("");
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function generate() {
    setBusy(true);
    setError("");
    try {
      const res = await api.post<{ token: string }>("/api/settings/token", {});
      setValue(res.token);
      setToken(res.token);
      await api.get("/api/auth/verify");
      onAuthed();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="gate">
      <form className="panel" onSubmit={unlock}>
        <div className="brand" style={{ textAlign: "center", marginBottom: 4 }}>
          DLMM
        </div>
        <div className="faint" style={{ textAlign: "center", marginBottom: 18, letterSpacing: 2 }}>
          MANAGER
        </div>

        <label className="field">
          <span>API token</span>
          <input
            type="password"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="paste API_TOKEN"
          />
        </label>

        {error && <div className="msg err">{error}</div>}

        <button className="btn primary" style={{ width: "100%" }} disabled={busy || !value.trim()}>
          {busy ? "…" : "UNLOCK"}
        </button>

        {canSetToken && (
          <>
            <div className="faint" style={{ textAlign: "center", margin: "14px 0 8px" }}>
              no token set on this instance
            </div>
            <button type="button" className="btn" style={{ width: "100%" }} disabled={busy} onClick={generate}>
              GENERATE A TOKEN
            </button>
            <div className="faint" style={{ marginTop: 8, fontSize: 11 }}>
              Writes API_TOKEN to .env. Only offered for local requests on a fresh install.
            </div>
          </>
        )}
      </form>
    </div>
  );
}
