import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { StrategyTypeName, TriggerAction, TriggerMeasure } from "./config.js";

/**
 * A position's stop loss / take profit state.
 *
 * Both the settings and the bookkeeping live here, because the bookkeeping is
 * per position and has to survive a restart: a confirmation streak that reset on
 * every deploy would mean a stop loss never reaches its third reading on a box
 * that gets redeployed often.
 */
export interface PositionTriggers {
  /**
   * Opt-in per position, never inherited. The global thresholds are defaults for
   * a position that has been armed, not an instruction to arm one — the action
   * is terminal, so enrolling in it is a decision taken one position at a time.
   */
  on: boolean;
  /** Overrides of the global thresholds. Unset falls back to config. */
  stopLoss?: number;
  takeProfit?: number;
  onFire?: TriggerAction;
  /**
   * The unit the thresholds above were entered in, stamped when they were set.
   *
   * A threshold is a bare number: `-3` is -3% under `TRIGGER_MEASURE=pct` and
   * -$3 under `usd`. Changing the global measure therefore silently reinterprets
   * every stored threshold, and the reinterpretation is not conservative — on
   * the live box at the moment of the 1.11.3 switch, `-3` meant "close at -3% of
   * cumulative deposits" (unreachable) and would have become "close at -$3"
   * (already crossed on three of four positions). Two of those closes would have
   * been accidents, and closing is terminal: bin-array rent is never recovered.
   *
   * So the unit travels with the number. A mismatch against the running config
   * disarms the position rather than acting on a threshold whose meaning changed
   * underneath it. Unset means the thresholds predate this field — written under
   * `pct`, and equally unsafe to read as dollars.
   */
  measure?: TriggerMeasure;
  /**
   * Which DEFINITION of that unit, since `pct` has had two.
   *
   * Up to v1.11.3, `pct` was the indexer's `pnlPctChange` — diluted by
   * cumulative deposits and unusable as a stop. From v1.11.4 it is PnL over
   * capital committed. Same name, different number: on KIO the two read -2.6%
   * and -26.9% at the same instant, so a `-3` threshold written under the old
   * definition is nowhere near the position it describes under the new one.
   *
   * The unit alone therefore cannot say whether a stored threshold is safe, and
   * a `pct` stamp written by v1.11.3 has to be rejected exactly like an unstamped
   * one. Unset means pre-v1.11.4 and is always stale.
   */
  measureRev?: number;
  /** Consecutive readings past a threshold so far. */
  streak: number;
  /** Which threshold the streak belongs to; a flip to the other side resets it. */
  streakSide?: "stop" | "target";
  /** Consecutive times firing was refused (usually an unroutable swap). */
  refusals: number;
  lastCheckAt?: number;
  /** The last reading taken, kept so the UI can show distance to the threshold. */
  lastReading?: number;
  /** Set when the triggers turned themselves off, with the reason shown in the UI. */
  disarmedReason?: string;
}

/**
 * Where a rebalance got to. A crash mid-sequence resumes from here.
 *
 * `atomic` is the whole of path A — one `rebalance_liquidity` instruction that
 * withdraws, re-centres and redeposits together, so it either lands or it did
 * not happen. Path B walks withdraw -> swap -> deposit, and each of those
 * boundaries is a point where funds can sit in the wallet instead of the pool.
 */
export type RebalancePhase = "atomic" | "withdraw" | "swap" | "deposit" | "done" | "failed";

