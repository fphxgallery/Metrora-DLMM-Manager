import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

export interface EnvWriteResult {
  created: boolean;
  updated: string[];
  added: string[];
  backup?: string;
}

/**
 * Rewrites `key=value` lines in a .env file in place, appending any keys that
 * weren't present. Comments and unrelated lines are preserved.
 *
 * The backup is best-effort: under a hardened systemd unit the app directory is
 * read-only except .env itself (ReadWritePaths), so writing .env.bak fails with
 * EROFS. The real write targets .env (writable); a missing backup is non-fatal.
 */
export function updateEnvFile(path: string, updates: Record<string, string>): EnvWriteResult {
  const created = !existsSync(path);
  const updated: string[] = [];
  const added: string[] = [];
  let backup: string | undefined;

  let lines: string[] = [];
  if (!created) {
    lines = readFileSync(path, "utf8").split(/\r?\n/);
    try {
      copyFileSync(path, `${path}.bak`);
      backup = `${path}.bak`;
    } catch {
      backup = undefined;
    }
  }

  const remaining = new Set(Object.keys(updates));
  const keyRe = (k: string) => new RegExp(`^(\\s*)${k}\\s*=(.*)$`);

  const out = lines.map((line) => {
    for (const key of Object.keys(updates)) {
      const m = line.match(keyRe(key));
      if (m) {
        remaining.delete(key);
        if (m[2].trim() !== updates[key]) updated.push(key);
        return `${m[1]}${key}=${updates[key]}`;
      }
    }
    return line;
  });

  if (remaining.size > 0) {
    if (out.length && out[out.length - 1].trim() !== "") out.push("");
    out.push(`# --- written by the dashboard ${new Date().toISOString()} ---`);
    for (const key of remaining) {
      out.push(`${key}=${updates[key]}`);
      added.push(key);
    }
    out.push("");
  }

  writeFileSync(path, out.join("\n"));
  return { created, updated, added, backup };
}
