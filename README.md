# DLMM Manager

Self-hosted web app for managing [Meteora DLMM](https://docs.meteora.ag) liquidity positions on
Solana, with automatic re-centring.

Concentrated liquidity is high-maintenance: a DLMM position covers a narrow band of price bins, and
the moment the market leaves that band the position earns **nothing**. This app finds pools, opens
positions, watches the active bin, and re-centres automatically — with guards that stop it from
spending more on rebalancing than the position can earn.

- Docker or systemd deployment on Linux
- Pool search over Meteora's indexed data (TVL, volume, daily fee/TVL)
- Per-position fee/TVL rate measured against the pool's own, so you can see whether
  a position is beating a passive LP in the same pool
- Open / add / claim / exit positions from the browser
- Automatic rebalancing with cooldown, edge-buffer and cost guards
- Hot wallet created or imported in the UI (or from a CLI)
- Cost-vs-fees charts over 24h / 7d / 30d / 90d / all time, so "does this pay?" has an answer
- Crash-safe: a rebalance interrupted mid-sequence is resolved in-run, not at the next restart

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

If the swap fails *at simulation* on slippage — Jupiter error 6001, seen live on a route quoted at
0bps price impact — it re-quotes immediately, up to three attempts. A fresh quote usually picks a
different route and fills. Simulation failures are the only ones retried this way: nothing has been
broadcast at that point, so a retry cannot double-swap. Anything with an unknown outcome (an expired
blockhash, a confirmation timeout) is left to resume, which re-reads on-chain state first.

Between those steps the funds sit in the wallet. Every step is written to a journal in
`data/state.json` **before** it is sent, so an interruption leaves a record of exactly where it
stopped. The app re-reads on-chain and wallet state and finishes the job — it never assumes a
transaction landed just because it was journalled, and it treats recorded signatures as the evidence
rather than inferring from the position's range.

Resume runs **at boot and on every poll**, not only at startup. This matters more than it sounds: a
swap that failed mid-run used to leave the withdrawn funds in the wallet until someone restarted the
service, and meanwhile the position — now missing one side — read as wildly unbalanced and kept
triggering fresh path-B rebalances that bought back what was already sitting in the wallet. A position
with an unresolved journal entry is now ineligible for a new rebalance. Unfinished entries are shown
at the top of the **METRICS** tab.

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
| `RANGE_BINS` | `60` | New positions span `[active − N, active + N]`. **A bin count, not a price width** — see below |
| `STRATEGY_TYPE` | `Spot` | `Spot`, `Curve` or `BidAsk` |
| `EDGE_BUFFER_BINS` | `12` | Rebalance once the active bin is this close to an edge. Must be `< RANGE_BINS` |
| `COOLDOWN_MIN` | `60` | Minimum minutes between rebalances of one position — the main anti-churn knob |
| `MIN_FEE_COVER_RATIO` | `1.5` | Required ratio of projected benefit to estimated cost |
| `RATIO_TOLERANCE_BPS` | `3000` | Token-ratio drift from 50/50 that justifies a swap leg |
| `MAX_SWAP_PCT_OF_POSITION` | `50` | Ceiling on how much value one rebalance may swap |
| `SWAP_SLIPPAGE_BPS` | `50` | Swap slippage tolerance. `0` hands the choice to Jupiter's dynamic slippage — **don't**, see below |
| `MAX_SWAP_PRICE_IMPACT_BPS` | `200` | Abort the swap leg above this quoted impact; the funds stay in the wallet and the entry retries later |
| `MAX_SWAP_PRIORITY_LAMPORTS` | `200000` | Hard lamport ceiling on the priority fee Jupiter may attach to a swap |
| `MAX_ACTIVE_BIN_SLIPPAGE` | `15` | Bins the active bin may move between simulation and landing |
| `PRIORITY_FEE_MICROLAMPORTS` | `50000` | Per-CU price for transactions *we* build. Raise if transactions fail to confirm |
| `SAMPLE_INTERVAL_MIN` | `15` | How often PnL is recorded for the METRICS charts |
| `SAMPLE_RETENTION_DAYS` | `90` | How much sample history to keep |
| `MIN_SOL_BALANCE` | `0.05` | Refuse to act below this, so fees and rent stay payable. Never spent on a top-up |
| `MIN_QUOTE_BALANCE_USD` | `1` | Quote-token balance to keep idle in the wallet — see below. `0` disables |
| `AUTO_TOPUP` | `true` | Swap a little SOL to refill that buffer. `false` warns instead |
| `MAX_TOPUP_USD` | `5` | Ceiling on a single top-up. Must be `>= MIN_QUOTE_BALANCE_USD` |
| `API_TOKEN` | unset | Bearer token for every mutating endpoint and the login gate |
| `ENABLE_WALLET_UI` | `false` | Allow creating/importing a key from the browser (needs `API_TOKEN`) |

`DRY_RUN` and `AUTO_REBALANCE` can also be toggled from the UI; those overrides live in
`data/state.json` so they survive a container rebuild.

### The wallet needs a little of the quote token

Not obvious, and it costs a whole rebalance when it is missing. The rebalance
instruction settles **rounding shortfalls out of the wallet's token account**: with
`STRATEGY_TYPE=Curve` the redeposit side can ask for marginally more of a token than
the withdraw released. Against an empty account that becomes an SPL Token
`insufficient funds` (0x1) at simulation, and the whole rebalance fails before its
first transaction is sent — including path B, where the failure is on the *withdraw*
leg and has nothing to do with the swap that would have followed.

Seen live on a SOL-USDC position whose wallet held no USDC. The shortfall is cents.

So before anything is journalled or sent, the app checks that the wallet holds at
least `MIN_QUOTE_BALANCE_USD` of the pool's quote token, and with `AUTO_TOPUP` on
swaps a little SOL to refill it. Refills to twice the floor, so a rebalance that eats
a few cents does not trigger another top-up on the next tick. With `AUTO_TOPUP=false`
it warns by log and Telegram and leaves the topping up to you.

`MIN_SOL_BALANCE` is never spent to fund a top-up — that reserve is what keeps fees
and rent payable, and draining it would trade one empty balance for another. If the
spendable surplus cannot cover the whole top-up it is refused rather than
part-filled, since half a buffer is still below the floor and has paid a swap fee for
it. None of this can block a rebalance: a top-up that cannot be priced or does not
fill is a warning, and the rebalance proceeds — it may not need the buffer at all.

### Two defaults that were measured, not guessed

**`SWAP_SLIPPAGE_BPS=0` is a trap on a low-volatility pair.** Zero delegates the decision to Jupiter's
dynamic slippage, whose `maxBps` is a *ceiling and not a floor* — on SOL/USDC it chose 15bps every
time, and roughly one swap in five then failed with error 6001 while the quoted price impact was
0–1bps. The failures came from price moving between quote and landing, not from impact. `50` is the
fixed default Meteora's own swap UI uses. Setting `0` deliberately is still supported.

**`PRIORITY_FEE_MICROLAMPORTS` does not need to be large.** Sampled with
`getRecentPrioritizationFees`, 141 of 150 recent blocks paid **zero** and the non-zero samples
clustered near 500. `50000` is already far above market. It is only safe this low because sends are
rebroadcast every 2s until the blockhash expires rather than broadcast once and passively awaited.
Note it does not reach the swap leg at all — Jupiter builds and signs that transaction, so
`MAX_SWAP_PRIORITY_LAMPORTS` is the only control there.

### Sizing the range — read this before setting `RANGE_BINS`

`RANGE_BINS` is a **bin count**, and a bin's size is set by the *pool's* bin step:

```
price band ≈ ±((1 + binStep/10000)^RANGE_BINS − 1)
```

| Pool bin step | `RANGE_BINS=60` gives |
|---|---|
| 1 | ±0.6% |
| 4 | ±2.4% |
| 10 | ±6.2% |
| 20 | ±12.7% |
| 80 | ±61% |

The shipped defaults target a **bin-step-4 major pair** such as SOL-USDC, whose median daily
high-low is around 3%, so ±2.4% goes out of range roughly daily rather than hourly. On a wide
bin-step pool the same number produces an absurd range; on a bin-step-1 pool, an unusable one.
Pick the count from the price band you want — the pool detail view prints the band the current
value produces. `MAX_ACTIVE_BIN_SLIPPAGE` has the same dependency.

Two more things the defaults assume, both worth checking against your own pool:

- **The swap path costs roughly 30× the atomic path** (three transactions plus swap slippage,
  versus one instruction whose fee is a rounding error). `RATIO_TOLERANCE_BPS=3000` is set high
  deliberately, to stay on the cheap path unless the position is badly one-sided.
- **`EDGE_BUFFER_BINS` decides which path you get**, which is not obvious. A large buffer relative
  to `RANGE_BINS` fires the rebalance while the active bin is still well inside the range — and with
  `STRATEGY_TYPE=Curve`, which concentrates liquidity at the centre, one side is already drained by
  then. Observed live on a `RANGE_BINS=34` / `EDGE_BUFFER_BINS=20` position: it triggered at ~14 bins
  off centre with a token ratio near 1400bps, so **every** rebalance took the swap path and none took
  the atomic one. If you are seeing no atomic rebalances in METRICS, lower `EDGE_BUFFER_BINS` so it
  triggers later, closer to balanced. One caveat on reading that: the atomic/swap split is a total
  across every managed position, so METRICS shows it only while exactly one position is managed —
  with two it would credit each line with the other's rebalances, and it is left off rather than
  shown wrong.
- **The cost guard uses the pool-wide fee rate**, which understates what a concentrated position
  earns while in range. That makes it conservative by design — but it also means small positions
  (roughly under $3–5k on a major pair) will see swap-leg rebalances refused as not worth the cost,
  and will sit one-sided until price returns.

`RANGE_BINS` only applies to **new** positions; a rebalance re-centres at the position's existing
width. To widen a position you already hold, exit and reopen it.

## Does the automation pay?

The **METRICS** tab charts cumulative fees earned against cumulative rebalance cost over 24h, 7d, 30d,
90d or **ALL**. Where the two cross is the moment the automation stopped costing money and started
making it.

The panel has no title — it leads with the answer instead. Fees earned minus rebalance cost over the
selected window *is* the heading, with the timeframe pills opposite it. (Before there is anything to
show, the heading falls back to the question.)

`ALL` is a timeframe rather than a separate lifetime panel, deliberately: the same figures read the
same way, in one place, so a total can never disagree with the chart beside it.

Cost is drawn as a **step**, because it only moves when a rebalance lands — a smooth line would imply
continuous spending and hide that the spend is lumpy. Ticks under the axis mark each rebalance, so a
cluster of ticks against a flat fee line is the churn signal.

PnL including price movement is overlaid on the same axis, as a recessive band behind the two lines —
context for the fee story rather than a peer of it. It is the one figure the other two cannot give
you: fees and cost say what the automation *did*, PnL says what the position was worth having done.
Because PnL can be negative where fees and cost never are, `$0` is a dashed line through the plot
rather than its floor.

Two consequences of sharing one axis, both deliberate:

- **The cost line is effectively given up.** A few cents of cost against a dollar-scale axis sits on
  the zero line. The total stays in the legend and `COST PER REBALANCE` has its own tile, so the
  number is never lost — but you will not read it off the chart.
- **The overlay reads well only while PnL is the same order of magnitude as fees.** A 5% price move on
  a $120 position puts PnL near −$8 against well under a dollar of fees, and the fee line flattens
  until the swing passes. Splitting automatically back into two charts was considered and rejected: a
  layout that rearranges itself is harder to trust than one that degrades predictably.

Every figure in the tile row below belongs to the selected window; the numbers on the position line
below that belong to the position, whatever window is showing.

Rent is counted in cost. The rent a rebalance pays is for **bin arrays**, which are pool-owned, shared
between every LP in the pool, and have no close instruction — that lamport never comes back. Position
*account* rent, which is refunded when you close, is not counted here.

### Is this position beating the pool?

Each position card carries a **Fee / TVL · 24h** tile: fee income as a percent of
position value per 24 hours, with the pool's own rate marked as a tick on the bar
beneath it. The fill is this position; the tick is the pool.

The comparison is the point. A rate on its own says nothing — 0.4% a day is
excellent in one pool and poor in another. Against the pool's own rate it becomes a
verdict. **Past the tick** means the range is concentrated where the volume is,
which is what a managed position is for. **Short of the tick**, drawn amber, means
the position is earning less than a passive LP in the same pool would while still
paying to rebalance — the one failure this app can actively cause, and otherwise
invisible.

Both numbers come from Meteora's indexer: `feePerTvl24h` on the position, and
`fee_tvl_ratio["24h"]` on the pool. Both are percents per 24 hours, verified against
a live response rather than assumed — `fees["24h"] / tvl` reproduces the pool figure
exactly.

Note what the position figure is: the indexer's **estimate** of a 24h rate, not a
measurement over 24 hours. A position eight hours old still reports one.

Labels stay honest about which number you are looking at. When the indexer has no
rate for the position, the tile falls back to the pool's and says so — `Pool fee /
TVL · 24h` — and a position the indexer has not seen at all reads `—`, never `0%`.

> Two API notes, both easy to get wrong. The `apr` field is byte-identical to
> `fee_tvl_ratio["24h"]`: a **daily** percent, not an annualised one, which is why
> this app exposes it as `feeTvlDailyPct`. And `allTimeFees` does **not** accrue
> continuously — on a live position, 20 of 23 fifteen-minute samples moved by
> exactly zero while it was in range throughout. Differencing that field to build a
> rate measures when the indexer updated, not what the position earned.

### The churn signal

**Median gap** in the tile row turns amber, and suggests a fix, only when the cadence is
actually churning: the median gap sitting at or under 1.5× the cooldown those gaps were subject to.
That is what churn *is* — the position re-centring about as fast as it is allowed to, which means
`COOLDOWN_MIN` is the only thing holding it back and the range itself is too tight. A fixed threshold
cannot express this, since 70 minutes is churn on an hour-long cooldown and unremarkable on a
five-minute one. Per-position cooldown overrides are taken into account, and `COOLDOWN_MIN=0` falls
back to a five-minute floor.

### History has to be collected

Meteora's Data API reports only what a position is worth *now* — there is no historical endpoint. So
fees and PnL are sampled by this app every `SAMPLE_INTERVAL_MIN` minutes into an append-only
`data/samples.jsonl`, and **a window that was never sampled can never be backfilled**. On a fresh
install the 24h chart fills within a day and 7d within a week. A window longer than the history is not
padded out with a flat line — the plot starts where the data starts, so asking for 90 days with a day
of samples charts that day and says so on the axis.

The cost curve is the exception: every rebalance record already carries its own timestamp, so cost is
exact right back to the first rebalance even on a fresh install. On `ALL` you will see the cost step
begin before the fee line does, for exactly that reason.

One accounting rule worth knowing: cost and fee income are always drawn from the **same set of
positions**. Fee income can only be read for positions still managed, so spending on closed positions
is reported separately instead of being charged against a current position's earnings.

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

If you want to look at the UI without pointing it at a funded wallet, give it a scratch `DATA_DIR`, a
`KEYPAIR_PATH` that does not exist, and `AUTO_REBALANCE=false` — with no key nothing can be signed.
Note that `dotenv` reads `./.env` from the working directory regardless of `ENV_FILE`, so export the
values you want to override explicitly. Never run a second instance against a wallet a deployed
instance is already managing: both would rebalance the same position.
