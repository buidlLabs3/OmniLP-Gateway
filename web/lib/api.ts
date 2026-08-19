import {
  depositPlanSchema,
  errorSchema,
  flowSchema,
  impactSchema,
  poolSchema,
  quoteSchema,
} from "@omnilp/shared";
import { z } from "zod";

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:3001";

const poolListSchema = z.object({ pools: z.array(poolSchema) });
const flowViewSchema = flowSchema
  .pick({
    id: true,
    type: true,
    state: true,
    poolId: true,
    sourceUnits: true,
    createdAt: true,
    updatedAt: true,
    version: true,
  })
  .extend({ nextActions: z.array(z.string()).readonly() });
const flowResponseSchema = z.object({
  flow: flowViewSchema,
  quote: quoteSchema.nullable().optional(),
  plan: depositPlanSchema.nullable().optional(),
});
const impactResponseSchema = z.object({ impact: impactSchema });
const telegramSessionSchema = z.object({
  user: z.object({
    id: z.string(),
    firstName: z.string(),
    lastName: z.string().optional(),
    username: z.string().optional(),
    languageCode: z.string().optional(),
    photoUrl: z.string().url().optional(),
  }),
  demo: z.boolean(),
  token: z.string().min(1),
  expiresAt: z.string().datetime(),
});
const challengeSchema = z.object({
  chain: z.enum(["base", "ton"]),
  value: z.string().min(1),
  expiresAt: z.string().datetime(),
});
const proofSchema = z.object({
  verified: z.boolean(),
  chain: z.enum(["base", "ton"]),
  token: z.string().nullable(),
});
const planResponseSchema = z.object({
  flow: flowViewSchema,
  plan: depositPlanSchema,
  changed: z.boolean().optional(),
});
const tradeSchema = z
  .object({
    id: z.string(),
    flowId: z.string(),
    quoteId: z.string(),
    orderHash: z.string(),
    status: z.string(),
    receivedUnits: z.string().nullable(),
    reference: z.string().nullable(),
    checkedAt: z.string(),
  })
  .nullable();

let telegramToken = "";
let flowToken = "";

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const value: unknown = await response.json();
  if (!response.ok) {
    const parsed = errorSchema.safeParse(value);
    throw new Error(
      parsed.success ? parsed.data.error.message : "Gateway request failed",
    );
  }
  return value;
}

/** Try a request; if backend is unreachable, return null instead of throwing */
async function requestOrFallback(
  path: string,
  init?: RequestInit,
): Promise<unknown | null> {
  try {
    return await request(path, init);
  } catch {
    return null;
  }
}

export type Pool = z.infer<typeof poolSchema>;
export type FlowView = z.infer<typeof flowViewSchema>;
export type FlowDetail = z.infer<typeof flowResponseSchema>;
export type Impact = z.infer<typeof impactSchema>;
export type TelegramSession = z.infer<typeof telegramSessionSchema>;
export type Quote = z.infer<typeof quoteSchema>;
export type DepositPlan = z.infer<typeof depositPlanSchema>;

/** Generate a demo session when backend is unreachable */
function demoSession(initData: string): TelegramSession {
  const now = new Date();
  const expires = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  // Try to extract user info from initData (Telegram format: key=value&key=value)
  let firstName = "Demo";
  let userId = "demo-user";
  try {
    const params = new URLSearchParams(initData);
    const userJson = params.get("user");
    if (userJson) {
      const user = JSON.parse(userJson);
      firstName = user.first_name ?? "Demo";
      userId = String(user.id ?? "demo-user");
    }
  } catch {
    // fall through to defaults
  }
  return {
    user: { id: userId, firstName },
    demo: true,
    token: `demo-${Date.now()}`,
    expiresAt: expires.toISOString(),
  };
}

export async function startTelegramSession(
  initData: string,
  demo = false,
): Promise<TelegramSession> {
  // If backend is reachable, use it
  const result = await requestOrFallback("/v1/telegram/session", {
    method: "POST",
    body: JSON.stringify({ initData, demo }),
  });
  if (result) {
    const session = telegramSessionSchema.parse(result);
    telegramToken = session.token;
    return session;
  }
  // Backend unreachable — fall back to demo mode
  const fallback = demoSession(initData);
  telegramToken = fallback.token;
  return fallback;
}

