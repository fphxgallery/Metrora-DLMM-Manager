import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "./config.js";

/**
 * Bearer-token check. Both sides are hashed to a fixed length first so the
 * comparison is constant-time and response timing can't leak the token
 * byte-by-byte.
 *
 * With no API_TOKEN configured the app is OPEN — only safe bound to loopback.
 * index.ts logs a loud warning when that combination reaches a public interface.
 */
export function authed(cfg: Config, req: FastifyRequest): boolean {
  if (!cfg.apiToken) return true;
  const given = createHash("sha256").update(String(req.headers["authorization"] ?? "")).digest();
  const want = createHash("sha256").update(`Bearer ${cfg.apiToken}`).digest();
  return timingSafeEqual(given, want);
}

/** Guard for mutating endpoints. Returns false and sends 401 when unauthorized. */
export function requireAuth(cfg: Config, req: FastifyRequest, reply: FastifyReply): boolean {
  if (authed(cfg, req)) return true;
  void reply.code(401).send({ error: "unauthorized" });
  return false;
}

/**
 * Guard for endpoints that touch the signing key itself. These need a token to
 * exist at all — an open instance must never expose key creation or import.
 */
export function requireWalletAuth(cfg: Config, req: FastifyRequest, reply: FastifyReply): boolean {
  if (!cfg.apiToken) {
    void reply.code(403).send({ error: "wallet endpoints require API_TOKEN to be set" });
    return false;
  }
  return requireAuth(cfg, req, reply);
}

/** True when the request itself arrived over loopback (not just the bind address). */
export function reqLoopback(req: FastifyRequest): boolean {
  const ip = String(req.ip ?? "").replace("::ffff:", "");
  return ip === "127.0.0.1" || ip === "::1";
}

export function loopbackBind(cfg: Config): boolean {
  return ["127.0.0.1", "localhost", "::1"].includes(cfg.host);
}

/**
 * First-run token bootstrap is only allowed when no token exists yet AND the
 * request is local. Docker port-mapping NATs the source address to the gateway,
 * so containers must bootstrap API_TOKEN through .env instead — which is the
 * correct, safe behavior.
 */
export function canSetToken(cfg: Config, req: FastifyRequest): boolean {
  return !cfg.apiToken && (loopbackBind(cfg) || reqLoopback(req));
}
