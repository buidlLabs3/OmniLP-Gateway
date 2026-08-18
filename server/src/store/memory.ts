import { randomUUID } from "node:crypto";

import {
  AppError,
  assertState,
  createFlowSchema,
  flowSchema,
  type CreateFlow,
  type Flow,
  type FlowEvent,
  type FlowState,
  type Pool,
  type Quote,
  type DepositPlan,
} from "@omnilp/shared";

import type {
  IdempotencyRecord,
  JobRecord,
  PositionRecord,
  Store,
  TradeRecord,
  TransactionRecord,
  WalletChallenge,
} from "./types.js";

export class MemoryStore implements Store {
  private readonly flows = new Map<string, Flow>();
  private readonly events = new Map<string, FlowEvent[]>();
  private readonly pools = new Map<string, Pool>();
  private readonly quotes = new Map<string, Quote>();
  private readonly quoteHashes = new Map<string, string>();
  private readonly plans = new Map<string, DepositPlan>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly transactions = new Map<string, TransactionRecord>();
  private readonly trades = new Map<string, TradeRecord>();
  private readonly positions = new Map<string, PositionRecord>();
  private readonly jobs = new Map<
    string,
    JobRecord & { lockedBy?: string; lastError?: string }
  >();
  private readonly challenges = new Map<string, WalletChallenge>();

  async health(): Promise<boolean> {
    return true;
  }

  async listPools(): Promise<Pool[]> {
    return [...this.pools.values()].map((pool) => structuredClone(pool));
  }

  async getPool(id: string): Promise<Pool | null> {
    const pool = this.pools.get(id);
    return pool ? structuredClone(pool) : null;
  }

  async savePools(pools: Pool[]): Promise<void> {
    for (const pool of pools) this.pools.set(pool.id, structuredClone(pool));
  }

  async saveQuote(quote: Quote, rawHash: string): Promise<Quote> {
    if (!/^[0-9a-f]{64}$/.test(rawHash)) {
      throw new AppError("QUOTE_INVALID", "Quote hash is invalid", 502);
    }
    const current = this.quotes.get(quote.flowId);
    if (current?.id === quote.id) {
      if (this.quoteHashes.get(quote.flowId) !== rawHash) {
        throw new AppError(
          "QUOTE_INVALID",
          "Quote ID was reused with different data",
          502,
        );
      }
      return structuredClone(current);
    }
    this.quotes.set(quote.flowId, structuredClone(quote));
    this.quoteHashes.set(quote.flowId, rawHash);
    return structuredClone(quote);
  }

  async getQuote(flowId: string): Promise<Quote | null> {
    return structuredClone(this.quotes.get(flowId) ?? null);
  }

  async savePlan(plan: DepositPlan): Promise<DepositPlan> {
    this.plans.set(plan.flowId, structuredClone(plan));
    return structuredClone(plan);
  }

  async getPlan(flowId: string): Promise<DepositPlan | null> {
    return structuredClone(this.plans.get(flowId) ?? null);
  }

  async getReceivedUnits(flowId: string): Promise<string | null> {
    const trade = [...this.trades.values()]
      .filter((item) => item.flowId === flowId)
      .sort(
        (left, right) =>
          Date.parse(left.checkedAt) - Date.parse(right.checkedAt),
      )
      .at(-1);
    return trade?.receivedUnits ?? null;
  }

  async saveTrade(input: Omit<TradeRecord, "id">): Promise<TradeRecord> {
    const existing = [...this.trades.values()].find(
      (t) => t.flowId === input.flowId,
    );
    if (existing) {
      if (
        existing.quoteId !== input.quoteId ||
        existing.orderHash !== input.orderHash
      ) {
        throw new AppError(
          "CONFLICT",
          "Trade already exists with different data",
          409,
        );
      }
      return structuredClone(existing);
    }
    const trade: TradeRecord = { id: randomUUID(), ...input };
    this.trades.set(trade.id, structuredClone(trade));
    return structuredClone(trade);
  }

  async getTrade(flowId: string): Promise<TradeRecord | null> {
    const trade = [...this.trades.values()]
      .filter((t) => t.flowId === flowId)
      .sort(
        (left, right) =>
          Date.parse(left.checkedAt) - Date.parse(right.checkedAt),
      )
      .at(-1);
    return trade ? structuredClone(trade) : null;
  }

