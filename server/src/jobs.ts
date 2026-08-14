import { AppError } from "@omnilp/shared";
import { z } from "zod";

import type { Config } from "./config.js";
import { BaseService } from "./services/base.js";
import { StonService } from "./services/ston.js";
import type { Store } from "./store/types.js";

const jobPayloadSchema = z.object({
  flowId: z.string().uuid(),
  transactionId: z.string().uuid(),
});
const maxAttempts = 24;

export function getFailedState(
  kind: "source" | "deposit" | "withdraw" | "exit",
) {
  if (kind === "source") return "source_rejected" as const;
  if (kind === "deposit") return "deposit_failed" as const;
  if (kind === "withdraw") return "withdraw_failed" as const;
  return "exit_failed" as const;
}

export class Jobs {
  private readonly base: BaseService;
  private readonly ston: StonService;

  constructor(
    private readonly config: Config,
    private readonly store: Store,
    ston?: StonService,
  ) {
    this.base = new BaseService(config);
    this.ston = ston ?? new StonService(config);
  }

  async run(worker: string): Promise<number> {
    const jobs = await this.store.claimJobs(worker, 10);
    for (const job of jobs) {
      try {
        if (job.type !== "verify_transaction") {
          throw new AppError(
            "INTERNAL_ERROR",
            `Unknown job type: ${job.type}`,
            500,
          );
        }
        await this.verify(job.payload);
        await this.store.finishJob(job.id);
      } catch (error) {
        if (job.type !== "verify_transaction") {
          await this.store.finishJob(job.id);
          continue;
        }
        if (!isRetryable(error) || job.attempts >= maxAttempts) {
          await this.reject(job.payload);
          await this.store.finishJob(job.id);
          continue;
        }
        const delay = Math.min(300, 2 ** Math.min(job.attempts, 8));
        await this.store.failJob(
          job.id,
          error instanceof Error ? error.message : String(error),
          new Date(Date.now() + delay * 1_000).toISOString(),
        );
      }
    }
    return jobs.length;
  }

  private async reject(payload: unknown): Promise<void> {
    const { flowId, transactionId } = jobPayloadSchema.parse(payload);
    const [flow, saved] = await Promise.all([
      this.store.getFlow(flowId),
      this.store.getTransaction(transactionId),
    ]);
    if (
      !flow ||
      !saved ||
      saved.flowId !== flow.id ||
      saved.status !== "pending"
    )
      return;
    try {
      await this.store.finishTransaction(
        saved.id,
        "failed",
        getFailedState(saved.kind),
        flow.version,
        `transaction:${saved.id}:failed`,
      );
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "CONFLICT")
        throw error;
      await this.store.setTransactionStatus(saved.id, "failed", null);
    }
  }

  private async verify(payload: unknown): Promise<void> {
    const { flowId, transactionId } = jobPayloadSchema.parse(payload);
    const [flow, transaction] = await Promise.all([
      this.store.getFlow(flowId),
      this.store.getTransaction(transactionId),
    ]);
    if (!flow || !transaction || transaction.flowId !== flow.id) {
      throw new AppError(
        "NOT_FOUND",
        "Verification target no longer exists",
        404,
      );
    }
    if (transaction.status !== "pending") return;

    let result: "pending" | "failed" | "confirmed";
    if (transaction.kind === "source" || transaction.kind === "exit") {
      const quote = await this.store.getQuote(flow.id);
      if (!quote)
        throw new AppError("PROOF_REQUIRED", "Accepted quote is missing", 409);
      result =
        transaction.kind === "source"
          ? await this.base.verifySource(transaction.hash, flow, quote)
          : await this.base.verifyExit(
              transaction.hash,
              flow,
              quote,
              this.config.BASE_USDC,
            );
    } else {
      result = await this.ston.verifyLiquidityAction(
        transaction.hash,
        flow.tonWallet,
        transaction.kind,
      );
    }
    if (result === "pending")
      throw new AppError(
        "PROOF_REQUIRED",
        "Evidence is still pending",
        409,
        true,
      );
    if (result === "failed") {
      const next = getFailedState(transaction.kind);
      await this.store.finishTransaction(
        transaction.id,
        "failed",
        next,
        flow.version,
        `transaction:${transaction.id}:failed`,
      );
      return;
    }

    const confirmedAt = new Date().toISOString();
    if (transaction.kind === "source") {
      await this.store.finishTransaction(
        transaction.id,
        "confirmed",
        "trade_pending",
        flow.version,
        `transaction:${transaction.id}:confirmed`,
      );
      return;
    }
    if (transaction.kind === "deposit") {
      const [plan, pool] = await Promise.all([
        this.store.getPlan(flow.id),
        this.store.getPool(flow.poolId),
      ]);
      if (!plan || !pool)
        throw new AppError("PROOF_REQUIRED", "Deposit plan is missing", 409);
      const lpUnits = await this.ston.getPosition(flow.tonWallet, pool.address);
      const delta = BigInt(lpUnits) - BigInt(plan.lpUnitsBefore);
      if (delta < BigInt(plan.minLpUnits)) {
        throw new AppError(
          "PROOF_REQUIRED",
          "Wallet LP balance did not increase by the plan minimum",
          409,
        );
      }
      const position = {
        flowId: flow.id,
        wallet: flow.tonWallet,
        poolId: pool.id,
        lpUnits: delta.toString(),
        entryValueUsdUnits: flow.sourceUnits,
        proofReference: `ton:${transaction.hash}`,
        openedAt: confirmedAt,
        closedAt: null,
      };
      await this.store.finishTransaction(
        transaction.id,
        "confirmed",
        "complete",
        flow.version,
        `position:ton:${transaction.hash}`,
        position,
      );
      return;
    }
    if (transaction.kind === "withdraw") {
      await this.store.finishTransaction(
        transaction.id,
        "confirmed",
        "assets_received",
        flow.version,
        `transaction:${transaction.id}:confirmed`,
      );
      return;
    }
    await this.store.finishTransaction(
      transaction.id,
      "confirmed",
      "exit_complete",
      flow.version,
      `transaction:${transaction.id}:confirmed`,
    );
  }
}

function isRetryable(error: unknown): boolean {
  return !(error instanceof AppError) || error.retryable;
}