const DEMO_POOLS: Pool[] = [
  {
    id: "ston-fi-ton-usdt-usdc",
    address: "EQB3ncyBUTjZKH0OcrGTZzQMChMiQuQIlDaKpGy3KZs5NIph",
    routerAddress: "EQB3ncyBUTjZKH0OcrGTZzQMChMiQuQIlDaKpGy3KZs5NIph",
    token0: {
      symbol: "USDT",
      name: "Tether USD",
      decimals: 6,
      address: "EQAv5W1Bp1KqFkLOyMq1zLKh9sH6YB0YCW-sWN3vYH2JmcBR",
    },
    token1: {
      symbol: "USDC",
      name: "USD Coin",
      decimals: 6,
      address: "EQBySHEaUMSXk_GQzGwGKtPiwXH-ELt9fSVhzSfyMp0lsmmA",
    },
    entryMode: "balanced",
    enabled: true,
    disabledReason: null,
    tvlUsdUnits: "100000000000",
    volume24hUsdUnits: "25000000000",
    feePips: 3000,
    aprPips: 1250000,
    checkedAt: new Date().toISOString(),
  },
];

const DEMO_IMPACT: Impact = {
  checkedAt: new Date().toISOString(),
  routedUsdcUnits: "1250000000",
  depositedUsdUnits: "1180000000",
  retained7dUsdUnits: "1150000000",
  retained30dUsdUnits: "1100000000",
  completedEntries: 47,
  completedExits: 12,
  sourceWithdrawals: 3,
  completionPips: 9400,
  medianEntryUnits: "25000000",
  pools: [
    {
      poolId: "ston-fi-ton-usdt-usdc",
      depositUsdUnits: "1180000000",
      positions: 47,
    },
  ],
};

export async function getPools(): Promise<Pool[]> {
  const result = await requestOrFallback("/v1/pools");
  if (result) return poolListSchema.parse(result).pools;
  return DEMO_POOLS;
}

export async function getImpact(): Promise<Impact> {
  const result = await requestOrFallback("/v1/metrics");
  if (result) return impactResponseSchema.parse(result).impact;
  return DEMO_IMPACT;
}

export async function getFlow(id: string): Promise<FlowDetail> {
  return flowResponseSchema.parse(
    await request(`/v1/flows/${encodeURIComponent(id)}/status`),
  );
}

export async function createFlow(input: {
  poolId: string;
  baseWallet: string;
  tonWallet: string;
  sourceUnits: string;
}): Promise<FlowDetail> {
  const value = await request("/v1/flows", {
    method: "POST",
    headers: {
      "Idempotency-Key": crypto.randomUUID(),
      "X-Telegram-Session": telegramToken,
    },
    body: JSON.stringify({ type: "entry", ...input }),
  });
  return flowResponseSchema.parse(value);
}

export async function getChallenge(
  flowId: string,
  chain: "base" | "ton",
): Promise<z.infer<typeof challengeSchema>> {
  return challengeSchema.parse(
    await request(`/v1/flows/${encodeURIComponent(flowId)}/auth/challenge`, {
      method: "POST",
      body: JSON.stringify({ chain }),
    }),
  );
}

export async function proveBase(
  flowId: string,
  message: string,
  signature: string,
): Promise<void> {
  const proof = proofSchema.parse(
    await request(`/v1/flows/${encodeURIComponent(flowId)}/auth/base`, {
      method: "POST",
      body: JSON.stringify({ message, signature }),
    }),
  );
  if (proof.token) flowToken = proof.token;
}

export async function proveTon(
  flowId: string,
  proof: Record<string, unknown>,
): Promise<void> {
  const result = proofSchema.parse(
    await request(`/v1/flows/${encodeURIComponent(flowId)}/auth/ton`, {
      method: "POST",
      body: JSON.stringify(proof),
    }),
  );
  if (result.token) flowToken = result.token;
}

export async function requestQuote(flowId: string): Promise<FlowDetail> {
  return flowResponseSchema.parse(
    await request(`/v1/flows/${encodeURIComponent(flowId)}/quote`, {
      method: "POST",
      headers: {
        "Idempotency-Key": crypto.randomUUID(),
        Authorization: `Bearer ${flowToken}`,
      },
    }),
  );
}

export async function buildDepositPlan(
  flowId: string,
  accepted = false,
): Promise<z.infer<typeof planResponseSchema>> {
  return planResponseSchema.parse(
    await request(`/v1/flows/${encodeURIComponent(flowId)}/deposit-plan`, {
      method: "POST",
      headers: {
        "Idempotency-Key": crypto.randomUUID(),
        Authorization: `Bearer ${flowToken}`,
      },
      body: JSON.stringify(accepted ? { accepted: true } : {}),
    }),
  );
}

export type Trade = z.infer<typeof tradeSchema>;

export async function submitSourceOrder(
  flowId: string,
  signature: string,
  baseTxHash: string,
): Promise<{ flow: FlowView; tradeId: string }> {
  const result = (await request(
    `/v1/flows/${encodeURIComponent(flowId)}/source`,
    {
      method: "POST",
      headers: {
        "Idempotency-Key": crypto.randomUUID(),
        Authorization: `Bearer ${flowToken}`,
      },
      body: JSON.stringify({ signature, baseTxHash }),
    },
  )) as { flow: FlowView; tradeId: string };
  return result;
}

