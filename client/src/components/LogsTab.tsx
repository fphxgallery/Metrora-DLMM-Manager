import { useEffect, useRef, useState } from "react";
import { api, type LogEntry } from "../api.ts";

const LEVELS: Record<number, { name: string; cls: string }> = {
  10: { name: "TRC", cls: "faint" },
  20: { name: "DBG", cls: "faint" },
  30: { name: "INF", cls: "muted" },
  40: { name: "WRN", cls: "warn" },
  50: { name: "ERR", cls: "bad" },
  60: { name: "FTL", cls: "bad" },
};

export function LogsTab() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [minLevel, setMinLevel] = useState(20);
  const [filter, setFilter] = useState("");
  const [follow, setFollow] = useState(true);
  const sinceRef = useRef(-1);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await api.get<{ logs: LogEntry[]; lastSeq: number }>(`/api/logs?since=${sinceRef.current}`);
        if (!alive || res.logs.length === 0) return;
        sinceRef.current = res.lastSeq;
        setLogs((prev) => [...prev, ...res.logs].slice(-1000));
      } catch {
        /* transient — the next tick retries */
      }
    };
    void tick();
    const id = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    if (follow && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [logs, follow]);

  const shown = logs.filter((l) => {
    if (l.level < minLevel) return false;
    if (!filter.trim()) return true;
    return JSON.stringify(l).toLowerCase().includes(filter.toLowerCase());
  });

  return (
    <div className="panel">
      <div className="row" style={{ marginBottom: 12 }}>
        <select style={{ width: 140 }} value={minLevel} onChange={(e) => setMinLevel(Number(e.target.value))}>
          <option value={20}>DEBUG+</option>
          <option value={30}>INFO+</option>
          <option value={40}>WARN+</option>
          <option value={50}>ERROR+</option>
        </select>
        <input style={{ flex: 1, minWidth: 160 }} placeholder="filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className={`btn${follow ? " primary" : ""}`} onClick={() => setFollow((f) => !f)}>
          {follow ? "FOLLOWING" : "PAUSED"}
        </button>
        <button
          className="btn danger"
          onClick={async () => {
            await api.post("/api/logs/clear");
            setLogs([]);
            sinceRef.current = -1;
          }}
        >
          CLEAR
        </button>
      </div>

      <div className="logs" ref={boxRef}>
        {shown.length === 0 && <div className="faint">no log lines</div>}
        {shown.map((l) => {
          const lvl = LEVELS[l.level] ?? { name: String(l.level), cls: "muted" };
          const { seq, time, level, msg, ...rest } = l;
          void seq;
          void level;
          const extra = Object.keys(rest).length ? " " + JSON.stringify(rest) : "";
          return (
            <div className="log-line" key={l.seq}>
              <span className="log-time">{time ? String(time).slice(11, 19) : "--:--:--"}</span>
              <span className={lvl.cls} style={{ flex: "0 0 30px" }}>
                {lvl.name}
              </span>
              <span>
                {msg}
                <span className="faint">{extra}</span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
