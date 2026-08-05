# Read endpoints are unauthenticated

Status: **known, unchanged, deliberate for now.** No code change accompanies this note.
Raised by the v1.5.5 sanity check, 2026-07-30.

## What is true

`requireAuth` is applied only to mutating routes. Every `GET` is open. Confirmed
against the live instance at `192.168.70.251:8080` with no `Authorization` header
at all — each of these returned a full `200`:

| Endpoint | What it discloses without a token |
|---|---|
| `/api/settings` | Every config value, plus the Telegram chat id |
| `/api/wallet/tokens` | Wallet address, SOL balance, every token account and its USD value |
| `/api/logs` | The entire application log |
| `/api/metrics` | Rebalance count, costs, fee income, time in range |
| `/api/positions` | Managed positions, pools, bin ranges |
| `/api/positions/:pk/bins` | A position's liquidity bin by bin — amounts and prices |
| `/api/history` | The full fee/PnL/cost time series |
| `/api/journal` | The rebalance journal |

`POST /api/settings/config`, `/api/positions/*`, `/api/wallet/close-accounts` and
the other writes **are** gated, and `requireWalletAuth` additionally refuses
key-touching endpoints when no `API_TOKEN` exists. Writes were not found to be
exposed.

## Why it looks protected but is not

`client/src/components/Login.tsx` renders a full-page gate, and
`GET /api/auth/verify` returns 401 without a valid bearer. That gate is
**client-side only** — it decides what the React app renders, not what the server
answers. Anything that can reach the port can read the endpoints above directly,
without ever loading the UI.

The instance binds `0.0.0.0` and is reachable across the LAN, so "the token
protects the dashboard" is true of the interface and false of the API.

## Why nothing was changed

Gating reads is a deployment-policy decision, not a defect fix:

- The React client already sends the bearer on every request, so the UI would
  keep working unchanged.
- Anything *else* polling the box — an uptime check, a monitoring scrape, a
  personal `curl` — breaks the moment reads require a token, silently and
  without an obvious cause.
- The exposure is bounded by whoever can reach the LAN. That is a judgement
  about the network, not about this code.

## If it is ever closed

The cheap version is a Fastify `onRequest` hook that calls `requireAuth` for any
`/api/` path, with an explicit allowlist. Recommended allowlist:

- `/api/health` — so uptime checks keep working (it already discloses little:
  version, cluster, dry-run and auto-rebalance flags, uptime)
- `/api/auth/verify` — it *is* the token check; gating it makes the login screen
  unable to tell a wrong token from a working one

Before doing that, confirm nothing external polls the box. Note also that
`/api/health` currently reports `walletConfigured` and the dry-run and
auto-rebalance state; if even that is too much, it needs trimming rather than
exempting.

An `API_TOKEN` rotation should be considered at the same time: the current token
has been readable by anyone on the LAN for the life of the deployment, and
`/api/settings` has been disclosing the Telegram chat id alongside it.