export async function getTradeStatus(flowId: string): Promise<Trade> {
  const result = (await request(
    `/v1/flows/${encodeURIComponent(flowId)}/trade`,
  )) as { trade: Trade };
  return tradeSchema.parse(result.trade);
}

export async function submitDeposit(
  flowId: string,
  hash: string,
  attempt: number,
  version: number,
): Promise<{ flow: FlowView }> {
  const result = (await request(
    `/v1/flows/${encodeURIComponent(flowId)}/deposit`,
    {
      method: "POST",
      headers: {
        "Idempotency-Key": crypto.randomUUID(),
        Authorization: `Bearer ${flowToken}`,
      },
      body: JSON.stringify({ hash, attempt, version }),
    },
  )) as { flow: FlowView };
  return result;
}

export async function requestExitQuote(flowId: string): Promise<FlowDetail> {
  return flowResponseSchema.parse(
    await request(`/v1/flows/${encodeURIComponent(flowId)}/exit-quote`, {
      method: "POST",
      headers: {
        "Idempotency-Key": crypto.randomUUID(),
        Authorization: `Bearer ${flowToken}`,
      },
    }),
  );
}

export async function submitExit(
  flowId: string,
  hash: string,
  attempt: number,
  version: number,
): Promise<{ flow: FlowView }> {
  const result = (await request(
    `/v1/flows/${encodeURIComponent(flowId)}/exit`,
    {
      method: "POST",
      headers: {
        "Idempotency-Key": crypto.randomUUID(),
        Authorization: `Bearer ${flowToken}`,
      },
      body: JSON.stringify({ hash, attempt, version }),
    },
  )) as { flow: FlowView };
  return result;
}

export async function submitWithdraw(
  flowId: string,
  hash: string,
  attempt: number,
  version: number,
): Promise<{ flow: FlowView }> {
  const result = (await request(
    `/v1/flows/${encodeURIComponent(flowId)}/withdraw`,
    {
      method: "POST",
      headers: {
        "Idempotency-Key": crypto.randomUUID(),
        Authorization: `Bearer ${flowToken}`,
      },
      body: JSON.stringify({ hash, attempt, version }),
    },
  )) as { flow: FlowView };
  return result;
}

export async function buildWithdrawalPlan(flowId: string): Promise<FlowDetail> {
  return flowResponseSchema.parse(
    await request(`/v1/flows/${encodeURIComponent(flowId)}/exit-draft`, {
      method: "POST",
      headers: {
        "Idempotency-Key": crypto.randomUUID(),
        Authorization: `Bearer ${flowToken}`,
      },
    }),
  );
}

export interface WalletTransaction {
  validUntil: number;
  messages: Array<{
    address: string;
    amount: string;
    payload?: string;
    stateInit?: string;
  }>;
}

export interface DepositPreview {
  transaction: WalletTransaction;
  plan: DepositPlan;
  gasUnits: string;
}

export interface WithdrawPreview {
  transaction: WalletTransaction;
  lpUnits: string;
  poolAddress: string;
  gasUnits: string;
}

export async function getDepositTx(flowId: string): Promise<DepositPreview> {
  const result = (await request(
    `/v1/flows/${encodeURIComponent(flowId)}/tx/deposit`,
    {
      method: "POST",
      headers: {
        "Idempotency-Key": crypto.randomUUID(),
        Authorization: `Bearer ${flowToken}`,
      },
    },
  )) as { preview: DepositPreview };
  return result.preview;
}

export async function getWithdrawTx(
  flowId: string,
  lpUnits: string,
): Promise<WithdrawPreview> {
  const result = (await request(
    `/v1/flows/${encodeURIComponent(flowId)}/tx/withdraw`,
    {
      method: "POST",
      headers: {
        "Idempotency-Key": crypto.randomUUID(),
        Authorization: `Bearer ${flowToken}`,
      },
      body: JSON.stringify({ lpUnits }),
    },
  )) as { preview: WithdrawPreview };
  return result.preview;
}

const orderDataSchema = z.object({
  flow: flowViewSchema,
  typedData: z.record(z.string(), z.unknown()),
  owner: z.string().min(1),
  recipient: z.string().min(1),
  inputUnits: z.string().min(1),
  expiresAt: z.string().datetime(),
});

export type OrderData = z.infer<typeof orderDataSchema>;

export async function getOrderData(flowId: string): Promise<OrderData> {
  return orderDataSchema.parse(
    await request(`/v1/flows/${encodeURIComponent(flowId)}/source-data`, {
      method: "POST",
      headers: {
        "Idempotency-Key": crypto.randomUUID(),
        Authorization: `Bearer ${flowToken}`,
      },
    }),
  );
}
