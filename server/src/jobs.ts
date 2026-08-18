import { AppError, isExpired } from "@omnilp/shared";
import { z } from "zod";

import type { Config } from "./config.js";
import { BaseService } from "./services/base.js";
import { OmniService } from "./services/omni.js";
import { StonService } from "./services/ston.js";
import type { Store, TradeRecord } from "./store/types.js";

const jobPayloadSchema = z.object({
  flowId: z.string().uuid(),
  transactionId: z.string().uuid(),
});
const tradePayloadSchema = z.object({
  flowId: z.string().uuid(),
  tradeId: z.string().min(1),
});
const maxAttempts = 24;
const maxTradeAttempts = 48;

export function getFailedState(
  kind: "source" | "deposit" | "withdraw" | "exit",
) {
  if (kind === "source") return "source_rejected" as const;
  if (kind === "deposit") return "deposit_failed" as const;
  if (kind === "withdraw") return "withdraw_failed" as const;
  return "exit_failed" as const;
}

function mapTradeStatus(
  upstream: string,
): { state: string; receivedUnits: string | null } {
  const s = upstream.toUpperCase();
  if (s.includes("FULLY_FILLED") || s.includes("SETTLED") || s === "FILLED")
    return { state: "filled", receivedUnits: null };
  if (s.includes("PARTIALLY_FILLED") || s.includes("PARTIAL"))
    return { state: "partial", receivedUnits: null };
  if (s.includes("CANCELLED") || s.includes("FAILED") || s.includes("ABORTED"))
    return { state: "failed", receivedUnits: null };
  if (s.includes("MATCHED") || s.includes("EXECUTING") || s.includes("PENDING"))
    return { state: "matched", receivedUnits: null };
  if (s.includes("REGISTERED") || s.includes("ACCEPTED"))
    return { state: "registered", receivedUnits: null };
  return { state: "settling", receivedUnits: null };
}

export class Jobs {
  private readonly base: BaseService;
  private readonly ston: StonService;
  private readonly omni: OmniService;

  constructor(
    private readonly config: Config,
    private readonly store: Store,
    ston?: StonService,
    omni?: OmniService,
  ) {
    this.base = new BaseService(config);
    this.ston = ston ?? new StonService(config);
    this.omni = omni ?? new OmniService(config);
  }

  async run(worker: string): Promise<number> {
    const jobs = await this.store.claimJobs(worker, 10);
    for (const job of jobs) {
      try {
        if (job.type === "verify_transaction") {
          await this.verify(job.payload);
          await this.store.finishJob(job.id);
        } else if (job.type === "track_trade") {
          await this.trackTrade(job.payload);
          await this.store.finishJob(job.id);
        } else if (job.type === "quote_expiry") {
          await this.expireQuote(job.payload);
          await this.store.finishJob(job.id);
        } else {
          throw new AppError(
            "INTERNAL_ERROR",
            `Unknown job type: ${job.type}`,
            500,
          );
        }
      } catch (error) {
        const max =
          job.type === "track_trade" ? maxTradeAttempts : maxAttempts;
        if (!isRetryable(error) || job.attempts >= max) {
          if (job.type === "verify_transaction") await this.reject(job.payload);
          else await this.store.finishJob(job.id);
          continue;
        }
        const delay =
          job.type === "track_trade"
            ? Math.min(60, 2 ** Math.min(job.attempts, 6))
            : Math.min(300, 2 ** Math.min(job.attempts, 8));
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

  private async trackTrade(payload: unknown): Promise<void> {
    const { flowId } = tradePayloadSchema.parse(payload);
    const [flow, trade] = await Promise.all([
      this.store.getFlow(flowId),
      this.store.getTrade(flowId),
    ]);
    if (!flow || !trade) return;
    const terminal = new Set([
      "filled",
      "partial",
      "failed",
      "expired",
    ]);
    if (terminal.has(trade.status)) return;
    const { status, receivedUnits } = await this.omni.trackTrade(
      trade.orderHash,
    );
    const mapped = mapTradeStatus(status);
    await this.store.updateTrade(trade.id, {
      status: mapped.state as TradeRecord["status"],
      receivedUnits: receivedUnits ?? trade.receivedUnits,
      checkedAt: new Date().toISOString(),
    });
    if (mapped.state === "filled") {
      const current = await this.store.getFlow(flowId);
      if (!current) return;
      if (current.state !== "trade_pending") return;
      const nextReceived = receivedUnits ?? trade.receivedUnits;
      if (nextReceived) {
        await this.store.updateTrade(trade.id, {
          reference: `units:${nextReceived}`,
        });
      }
      const updated = await this.store.setState(
        flowId,
        "trade_filled",
        `trade:${trade.orderHash}:filled`,
        current.version,
      );
      await this.store.setState(
        flowId,
        "funds_received",
        `trade:${trade.orderHash}:received`,
        updated.version,
      );
    } else if (mapped.state === "partial") {
      const current = await this.store.getFlow(flowId);
      if (!current) return;
      if (current.state !== "trade_pending") return;
      await this.store.setState(
        flowId,
        "trade_partial",
        `trade:${trade.orderHash}:partial`,
        current.version,
      );
    } else if (mapped.state === "failed") {
      const current = await this.store.getFlow(flowId);
      if (!current) return;
      if (current.state !== "trade_pending") return;
      await this.store.setState(
        flowId,
        "trade_failed",
        `trade:${trade.orderHash}:failed`,
        current.version,
      );
    }
  }

  private async expireQuote(payload: unknown): Promise<void> {
    const result = z.object({ flowId: z.string().uuid() }).safeParse(payload);
    if (!result.success) return;
    const { flowId } = result.data;
    const flow = await this.store.getFlow(flowId);
    if (!flow) return;
    if (flow.state !== "quoted") return;
    const quote = await this.store.getQuote(flowId);
    if (!quote) return;
    if (!isExpired(quote.expiresAt)) return;
    try {
      await this.store.setState(
        flowId,
        "quote_expired",
        `quote:${quote.id}:expired`,
        flow.version,
      );
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "CONFLICT")
        throw error;
    }
  }
}

function isRetryable(error: unknown): boolean {
  return !(error instanceof AppError) || error.retryable;
}
