import {
  errorSchema,
  flowSchema,
  impactSchema,
  poolSchema,
} from "@omnilp/shared";
import { z } from "zod";

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:3001";

const poolListSchema = z.object({ pools: z.array(poolSchema) });
const flowResponseSchema = z.object({
  flow: flowSchema
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
    .extend({ nextActions: z.array(z.string()).readonly() }),
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

let telegramToken = "";

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
export type FlowView = z.infer<typeof flowResponseSchema>["flow"];
export type Impact = z.infer<typeof impactSchema>;
export type TelegramSession = z.infer<typeof telegramSessionSchema>;

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

export async function getFlow(id: string): Promise<FlowView> {
  return flowResponseSchema.parse(
    await request(`/v1/flows/${encodeURIComponent(id)}/status`),
  ).flow;
}

export async function createFlow(input: {
  poolId: string;
  baseWallet: string;
  tonWallet: string;
  sourceUnits: string;
}): Promise<FlowView> {
  const value = await request("/v1/flows", {
    method: "POST",
    headers: {
      "Idempotency-Key": crypto.randomUUID(),
      "X-Telegram-Session": telegramToken,
    },
    body: JSON.stringify({ type: "entry", ...input }),
  });
  return flowResponseSchema.parse(value).flow;
}
