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
const tradeSchema = z.object({
  id: z.string(),
  flowId: z.string(),
  quoteId: z.string(),
  orderHash: z.string(),
  status: z.string(),
  receivedUnits: z.string().nullable(),
  reference: z.string().nullable(),
  checkedAt: z.string(),
}).nullable();

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

export type Pool = z.infer<typeof poolSchema>;
export type FlowView = z.infer<typeof flowViewSchema>;
export type FlowDetail = z.infer<typeof flowResponseSchema>;
export type Impact = z.infer<typeof impactSchema>;
export type TelegramSession = z.infer<typeof telegramSessionSchema>;
export type Quote = z.infer<typeof quoteSchema>;
export type DepositPlan = z.infer<typeof depositPlanSchema>;

export async function startTelegramSession(
  initData: string,
  demo = false,
): Promise<TelegramSession> {
  const session = telegramSessionSchema.parse(
    await request("/v1/telegram/session", {
      method: "POST",
      body: JSON.stringify({ initData, demo }),
    }),
  );
  telegramToken = session.token;
  return session;
}

export async function getPools(): Promise<Pool[]> {
  return poolListSchema.parse(await request("/v1/pools")).pools;
}

export async function getImpact(): Promise<Impact> {
  return impactResponseSchema.parse(await request("/v1/metrics")).impact;
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
  const result = await request(
    `/v1/flows/${encodeURIComponent(flowId)}/source`,
    {
      method: "POST",
      headers: {
        "Idempotency-Key": crypto.randomUUID(),
        Authorization: `Bearer ${flowToken}`,
      },
      body: JSON.stringify({ signature, baseTxHash }),
    },
  ) as { flow: FlowView; tradeId: string };
  return result;
}

export async function getTradeStatus(
  flowId: string,
): Promise<Trade> {
  const result = await request(
    `/v1/flows/${encodeURIComponent(flowId)}/trade`,
  ) as { trade: Trade };
  return tradeSchema.parse(result.trade);
}

export async function submitDeposit(
  flowId: string,
  hash: string,
  attempt: number,
  version: number,
): Promise<{ flow: FlowView }> {
  const result = await request(
    `/v1/flows/${encodeURIComponent(flowId)}/deposit`,
    {
      method: "POST",
      headers: {
        "Idempotency-Key": crypto.randomUUID(),
        Authorization: `Bearer ${flowToken}`,
      },
      body: JSON.stringify({ hash, attempt, version }),
    },
  ) as { flow: FlowView };
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
  const result = await request(
    `/v1/flows/${encodeURIComponent(flowId)}/exit`,
    {
      method: "POST",
      headers: {
        "Idempotency-Key": crypto.randomUUID(),
        Authorization: `Bearer ${flowToken}`,
      },
      body: JSON.stringify({ hash, attempt, version }),
    },
  ) as { flow: FlowView };
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