  async updateTrade(
    id: string,
    update: Partial<
      Pick<TradeRecord, "status" | "receivedUnits" | "reference" | "checkedAt">
    >,
  ): Promise<TradeRecord> {
    const trade = this.trades.get(id);
    if (!trade) throw new AppError("NOT_FOUND", "Trade not found", 404);
    Object.assign(trade, update);
    return structuredClone(trade);
  }

  async createFlow(input: CreateFlow): Promise<Flow> {
    const value = createFlowSchema.parse(input);
    const now = new Date().toISOString();
    const flow = flowSchema.parse({
      id: randomUUID(),
      type: value.type,
      state: value.type === "entry" ? "draft" : "exit_draft",
      poolId: value.poolId,
      baseWallet: value.baseWallet,
      tonWallet: value.tonWallet,
      sourceUnits: value.sourceUnits,
      createdAt: now,
      updatedAt: now,
      version: 0,
    });
    const event: FlowEvent = {
      id: randomUUID(),
      flowId: flow.id,
      priorState: null,
      nextState: flow.state,
      reference: "flow_created",
      createdAt: now,
    };
    this.flows.set(flow.id, flow);
    this.events.set(flow.id, [event]);
    return structuredClone(flow);
  }

  async listFlows(): Promise<Flow[]> {
    return [...this.flows.values()].map((flow) => structuredClone(flow));
  }

  async getFlow(id: string): Promise<Flow | null> {
    const flow = this.flows.get(id);
    return flow ? structuredClone(flow) : null;
  }

  async listEvents(flowId: string): Promise<FlowEvent[]> {
    return structuredClone(this.events.get(flowId) ?? []);
  }

  async setState(
    flowId: string,
    next: FlowState,
    reference: string,
    version: number,
  ): Promise<Flow> {
    const current = this.flows.get(flowId);
    if (!current) throw new AppError("NOT_FOUND", "Flow not found", 404);
    if (current.version !== version) {
      throw new AppError(
        "CONFLICT",
        "Flow changed; reload before continuing",
        409,
        true,
      );
    }
    assertState(current.state, next);
    const now = new Date().toISOString();
    const updated = flowSchema.parse({
      ...current,
      state: next,
      updatedAt: now,
      version: current.version + 1,
    });
    const event: FlowEvent = {
      id: randomUUID(),
      flowId,
      priorState: current.state,
      nextState: next,
      reference,
      createdAt: now,
    };
    this.flows.set(flowId, updated);
    this.events.set(flowId, [...(this.events.get(flowId) ?? []), event]);
    return structuredClone(updated);
  }

  async getIdempotency(
    scope: string,
    key: string,
  ): Promise<IdempotencyRecord | null> {
    return structuredClone(this.idempotency.get(`${scope}:${key}`) ?? null);
  }

  async reserveIdempotency(
    scope: string,
    key: string,
    hash: string,
  ): Promise<IdempotencyRecord | null> {
    const id = `${scope}:${key}`;
    const current = this.idempotency.get(id);
    if (current) return structuredClone(current);
    this.idempotency.set(id, { hash, status: 102, response: null });
    return null;
  }

  async saveIdempotency(
    scope: string,
    key: string,
    hash: string,
    status: number,
    response: unknown,
  ): Promise<void> {
    const id = `${scope}:${key}`;
    const current = this.idempotency.get(id);
    if (current && current.hash !== hash) {
      throw new AppError(
        "CONFLICT",
        "Idempotency key was used for different input",
        409,
      );
    }
    this.idempotency.set(id, {
      hash,
      status,
      response: structuredClone(response),
    });
  }

  async clearIdempotency(
    scope: string,
    key: string,
    hash: string,
  ): Promise<void> {
    const id = `${scope}:${key}`;
    const current = this.idempotency.get(id);
    if (current?.hash === hash && current.status === 102)
      this.idempotency.delete(id);
  }

  async saveTransaction(
    input: Omit<TransactionRecord, "id">,
  ): Promise<TransactionRecord> {
    const key = `${input.chain}:${input.hash}`;
    const current = this.transactions.get(key);
    if (current) {
      if (
        current.flowId !== input.flowId ||
        current.kind !== input.kind ||
        current.attempt !== input.attempt
      ) {
        throw new AppError(
          "CONFLICT",
          "Transaction reference is already assigned",
          409,
        );
      }
      return structuredClone(current);
    }
    const duplicateAttempt = [...this.transactions.values()].some(
      (item) =>
        item.flowId === input.flowId &&
        item.kind === input.kind &&
        item.attempt === input.attempt,
    );
    if (duplicateAttempt) {
      throw new AppError(
        "CONFLICT",
        "Transaction attempt already has a reference",
        409,
      );
    }
    const transaction = { id: randomUUID(), ...input };
    this.transactions.set(key, transaction);
    return structuredClone(transaction);
  }

