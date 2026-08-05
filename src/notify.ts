import type { Config } from "./config.js";
import type { Logger } from "./logger.js";

/**
 * Escapes the three characters Telegram's HTML parser treats as markup.
 *
 * Required on every value interpolated into a `notifyHtml` message. Pair names
 * come from token metadata that anyone can set, and error strings come from
 * program logs — an unescaped `<` in either turns the rest of the alert into an
 * unclosed tag, and Telegram rejects the whole message rather than sending a
 * partial one.
 */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Telegram push alerts. No-op unless both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID
 * are set. Enabled-state is read live from `cfg` on every call (cfg is mutated in
 * place when settings are saved), so configuring alerts in the UI needs no restart.
 */
export class Notifier {
  constructor(
    private readonly cfg: Config,
    private readonly log: Logger,
  ) {}

  enabled(): boolean {
    return Boolean(this.cfg.telegramBotToken && this.cfg.telegramChatId);
  }

  /** Fire-and-forget. Errors are logged, never thrown at the caller. */
  notify(text: string): void {
    if (!this.enabled()) return;
    void this.send(text).then((r) => {
      if (!r.ok) this.log.warn({ error: r.error }, "telegram alert failed");
    });
  }

  /**
   * Fire-and-forget, rendered as Telegram HTML.
   *
   * Deliberately a second method rather than a parse_mode on `notify`. Every
   * other alert in this app interpolates things nobody controls — indexer pair
   * names, wallet addresses, raw error strings from failed transactions — and
   * turning HTML parsing on for all of them would mean any stray `<` or `&`
   * either breaks the message or silently swallows part of it. Callers of THIS
   * method opt in, and must escape their own interpolations with `escapeHtml`.
   */
  notifyHtml(html: string): void {
    if (!this.enabled()) return;
    void this.send(html, { html: true }).then((r) => {
      if (!r.ok) this.log.warn({ error: r.error }, "telegram alert failed");
    });
  }

  /** Awaitable send, used by the "send test" button so the UI can report success. */
  async send(text: string, opts: { html?: boolean } = {}): Promise<{ ok: boolean; error?: string }> {
    if (!this.enabled()) return { ok: false, error: "telegram not configured (need bot token + chat id)" };
    const url = `https://api.telegram.org/bot${this.cfg.telegramBotToken}/sendMessage`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: this.cfg.telegramChatId,
          text,
          disable_web_page_preview: true,
          ...(opts.html ? { parse_mode: "HTML" } : {}),
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        const body = await res.text();
        return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
