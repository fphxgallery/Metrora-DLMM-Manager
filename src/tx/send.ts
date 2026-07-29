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

/**
 * Builds, simulates, signs and confirms transactions.
 *
 * Every transaction is simulated before it is sent, for two reasons: it is the
 * mechanism behind DRY_RUN (simulate, report, send nothing), and it turns most
 * program errors into a readable message before any fee is paid. A rebalance
 * that fails halfway is the expensive failure mode this app has, so failing at
 * simulation is always preferable.
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

    const signature = await this.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true, // already simulated above
      maxRetries: 5,
    });
    this.log.info({ label, signature }, "transaction sent");

    const conf = await this.connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    if (conf.value.err) {
      throw new TxError(`${label} failed on chain: ${JSON.stringify(conf.value.err)}`, sim.value.logs ?? undefined);
    }

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

    const signature = await this.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 5,
    });
    this.log.info({ label, signature }, "transaction sent");

    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash("confirmed");
    const conf = await this.connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    if (conf.value.err) {
      throw new TxError(`${label} failed on chain: ${JSON.stringify(conf.value.err)}`, sim.value.logs ?? undefined);
    }

    const feeLamports = await this.feeOf(signature);
    this.log.info({ label, signature, feeLamports }, "transaction confirmed");
    return { ...base, signature, feeLamports };
  }

  async sendInstructions(ixs: TransactionInstruction[], signers: Keypair[], label: string): Promise<SendResult> {
    const tx = new Transaction().add(...ixs);
    return this.send(tx, signers, label);
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