  async submitTransaction(
    input: Omit<TransactionRecord, "id">,
    next: FlowState,
    version: number,
  ): Promise<{ flow: Flow; transaction: TransactionRecord }> {
    const key = `${input.chain}:${input.hash}`;
    const existing = this.transactions.get(key);
    if (existing) {
      if (
        existing.flowId !== input.flowId ||
        existing.kind !== input.kind ||
        existing.attempt !== input.attempt
      ) {
        throw new AppError(
          "CONFLICT",
          "Transaction reference is already assigned",
          409,
        );
      }
      const flow = this.flows.get(input.flowId);
      if (!flow) throw new AppError("NOT_FOUND", "Flow not found", 404);
      return {
        flow: structuredClone(flow),
        transaction: structuredClone(existing),
      };
    }

    const current = this.flows.get(input.flowId);
    if (!current) throw new AppError("NOT_FOUND", "Flow not found", 404);
    if (current.version !== version) {
      throw new AppError(
        "CONFLICT",
        "Flow changed; reload before continuing",
        409,
        true,
      );
    }
    assertState(current.state, next);
    const duplicateAttempt = [...this.transactions.values()].some(
      (item) =>
        item.flowId === input.flowId &&
        item.kind === input.kind &&
        item.attempt === input.attempt,
    );
    if (duplicateAttempt) {
      throw new AppError(
        "CONFLICT",
        "Transaction attempt already has a reference",
        409,
      );
    }

    const now = new Date().toISOString();
    const flow = flowSchema.parse({
      ...current,
      state: next,
      updatedAt: now,
      version: current.version + 1,
    });
    const transaction = { id: randomUUID(), ...input };
    const event: FlowEvent = {
      id: randomUUID(),
      flowId: input.flowId,
      priorState: current.state,
      nextState: next,
      reference: `transaction:${transaction.id}`,
      createdAt: now,
    };
    this.flows.set(input.flowId, flow);
    this.transactions.set(key, transaction);
    this.events.set(input.flowId, [
      ...(this.events.get(input.flowId) ?? []),
      event,
    ]);
    await this.addJob(
      `verify:${input.chain}:${input.hash}`,
      "verify_transaction",
      { flowId: input.flowId, transactionId: transaction.id },
      now,
    );
    return {
      flow: structuredClone(flow),
      transaction: structuredClone(transaction),
    };
  }

  async getTransaction(id: string): Promise<TransactionRecord | null> {
    const item = [...this.transactions.values()].find(
      (transaction) => transaction.id === id,
    );
    return item ? structuredClone(item) : null;
  }

  async setTransactionStatus(
    id: string,
    status: TransactionRecord["status"],
    confirmedAt: string | null,
  ): Promise<TransactionRecord> {
    const item = [...this.transactions.values()].find(
      (transaction) => transaction.id === id,
    );
    if (!item) throw new AppError("NOT_FOUND", "Transaction not found", 404);
    item.status = status;
    item.confirmedAt = confirmedAt;
    return structuredClone(item);
  }

  async finishTransaction(
    id: string,
    status: "confirmed" | "failed",
    next: FlowState,
    version: number,
    reference: string,
    position?: Omit<PositionRecord, "id">,
  ): Promise<Flow> {
    const item = [...this.transactions.values()].find(
      (transaction) => transaction.id === id,
    );
    if (!item) throw new AppError("NOT_FOUND", "Transaction not found", 404);
    const current = this.flows.get(item.flowId);
    if (!current) throw new AppError("NOT_FOUND", "Flow not found", 404);
    if (current.version !== version) {
      throw new AppError(
        "CONFLICT",
        "Flow changed; reload before continuing",
        409,
        true,
      );
    }
    assertState(current.state, next);
    if (position) {
      const duplicate = [...this.positions.values()].find(
        (saved) =>
          saved.flowId === position.flowId ||
          saved.proofReference === position.proofReference,
      );
      if (duplicate)
        throw new AppError(
          "CONFLICT",
          "Position proof is already assigned",
          409,
        );
    }
    const now = new Date().toISOString();
    const flow = flowSchema.parse({
      ...current,
      state: next,
      updatedAt: now,
      version: current.version + 1,
    });
    item.status = status;
    item.confirmedAt = status === "confirmed" ? now : null;
    this.flows.set(flow.id, flow);
    this.events.set(flow.id, [
      ...(this.events.get(flow.id) ?? []),
      {
        id: randomUUID(),
        flowId: flow.id,
        priorState: current.state,
        nextState: next,
        reference,
        createdAt: now,
      },
    ]);
    if (position) {
      const saved = { id: randomUUID(), ...position };
      this.positions.set(saved.id, saved);
    }
    return structuredClone(flow);
  }