/** A position this app manages (opened here, or adopted from the UI). */
export interface ManagedPosition {
  positionPk: string;
  poolAddress: string;
  /** Token symbols/mints cached for log + telegram readability. */
  pairName?: string;
  auto: boolean;
  // Per-position overrides; unset falls back to the global config value.
  rangeBins?: number;
  strategyType?: StrategyTypeName;
  edgeBufferBins?: number;
  cooldownMin?: number;
  /** Stop loss / take profit. Absent means never armed for this position. */
  triggers?: PositionTriggers;
  openedAt: number;
  /**
   * All-time fee income this position had already earned when the cost ledger
   * was last cleared, in USD.
   *
   * The ledger can be emptied from the dashboard; the indexer's `allTimeFees`
   * cannot. Without this, cost restarts at zero while fee income keeps counting
   * from the position's birth, and every ratio derived from the two — net, cost
   * drag — reads flatteringly and gives no sign of it. Subtracting the baseline
   * puts both back on the same window, which is the same rule
   * `partitionRebalances` applies across positions, applied across time.
   *
   * Unset means no reset has happened since this position was opened, so its
   * whole history counts.
   */
  feeBaselineUsd?: number;
  /** When that baseline was taken, so the dashboard can name the window. */
  feeBaselineAt?: number;
  lastRebalanceAt?: number;
  /**
   * When a rebalance was last ATTEMPTED, success or not. The cooldown keys off
   * this as well as lastRebalanceAt, which only advances on success — without it
   * a failing rebalance retried every poll interval, and a failure is usually
   * the moment you least want to hammer.
   */
  lastAttemptAt?: number;
  rebalanceCount: number;
  /** Poll samples used for the time-in-range metric. */
  pollsTotal: number;
  pollsInRange: number;
}

/**
 * A rebalance in flight. Written BEFORE each send and updated after each
 * confirmation, so a crash between the withdraw and the deposit leaves a record
 * that boot can resume — otherwise the funds sit idle in the wallet while the
 * position reads as empty.
 */
export interface JournalEntry {
  id: string;
  positionPk: string;
  poolAddress: string;
  /** "A" = single atomic rebalance ix. "B" = withdraw -> swap -> deposit. */
  path: "A" | "B";
  phase: RebalancePhase;
  targetMinBinId: number;
  targetMaxBinId: number;
  /**
   * The range the position occupied BEFORE this rebalance. Resume compares
   * against this, not against the target: the rebalance builder re-centres on
   * the active bin at send time, so what actually lands drifts from the target
   * the plan was computed on. Optional — entries written before this field
   * existed fall back to the exact-target comparison.
   */
  sourceMinBinId?: number;
  sourceMaxBinId?: number;
  /**
   * Rent this rebalance was expected to pay for new bin arrays. Captured at open
   * because a resume cannot re-derive it — by then the arrays already exist, so
   * a fresh estimate reads zero and the cost ledger would undercount.
   */
  rentLamports?: number;
  strategyType: StrategyTypeName;
  startedAt: number;
  updatedAt: number;
  /**
   * When this entry FIRST failed. Not `updatedAt`, which moves on every write
   * including the resume's own — so it cannot answer "how long were the funds
   * out of the position", which is the only question that matters while a
   * path-B rebalance sits half-finished. Set once and never overwritten.
   */
  failedAt?: number;
  /** How many times resume has picked this entry up. Drives "retry #N". */
  resumeAttempts?: number;
  sigs: string[];
  error?: string;
  /** Path B only: the ratio swap planned/executed between withdraw and deposit. */
  swap?: {
    inMint: string;
    outMint: string;
    /** Raw base units, as a string (BN is not JSON-safe). */
    inAmount: string;
    outAmount?: string;
    sig?: string;
    /** Realized execution cost in bps of notional — see RealizedSwapCost. */
    costBps?: number;
    /** The same cost in the pool's quote token. */
    costInY?: number;
  };
}

/** One completed rebalance, for the METRICS tab's cost-vs-fees view. */
export interface RebalanceRecord {
  ts: number;
  positionPk: string;
  poolAddress: string;
  path: "A" | "B";
  fromRange: [number, number];
  toRange: [number, number];
  /** Network + priority fees actually paid, in lamports. */
  costLamports: number;
  /** Rent paid for newly initialized bin arrays, in lamports. */
  rentLamports: number;
  /**
   * Realized swap cost in bps of the swapped notional, when a swap ran.
   *
   * Measured against the pool's own mid price, so it includes the AMM fees of
   * every hop the route took — not just slippage against the quote. Absent on
   * records written before this was measured, and on path A, which never swaps.
   */
  swapCostBps?: number;
  /** That cost in USD, so the ledger can add it to the lamport fees. */
  swapCostUsd?: number;
  /** The swapped notional in USD, for context on the bps figure. */
  swapValueUsd?: number;
  feesClaimedX?: string;
  feesClaimedY?: string;
  sigs: string[];
}

const MAX_REBALANCE_RECORDS = 1000;
const MAX_JOURNAL_ENTRIES = 100;

