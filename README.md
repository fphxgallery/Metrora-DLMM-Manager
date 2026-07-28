# DLMM Manager

Self-hosted web app for managing [Meteora DLMM](https://docs.meteora.ag) liquidity positions on
Solana, with automatic re-centring.

Concentrated liquidity is high-maintenance: a DLMM position covers a narrow band of price bins, and
the moment the market leaves that band the position earns **nothing**. This app finds pools, opens
positions, watches the active bin, and re-centres automatically — with guards that stop it from
spending more on rebalancing than the position can earn.

- Docker or systemd deployment on Linux
- Pool search over Meteora's indexed data (TVL, volume, fee/TVL, APR)
- Open / add / claim / exit positions from the browser
- Automatic rebalancing with cooldown, edge-buffer and cost guards
- Hot wallet created or imported in the UI (or from a CLI)
- Crash-safe: a rebalance interrupted mid-sequence resumes at the next start

## Quick start

```bash
git clone <this repo> dlmm-manager && cd dlmm-manager
cp .env.example .env
```

Set at least `RPC_ENDPOINT` in `.env` — the public mainnet RPC will rate-limit this app immediately,
so use Helius / Triton / QuickNode or your own node. Leave `DRY_RUN=true`.

```bash
docker compose up --build
```

Open http://localhost:8080. Create a wallet in **SETTINGS**, fund it, find a pool in **POOLS**, and
open a position. Everything is simulated until you turn `DRY_RUN` off.

For a local (non-Docker) run:

```bash
npm run install:all && npm run build && npm start
```

## How rebalancing works

Every `POLL_INTERVAL_MS` the engine looks at each managed position and decides whether to act. Four
things can stop it, and each logs the numbers it decided on:

| Guard | Rule |
|---|---|
| **Busy** | a rebalance for this position is already in flight |
| **Cooldown** | `COOLDOWN_MIN` since the last rebalance of this position |
| **Range** | act only when the active bin has left the range, or is within `EDGE_BUFFER_BINS` of an edge |
| **Cost** | projected fees over one cooldown window + unclaimed fees must cover `MIN_FEE_COVER_RATIO` × the estimated cost |

The cost guard deliberately does **not** ask "have we earned enough fees already" — an out-of-range
position earns nothing, so that test would leave it dead forever. It asks what the position can earn
once it is back in range, estimated from the pool's own 24h fee/TVL ratio.

When it acts, there are two paths:

**Path A — atomic.** The token ratio is already close enough to balanced. One
`rebalance_liquidity` instruction withdraws, re-centres on the active bin, claims fees and
redeposits. The position account is reused, so no rent is burned and it either lands or nothing
happened.

**Path B — with a swap.** The price has run through the range, so the position holds only one of the
two tokens and re-centring alone would leave it one-sided. `rebalance_liquidity` cannot swap
mid-instruction, so this runs in three transactions:

1. **withdraw** — a rebalance that re-centres the range *and* leaves the oversupplied token in the
   wallet (`xWithdrawBps` / `yWithdrawBps` control how much),
2. **swap** — Jupiter swaps it for the token the new range is short of,
3. **deposit** — the proceeds go back into the (already re-centred) range.

Between those steps the funds sit in the wallet. Every step is written to a journal in
`data/state.json` **before** it is sent, so a crash leaves a record of exactly where it stopped. At
the next start the app re-reads on-chain and wallet state and finishes the job — it never assumes a
transaction landed just because it was journalled. Unfinished entries are shown at the top of the
**METRICS** tab.

> One SDK behaviour worth knowing: the balanced strategy splits `floor(width/2)` bins per side and
> gives the spare bin to the bid side, so an **even-width** position comes back one bin wider on its
> first rebalance and is stable after that.

## Configuration

All of `.env`; the rebalance thresholds are also editable from the SETTINGS tab, which validates a
value before it is written (a bad value is rejected, never persisted).

| Key | Default | What it does |
|---|---|---|
| `RPC_ENDPOINT` | — | **Required.** A real RPC endpoint |
| `DRY_RUN` | `true` | Build and simulate every transaction, send nothing |
| `AUTO_REBALANCE` | `false` | Master switch; positions also opt in individually |
| `RANGE_BINS` | `20` | New positions span `[active − N, active + N]` |
| `STRATEGY_TYPE` | `Spot` | `Spot`, `Curve` or `BidAsk` |
| `EDGE_BUFFER_BINS` | `2` | Rebalance once the active bin is this close to an edge. Must be `< RANGE_BINS` |
| `COOLDOWN_MIN` | `15` | Minimum minutes between rebalances of one position — the main anti-churn knob |
| `MIN_FEE_COVER_RATIO` | `1.5` | Required ratio of projected benefit to estimated cost |
| `RATIO_TOLERANCE_BPS` | `1500` | Token-ratio drift from 50/50 that justifies a swap leg |
| `MAX_SWAP_PCT_OF_POSITION` | `60` | Ceiling on how much value one rebalance may swap |
| `SWAP_SLIPPAGE_BPS` | `0` | `0` = Jupiter dynamic slippage |
| `MAX_ACTIVE_BIN_SLIPPAGE` | `5` | Bins the active bin may move between simulation and landing |
| `PRIORITY_FEE_MICROLAMPORTS` | `200000` | Raise if transactions fail to confirm |
| `MIN_SOL_BALANCE` | `0.05` | Refuse to act below this, so fees and rent stay payable |
| `API_TOKEN` | unset | Bearer token for every mutating endpoint and the login gate |
| `ENABLE_WALLET_UI` | `false` | Allow creating/importing a key from the browser (needs `API_TOKEN`) |

`DRY_RUN` and `AUTO_REBALANCE` can also be toggled from the UI; those overrides live in
`data/state.json` so they survive a container rebuild.

## Wallet

The app signs unattended, so the key is a plain `keypair.json` at `KEYPAIR_PATH`, written `0600`.
Treat it as a hot wallet: fund it with what you are willing to have online, nothing more.

```bash
npm run wallet -- create           # new wallet; seed phrase shown once
npm run wallet -- import           # paste a seed phrase, base58 key, or JSON array
npm run wallet -- show
```

The same operations are in the SETTINGS tab when `ENABLE_WALLET_UI=true`, which additionally
requires `API_TOKEN` to be set and a valid bearer token on the request.

## Security

- Set `API_TOKEN`. Without one, every control endpoint is open — only safe bound to loopback. The
  app logs a loud warning if it is bound to a public interface without a token.
- The dashboard is gated behind a full-page login; nothing renders until the token verifies.
- `HOST` defaults to `127.0.0.1`. `docker-compose.yml` sets `0.0.0.0` *inside the container* — the
  published port is the real boundary.
- Wallet endpoints require both `ENABLE_WALLET_UI=true` and a valid token, and refuse outright if no
  token is configured.

## Deployment

**Docker** (`docker compose up --build`). Three mounts matter: `./data` for state, `./secrets` for
the keypair, and **`./.env` read-write** — without that last one, settings saved from the dashboard
are written into a throwaway container file and vanish on the next `up --build`.

**systemd** (`sudo bash deploy/install.sh`) installs to `/opt/dlmm-manager` under a `dlmm` service
user with a hardened unit (`ProtectSystem=strict`; only `data/`, `.env` and `secrets/` are
writable). It generates an `API_TOKEN` if you have not set one and prints it once.

## Development

```bash
npm run install:all
npm run dev                  # API on :8080
cd client && npm run dev     # Vite on :5173, proxying /api to :8080
npm run typecheck
npm test
```

The Meteora SDK is imported through `src/meteora/sdk.ts` and **nowhere else**: its ESM build does a
directory import into `@coral-xyz/anchor`'s CJS internals, which Node's ESM resolver rejects
(`ERR_UNSUPPORTED_DIR_IMPORT`), so that module loads the CJS build via `createRequire` and re-exports
it with the package's own types.

The client is built with `npm install`, not `npm ci` — a lockfile generated on macOS pins
`@rollup/rollup-darwin-*`, which does not install on Linux.

## Verifying before you risk funds

1. Keep `DRY_RUN=true` and open a position. The logs show the built transaction and its simulation
   result; nothing is sent.
2. Fund the wallet with a small amount and open a **narrow** position (5 bins) on a volatile pool, so
   the active bin leaves the range within minutes. Watch one full automatic cycle in LOGS.
3. Check on Solscan that a path-A rebalance kept the **same** position pubkey (no close/reopen) and
   claimed the fees.
4. To exercise the resume path: kill the process after the withdraw leg of a path-B rebalance
   confirms, then restart and confirm it resumes at `swap`/`deposit` instead of stranding the funds.
