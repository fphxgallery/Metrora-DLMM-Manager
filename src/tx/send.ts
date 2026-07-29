import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
  type SimulatedTransactionResponse,
} from "@solana/web3.js";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";

export interface SendResult {
  label: string;
  dryRun: boolean;
  /** Present only when the transaction was actually sent and confirmed. */
  signature?: string;
  unitsConsumed?: number;
  /** Simulation logs, kept on failure and in dry-run so the UI can show why. */
  logs?: string[];
  /** Fee actually paid in lamports; estimated from the simulation in dry-run. */
  feeLamports?: number;
}

export class TxError extends Error {
  constructor(
    message: string,
    readonly logs?: string[],
  ) {
    super(message);
    this.name = "TxError";
  }
}

/** How often an already-signed transaction is rebroadcast while awaiting confirmation. */
const REBROADCAST_INTERVAL_MS = 2_000;

/**
 * Only retighten a compute-unit limit that exceeds simulated usage by more than
 * this. Well above any plausible simulate-vs-execute drift, so ordinary
 * transactions are left alone entirely.
 */
const CU_RETIGHTEN_RATIO = 3;
/** Headroom kept when retightening: half again the simulated usage, plus a floor. */
const CU_SAFETY_MULTIPLIER = 1.5;
const CU_SAFETY_FLOOR = 20_000;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Builds, simulates, signs and confirms transactions.
 *
 * Every transaction is simulated before it is sent, for two reasons: it is the
 * mechanism behind DRY_RUN (simulate, report, send nothing), and it turns most
 * program errors into a readable message before any fee is paid. A rebalance
 * that fails halfway is the expensive failure mode this app has, so failing at
 * simulation is always preferable.
 *
 * Confirmation REBROADCASTS rather than waiting passively — see
 * confirmWithRebroadcast for why a single broadcast is not enough.
 */
export class TxSender {
  constructor(
    private readonly cfg: Config,
    private readonly connection: Connection,
    private readonly log: Logger,
    private readonly dryRun: () => boolean,
  ) {}