export interface PersistedState {
  version: 1;
  positions: ManagedPosition[];
  journal: JournalEntry[];
  rebalances: RebalanceRecord[];
  /**
   * When the cost ledger was last emptied, or unset if it never has been.
   *
   * The window every cost figure describes. Reported so the dashboard can say
   * "since 6 Aug" rather than presenting a few hours of spending as a lifetime
   * total, and so `feeBaselineCoverage` can tell a position opened after the
   * reset (nothing to exclude) from one that was there and could not be priced.
   */
  ledgerResetAt?: number;
  /** Global auto-rebalance kill switch set from the UI; overrides AUTO_REBALANCE. */
  autoOverride?: boolean;
  /** Runtime DRY_RUN override set from the UI. Undefined = use the env flag. */
  dryRunOverride?: boolean;
}

function emptyState(): PersistedState {
  return { version: 1, positions: [], journal: [], rebalances: [] };
}

export class Store {
  private file: string;
  private data: PersistedState;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, "state.json");
    this.data = this.load();
  }

  private load(): PersistedState {
    if (!existsSync(this.file)) return emptyState();
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<PersistedState>;
      return { ...emptyState(), ...parsed, version: 1 };
    } catch {
      // A corrupt state file must not block boot, but it also must not be
      // silently overwritten — keep the bad copy for inspection.
      const bak = `${this.file}.corrupt.${Date.now()}`;
      try {
        renameSync(this.file, bak);
      } catch {
        /* best effort */
      }
      return emptyState();
    }
  }

  private save(): void {
    // Write-then-rename so a crash mid-write can't truncate state.json — the
    // journal is the only thing standing between a crash and stranded funds.
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }

  get(): PersistedState {
    return this.data;
  }

  // ---- managed positions ----

  positions(): ManagedPosition[] {
    return this.data.positions;
  }

  position(pk: string): ManagedPosition | undefined {
    return this.data.positions.find((p) => p.positionPk === pk);
  }

  upsertPosition(pos: ManagedPosition): ManagedPosition {
    const i = this.data.positions.findIndex((p) => p.positionPk === pos.positionPk);
    if (i >= 0) this.data.positions[i] = { ...this.data.positions[i], ...pos };
    else this.data.positions.push(pos);
    this.save();
    return this.position(pos.positionPk)!;
  }

  patchPosition(pk: string, patch: Partial<ManagedPosition>): ManagedPosition | undefined {
    const p = this.position(pk);
    if (!p) return undefined;
    Object.assign(p, patch);
    this.save();
    return p;
  }

  /**
   * Merges a patch into a position's trigger state, creating it if absent.
   *
   * Separate from `patchPosition` because triggers are nested: passing
   * `{ triggers: { streak: 1 } }` through `Object.assign` would replace the whole
   * object and silently drop the thresholds along with it.
   */
  setTriggers(pk: string, patch: Partial<PositionTriggers>): PositionTriggers | undefined {
    const p = this.position(pk);
    if (!p) return undefined;
    p.triggers = { on: false, streak: 0, refusals: 0, ...p.triggers, ...patch };
    this.save();
    return p.triggers;
  }

  removePosition(pk: string): void {
    this.data.positions = this.data.positions.filter((p) => p.positionPk !== pk);
    this.save();
  }

  /** Records one poll sample for the time-in-range metric. */
  recordPoll(pk: string, inRange: boolean): void {
    const p = this.position(pk);
    if (!p) return;
    p.pollsTotal += 1;
    if (inRange) p.pollsInRange += 1;
    // Not saved per poll — recordPoll runs every tick and would thrash the disk.
    // Counters are flushed by the next save() from any other mutation, and by
    // flush() on shutdown. Losing a few samples on a hard kill is acceptable.
  }

  flush(): void {
    this.save();
  }

  // ---- rebalance journal ----

  openJournal(entry: JournalEntry): JournalEntry {
    this.data.journal.push(entry);
    if (this.data.journal.length > MAX_JOURNAL_ENTRIES) this.evictOldestTerminal();
    this.save();
    return entry;
  }

  /**
   * Drops the oldest entry that has REACHED a terminal phase, never a pending one.
   *
   * A blind shift() off the head was a fund-stranding bug: an entry stuck in
   * `pending` is the only record that funds are sitting in the wallet instead of
   * the pool, and at ~16 rebalances an hour this buffer wraps inside a day, so a
   * stuck entry at the head got deleted along with the evidence — resumeJournal
   * would never see it again. If every entry is pending we keep them all and let
   * the buffer grow; unbounded history is cheap next to unrecoverable funds.
   */
  private evictOldestTerminal(): void {
    const i = this.data.journal.findIndex((j) => j.phase === "done" || j.phase === "failed");
    if (i >= 0) this.data.journal.splice(i, 1);
  }

  journalEntry(id: string): JournalEntry | undefined {
    return this.data.journal.find((j) => j.id === id);
  }

  updateJournal(id: string, patch: Partial<JournalEntry>): void {
    const j = this.journalEntry(id);
    if (!j) return;
    Object.assign(j, patch, { updatedAt: Date.now() });
    this.save();
  }

  /**
   * The most recent journal entry for a position, whatever state it is in.
   *
   * Distinct from `pendingJournal`, which filters `failed` out — and a failure
   * alert needs precisely the entry that just failed. The path-A failure marks
   * itself `failed` immediately, so looking for it among the pending ones finds
   * nothing and the alert loses the phase it needs to say where the money is.
   */
  latestJournalFor(positionPk: string): JournalEntry | undefined {
    for (let i = this.data.journal.length - 1; i >= 0; i -= 1) {
      if (this.data.journal[i].positionPk === positionPk) return this.data.journal[i];
    }
    return undefined;
  }

  /** Entries that neither completed nor were marked failed — resume these at boot. */
  pendingJournal(): JournalEntry[] {
    return this.data.journal.filter((j) => j.phase !== "done" && j.phase !== "failed");
  }

  // ---- cost ledger ----

  recordRebalance(rec: RebalanceRecord): void {
    this.data.rebalances.push(rec);
    if (this.data.rebalances.length > MAX_REBALANCE_RECORDS) this.data.rebalances.shift();
    const p = this.position(rec.positionPk);
    if (p) {
      p.rebalanceCount += 1;
      p.lastRebalanceAt = rec.ts;
    }
    this.save();
  }

  rebalances(): RebalanceRecord[] {
    return this.data.rebalances;
  }

  /** When the cost ledger was last emptied, or undefined if it never has been. */
  ledgerResetAt(): number | undefined {
    return this.data.ledgerResetAt;
  }

  /**
   * Empties the cost ledger. Returns how many records were dropped.
   *
   * Deliberately does NOT touch each position's `rebalanceCount` or
   * `lastRebalanceAt`: those are the position's own state, and `lastRebalanceAt`
   * is what the cooldown guard reads (`Engine.evaluate`). Clearing it here would
   * let a position rebalance again immediately — a chart reset must never move
   * real money. The journal is untouched for the same reason: a pending entry is
   * the only record that funds are sitting in the wallet.
   *
   * `feeBaselines` is each managed position's all-time fee income as it stands
   * right now, keyed by position. Cost is about to restart at zero, and the
   * indexer's fee figure will not — so the baseline is what keeps the two
   * comparable afterwards. The caller reads those figures; passing an empty map
   * clears the ledger without one, which is only correct when there is nothing
   * managed to compare against.
   */
  clearRebalances(feeBaselines: ReadonlyMap<string, number> = new Map()): number {
    const n = this.data.rebalances.length;
    this.data.rebalances = [];

    const at = Date.now();
    this.data.ledgerResetAt = at;
    for (const p of this.data.positions) {
      const baseline = feeBaselines.get(p.positionPk);
      // A position whose fees could not be read is left with no baseline rather
      // than a stale or invented one, and metrics reports it as uncovered.
      if (baseline === undefined) continue;
      p.feeBaselineUsd = baseline;
      p.feeBaselineAt = at;
    }

    this.save();
    return n;
  }

  // ---- global toggles ----

  setAutoOverride(v: boolean | undefined): void {
    this.data.autoOverride = v;
    this.save();
  }

  setDryRunOverride(v: boolean | undefined): void {
    this.data.dryRunOverride = v;
    this.save();
  }
}
