const TOKEN_KEY = "dlmm.token";

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}
export function setToken(t: string): void {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly logs?: string[],
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : {};
  if (!res.ok) {
    const b = body as { error?: string; logs?: string[] };
    throw new ApiError(b.error ?? `HTTP ${res.status}`, res.status, b.logs);
  }
  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),
};

// ---- shared response shapes ----

export interface Status {
  version: string;
  cluster: string;
  dryRun: boolean;
  autoRebalance: boolean;
  managed: number;
  autoManaged: number;
  pendingJournal: number;
  rebalances: number;
}

export interface Settings {
  tokenSet: boolean;
  canSetToken: boolean;
  walletUiEnabled: boolean;
  telegram: { configured: boolean; chatId: string };
  strategyTypes: readonly string[];
  config: Record<string, string | number | boolean>;
}

export interface WalletInfo {
  exists: boolean;
  path: string;
  publicKey?: string;
  error?: string;
  uiEnabled: boolean;
}

export interface LogEntry {
  seq: number;
  time?: string;
  level: number;
  msg?: string;
  [k: string]: unknown;
}