  /**
   * Compute-budget instructions to prepend, filling in only what the builder
   * didn't already set.
   *
   * Checked independently per instruction TYPE (byte 0 of the instruction data
   * is the discriminator: 2 = SetComputeUnitLimit, 3 = SetComputeUnitPrice), not
   * "any ComputeBudgetProgram instruction present". Some SDK-built transactions
   * (e.g. `createExtendedEmptyPosition`, which sizes its own CU limit from the
   * number of bins being extended) set a compute-unit LIMIT but never a
   * priority-fee PRICE — treating that as "budget already handled" would send
   * the transaction with zero priority fee and risk it never landing under
   * congestion.
   */
  private budgetIxs(tx: Transaction): TransactionInstruction[] {
    const has = (discriminator: number) =>
      tx.instructions.some(
        (ix) => ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === discriminator,
      );
    const out: TransactionInstruction[] = [];
    if (!has(2)) out.push(ComputeBudgetProgram.setComputeUnitLimit({ units: this.cfg.computeUnitLimit }));
    if (!has(3)) out.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.cfg.priorityFeeMicroLamports }));
    return out;
  }

  async send(tx: Transaction, signers: Keypair[], label: string): Promise<SendResult> {
    const payer = signers[0];
    const budget = this.budgetIxs(tx);
    if (budget.length > 0) tx.instructions.unshift(...budget);

    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = payer.publicKey;
    tx.sign(...signers);

    const sim = await this.connection.simulateTransaction(tx);
    assertSimulationOk(sim.value, label);

    const dryRun = this.dryRun();
    const base = {
      label,
      dryRun,
      unitsConsumed: sim.value.unitsConsumed,
      logs: sim.value.logs ?? undefined,
    };

    if (dryRun) {
      this.log.info(
        { label, unitsConsumed: sim.value.unitsConsumed, instructions: tx.instructions.length },
        "DRY-RUN: simulated ok, not sending",
      );
      return base;
    }

    const tightened = this.retightenComputeLimit(tx, sim.value.unitsConsumed ?? undefined);
    if (tightened !== null) {
      // Changing an instruction invalidates the signature; sign() rebuilds it
      // from scratch. The blockhash is untouched, so its window is unaffected.
      tx.sign(...signers);
      this.log.info(
        { label, unitsConsumed: sim.value.unitsConsumed, computeUnitLimit: tightened },
        "compute limit retightened",
      );
    }

    const signature = await this.confirmWithRebroadcast(
      tx.serialize(), // already simulated above
      label,
      sim.value.logs ?? undefined,
      async () => (await this.connection.getBlockHeight("confirmed")) > lastValidBlockHeight,
    );

    const feeLamports = await this.feeOf(signature);
    this.log.info({ label, signature, feeLamports }, "transaction confirmed");
    return { ...base, signature, feeLamports };
  }

  /**
   * Sends transactions in order, stopping at the first failure. The SDK returns
   * arrays for flows that cannot fit in one transaction (wide removes, claim-all),
   * where the parts are individually valid — a partial run leaves a consistent
   * on-chain state, and the caller reports which parts landed.
   */
  async sendAll(txs: Transaction[], signers: Keypair[], label: string): Promise<SendResult[]> {
    const out: SendResult[] = [];
    for (const [i, tx] of txs.entries()) {
      out.push(await this.send(tx, signers, txs.length > 1 ? `${label} (${i + 1}/${txs.length})` : label));
    }
    return out;
  }

  /**
   * Sends an already-signed versioned transaction (Jupiter builds and we sign
   * these; blockhash and compute budget come from Jupiter, so nothing here may
   * modify the message).
   */
  async sendVersioned(tx: VersionedTransaction, label: string): Promise<SendResult> {
    const sim = await this.connection.simulateTransaction(tx, { replaceRecentBlockhash: true });
    assertSimulationOk(sim.value, label);

    const dryRun = this.dryRun();
    const base = { label, dryRun, unitsConsumed: sim.value.unitsConsumed, logs: sim.value.logs ?? undefined };
    if (dryRun) {
      this.log.info({ label, unitsConsumed: sim.value.unitsConsumed }, "DRY-RUN: simulated ok, not sending");
      return base;
    }

    // Expiry is judged against the transaction's OWN blockhash — Jupiter set it
    // when it built the message. The previous code fetched a fresh blockhash
    // *after* sending and confirmed against that, which measured the lifetime of
    // an unrelated blockhash rather than this transaction's.
    const txBlockhash = tx.message.recentBlockhash;
    const signature = await this.confirmWithRebroadcast(
      tx.serialize(),
      label,
      sim.value.logs ?? undefined,
      async () => !(await this.connection.isBlockhashValid(txBlockhash, { commitment: "confirmed" })).value,
    );

    const feeLamports = await this.feeOf(signature);
    this.log.info({ label, signature, feeLamports }, "transaction confirmed");
    return { ...base, signature, feeLamports };
  }

  async sendInstructions(ixs: TransactionInstruction[], signers: Keypair[], label: string): Promise<SendResult> {
    const tx = new Transaction().add(...ixs);
    return this.send(tx, signers, label);
  }

  /**
   * Shrinks a wildly oversized compute-unit limit to what the transaction
   * actually used. Returns the new limit, or null if it was left alone.
   *
   * The priority fee is price x limit, but scheduling priority comes from the
   * per-CU PRICE alone — so an inflated limit buys nothing and is pure waste.
   * The Meteora SDK sets its own limit, and when its internal CU estimation
   * fails it falls back to a near-max 1,400,000. That estimation simulates the
   * bare rebalance instruction WITHOUT the ATA-creation instructions this app
   * prepends, so on a position whose wSOL ATA has been closed it fails every
   * time and the fallback is what ships: ~280,000 lamports of priority fee where
   * the real usage implies nearer 120,000.
   *
   * Deliberately conservative. Cutting too close fails on chain with "exceeded
   * compute units", and unlike an expired blockhash that fee IS charged — so
   * this only fires on limits that are disproportionate by a wide margin, and
   * leaves 50% headroom plus a floor when it does.
   */
  private retightenComputeLimit(tx: Transaction, unitsConsumed: number | undefined): number | null {
    if (!unitsConsumed || unitsConsumed <= 0) return null;

    const idx = tx.instructions.findIndex(
      (ix) => ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 2,
    );
    if (idx < 0) return null;

    const current = tx.instructions[idx].data.readUInt32LE(1);
    if (current <= unitsConsumed * CU_RETIGHTEN_RATIO) return null;

    const units = Math.min(current, Math.ceil(unitsConsumed * CU_SAFETY_MULTIPLIER) + CU_SAFETY_FLOOR);
    tx.instructions[idx] = ComputeBudgetProgram.setComputeUnitLimit({ units });
    return units;
  }

  /**
   * Broadcasts a signed transaction and waits for it, resending the SAME bytes
   * every couple of seconds until it confirms or its blockhash dies.
   *
   * `sendRawTransaction` + `confirmTransaction` broadcasts exactly once and then
   * waits. If that one broadcast is dropped — RPC ingest throttling, a leader
   * transition — nothing ever retries it, and the full ~60s validity window
   * burns down to "block height exceeded" for a transaction that was never
   * actually delivered. That is not a rare edge: it stranded a path-B deposit
   * leg three times on live funds, twice with the priority fee an order of
   * magnitude above the going rate, which rules out fee starvation as the cause.
   *
   * Rebroadcasting is safe because the bytes are already signed: the signature
   * is fixed, so a duplicate that arrives after inclusion is simply discarded by
   * the network. It cannot double-execute.
   */
  private async confirmWithRebroadcast(
    raw: Uint8Array,
    label: string,
    simLogs: string[] | undefined,
    expired: () => Promise<boolean>,
  ): Promise<string> {
    // maxRetries 0: this loop owns rebroadcasting, so the RPC should not also
    // retry on its own schedule.
    const opts = { skipPreflight: true, maxRetries: 0 };
    const signature = await this.connection.sendRawTransaction(raw, opts);
    this.log.info({ label, signature }, "transaction sent");

    for (let attempt = 1; ; attempt++) {
      const { value } = await this.connection.getSignatureStatus(signature);
      if (value?.err) {
        throw new TxError(`${label} failed on chain: ${JSON.stringify(value.err)}`, simLogs);
      }
      if (value?.confirmationStatus === "confirmed" || value?.confirmationStatus === "finalized") {
        // Attempt 2 is the ORDINARY path: the first poll fires immediately after
        // the broadcast, when nothing could possibly be confirmed yet. Logging a
        // rebroadcast there implies the retry did work it did not do. Only from
        // the third poll on has a resend plausibly mattered.
        if (attempt >= 3) {
          this.log.info({ label, signature, rebroadcasts: attempt - 1 }, "confirmed after rebroadcast");
        }
        return signature;
      }

      if (await expired()) {
        // Re-check with history before giving up: the block-height read is at
        // `confirmed`, so a transaction that landed in the last slot or two can
        // still be invisible above. Without this the caller would be told
        // nothing landed while the funds had in fact moved.
        const final = await this.connection.getSignatureStatus(signature, {
          searchTransactionHistory: true,
        });
        if (final.value && !final.value.err) return signature;
        if (final.value?.err) {
          throw new TxError(`${label} failed on chain: ${JSON.stringify(final.value.err)}`, simLogs);
        }
        throw new Error(
          `${label}: blockhash expired after ${attempt} broadcast attempts without ${signature} ` +
            "being included. It can no longer land and no fee was paid — safe to retry.",
        );
      }

      await delay(REBROADCAST_INTERVAL_MS);
      // Same signed bytes, same signature — a no-op if it already landed.
      await this.connection.sendRawTransaction(raw, opts).catch(() => undefined);
    }
  }

  /** Actual fee paid, for the cost ledger. Best effort — never fails the send. */
  private async feeOf(signature: string): Promise<number | undefined> {
    try {
      const tx = await this.connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      return tx?.meta?.fee;
    } catch {
      return undefined;
    }
  }
}

/**
 * Turns a failed simulation into a readable error. Anchor puts the useful part
 * ("custom program error: 0x1771", "insufficient funds") in the logs, not in the
 * err object, so both are surfaced.
 */
function assertSimulationOk(sim: SimulatedTransactionResponse, label: string): void {
  if (!sim.err) return;
  const logs = sim.logs ?? [];
  const reason =
    logs.find((l) => /Error|failed|insufficient|exceeded/i.test(l))?.trim() ?? JSON.stringify(sim.err);
  throw new TxError(`${label} would fail: ${reason}`, logs);
}
