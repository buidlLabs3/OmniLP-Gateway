import type {
  CreateFlow,
  DepositPlan,
  Flow,
  FlowEvent,
  FlowState,
  Pool,
  Quote,
} from "@omnilp/shared";

export interface TransactionRecord {
  id: string;
  flowId: string;
  kind: "source" | "deposit" | "withdraw" | "exit";
  chain: "base" | "ton";
  hash: string;
  status: "pending" | "confirmed" | "failed";
  attempt: number;
  confirmedAt: string | null;
}

export interface PositionRecord {
  id: string;
  flowId: string;
  wallet: string;
  poolId: string;
  lpUnits: string;
  entryValueUsdUnits: string;
  proofReference: string;
  openedAt: string;
  closedAt: string | null;
}

export interface JobRecord {
  id: string;
  key: string;
  type: string;
  payload: unknown;
  runAt: string;
  attempts: number;
}

export interface IdempotencyRecord {
  hash: string;
  status: number;
  response: unknown;
}

export interface WalletChallenge {
  id: string;
  flowId: string;
  chain: "base" | "ton";
  wallet: string;
  valueHash: string;
  expiresAt: string;
  usedAt: string | null;
}

export interface TradeRecord {
  id: string;
  flowId: string;
  quoteId: string;
  orderHash: string;
  status:
    | "registered"
    | "matched"
    | "settling"
    | "filled"
    | "partial"
    | "failed"
    | "expired";
  receivedUnits: string | null;
  reference: string | null;
  checkedAt: string;
}

export interface Store {
  health(): Promise<boolean>;
  listPools(): Promise<Pool[]>;
  getPool(id: string): Promise<Pool | null>;
  savePools(pools: Pool[]): Promise<void>;
  saveQuote(quote: Quote, rawHash: string): Promise<Quote>;
  getQuote(flowId: string): Promise<Quote | null>;
  savePlan(plan: DepositPlan): Promise<DepositPlan>;
  getPlan(flowId: string): Promise<DepositPlan | null>;
  getReceivedUnits(flowId: string): Promise<string | null>;
  createFlow(input: CreateFlow): Promise<Flow>;
  listFlows(): Promise<Flow[]>;
  getFlow(id: string): Promise<Flow | null>;
  listEvents(flowId: string): Promise<FlowEvent[]>;
  setState(
    flowId: string,
    next: FlowState,
    reference: string,
    version: number,
  ): Promise<Flow>;
  getIdempotency(scope: string, key: string): Promise<IdempotencyRecord | null>;
  reserveIdempotency(
    scope: string,
    key: string,
    hash: string,
  ): Promise<IdempotencyRecord | null>;
  saveIdempotency(
    scope: string,
    key: string,
    hash: string,
    status: number,
    response: unknown,
  ): Promise<void>;
  clearIdempotency(scope: string, key: string, hash: string): Promise<void>;
  saveTransaction(
    input: Omit<TransactionRecord, "id">,
  ): Promise<TransactionRecord>;
  submitTransaction(
    input: Omit<TransactionRecord, "id">,
    next: FlowState,
    version: number,
  ): Promise<{ flow: Flow; transaction: TransactionRecord }>;
  getTransaction(id: string): Promise<TransactionRecord | null>;
  setTransactionStatus(
    id: string,
    status: TransactionRecord["status"],
    confirmedAt: string | null,
  ): Promise<TransactionRecord>;
  finishTransaction(
    id: string,
    status: "confirmed" | "failed",
    next: FlowState,
    version: number,
    reference: string,
    position?: Omit<PositionRecord, "id">,
  ): Promise<Flow>;
  saveTrade(input: Omit<TradeRecord, "id">): Promise<TradeRecord>;
  getTrade(flowId: string): Promise<TradeRecord | null>;
  updateTrade(
    id: string,
    update: Partial<
      Pick<TradeRecord, "status" | "receivedUnits" | "reference" | "checkedAt">
    >,
  ): Promise<TradeRecord>;
  saveChallenge(
    input: Omit<WalletChallenge, "id" | "usedAt">,
  ): Promise<WalletChallenge>;
  useChallenge(
    flowId: string,
    chain: WalletChallenge["chain"],
    wallet: string,
    valueHash: string,
  ): Promise<boolean>;
  hasWalletProofs(flowId: string): Promise<boolean>;
  listTransactions(flowId: string): Promise<TransactionRecord[]>;
  savePosition(input: Omit<PositionRecord, "id">): Promise<PositionRecord>;
  listPositions(wallet?: string): Promise<PositionRecord[]>;
  addJob(
    key: string,
    type: string,
    payload: unknown,
    runAt: string,
  ): Promise<void>;
  claimJobs(worker: string, limit: number): Promise<JobRecord[]>;
  finishJob(id: string): Promise<void>;
  failJob(id: string, error: string, nextRunAt: string): Promise<void>;
}