  async listTransactions(flowId: string): Promise<TransactionRecord[]> {
    return [...this.transactions.values()]
      .filter((transaction) => transaction.flowId === flowId)
      .map((transaction) => structuredClone(transaction));
  }

  async saveChallenge(
    input: Omit<WalletChallenge, "id" | "usedAt">,
  ): Promise<WalletChallenge> {
    const challenge: WalletChallenge = {
      id: randomUUID(),
      ...input,
      usedAt: null,
    };
    this.challenges.set(challenge.id, challenge);
    return structuredClone(challenge);
  }

  async useChallenge(
    flowId: string,
    chain: WalletChallenge["chain"],
    wallet: string,
    valueHash: string,
  ): Promise<boolean> {
    const challenge = [...this.challenges.values()].find(
      (item) =>
        item.flowId === flowId &&
        item.chain === chain &&
        item.wallet === wallet &&
        item.valueHash === valueHash &&
        item.usedAt === null &&
        Date.parse(item.expiresAt) > Date.now(),
    );
    if (!challenge) return false;
    challenge.usedAt = new Date().toISOString();
    return true;
  }

  async hasWalletProofs(flowId: string): Promise<boolean> {
    const flow = this.flows.get(flowId);
    if (!flow) return false;
    const valid = [...this.challenges.values()].filter(
      (item) => item.flowId === flowId && item.usedAt !== null,
    );
    return (
      valid.some(
        (item) =>
          item.chain === "base" &&
          item.wallet.toLowerCase() === flow.baseWallet.toLowerCase(),
      ) &&
      valid.some(
        (item) => item.chain === "ton" && item.wallet === flow.tonWallet,
      )
    );
  }

  async savePosition(
    input: Omit<PositionRecord, "id">,
  ): Promise<PositionRecord> {
    const current = [...this.positions.values()].find(
      (position) =>
        position.flowId === input.flowId ||
        position.proofReference === input.proofReference,
    );
    if (current) {
      if (
        current.flowId !== input.flowId ||
        current.proofReference !== input.proofReference ||
        current.wallet !== input.wallet ||
        current.poolId !== input.poolId ||
        current.lpUnits !== input.lpUnits
      ) {
        throw new AppError(
          "CONFLICT",
          "Position proof is already assigned",
          409,
        );
      }
      return structuredClone(current);
    }
    const position = { id: randomUUID(), ...input };
    this.positions.set(position.id, position);
    return structuredClone(position);
  }

  async listPositions(wallet?: string): Promise<PositionRecord[]> {
    return [...this.positions.values()]
      .filter((position) => !wallet || position.wallet === wallet)
      .map((position) => structuredClone(position));
  }

  async addJob(
    key: string,
    type: string,
    payload: unknown,
    runAt: string,
  ): Promise<void> {
    if ([...this.jobs.values()].some((job) => job.key === key)) return;
    const id = randomUUID();
    this.jobs.set(id, {
      id,
      key,
      type,
      payload: structuredClone(payload),
      runAt,
      attempts: 0,
    });
  }

  async claimJobs(worker: string, limit: number): Promise<JobRecord[]> {
    const now = Date.now();
    const due = [...this.jobs.values()]
      .filter((job) => !job.lockedBy && Date.parse(job.runAt) <= now)
      .sort((left, right) => Date.parse(left.runAt) - Date.parse(right.runAt))
      .slice(0, limit);
    for (const job of due) {
      job.lockedBy = worker;
      job.attempts += 1;
    }
    return due.map((job) =>
      structuredClone({
        id: job.id,
        key: job.key,
        type: job.type,
        payload: job.payload,
        runAt: job.runAt,
        attempts: job.attempts,
      }),
    );
  }

  async finishJob(id: string): Promise<void> {
    this.jobs.delete(id);
  }

  async failJob(id: string, error: string, nextRunAt: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    delete job.lockedBy;
    job.lastError = error.slice(0, 500);
    job.runAt = nextRunAt;
  }
}
