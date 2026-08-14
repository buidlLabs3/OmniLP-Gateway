import { randomUUID } from "node:crypto";

import {
  BASE_USDC,
  TON_USDT,
  type DepositPlan,
  type Flow,
  type Pool,
  type Quote,
} from "@omnilp/shared";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import type { Config } from "./config.js";
import { getImpact } from "./services/impact.js";
import { MemoryStore } from "./store/memory.js";

const rawTon = (id: number) => `0:${id.toString(16).padStart(64, "0")}`;
const pool: Pool = {
  id: "usdt-ston",
  address: rawTon(1),
  routerAddress: rawTon(2),
  token0: {
    address: TON_USDT,
    symbol: "USDT",
    name: "Tether USD",
    decimals: 6,
  },
  token1: { address: rawTon(3), symbol: "STON", name: "STON", decimals: 9 },
  entryMode: "single",
  enabled: true,
  disabledReason: null,
  tvlUsdUnits: "100000000000",
  volume24hUsdUnits: "1000000000",
  feePips: 3000,
  aprPips: null,
  checkedAt: new Date().toISOString(),
};

const config: Config = {
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: 3001,
  WEB_ORIGIN: "http://localhost:3000",
  DATABASE_URL: "postgres://test:test@127.0.0.1:5432/test",
  OMNISTON_WS_URL: "wss://example.test",
  STON_API_URL: "https://api.example.test",
  BASE_RPC_URL: "https://base.example.test",
  TON_RPC_URL: "https://ton.example.test",
  BASE_USDC,
  TON_USDT,
  MAX_SOURCE_UNITS: "1000000000",
  MIN_SOURCE_UNITS: "10000000",
  PLAN_CHANGE_PIPS: 10_000,
  APPROVED_POOLS: [pool.address],
  UPSTREAM_TIMEOUT_MS: 100,
  UPSTREAM_RETRIES: 0,
  READ_ONLY: true,
  DEMO_MODE: true,
  TELEGRAM_BOT_TOKEN: undefined,
  TELEGRAM_MAX_AGE_SECONDS: 900,
  SESSION_SECRET: "test-session-secret-that-is-long-enough",
  TON_DEPOSIT_GAS_UNITS: "300000000",
};

function quote(flow: Flow): Quote {
  return {
    id: "quote-1",
    flowId: flow.id,
    direction: "entry",
    resolverId: "resolver-1",
    inputUnits: flow.sourceUnits,
    outputUnits: "9900000",
    protocolFeeUnits: "10000",
    integratorFeeUnits: "0",
    sourceProtocolAddress: "0x1111111111111111111111111111111111111111",
    destinationProtocolAddress: rawTon(4),
    quotedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function plan(flow: Flow): DepositPlan {
  return {
    id: randomUUID(),
    flowId: flow.id,
    poolId: pool.id,
    mode: "single",
    inputUnits: flow.sourceUnits,
    token0Units: flow.sourceUnits,
    token1Units: "0",
    minLpUnits: "9000000",
    lpUnitsBefore: "0",
    gasUnits: "300000000",
    priceImpactPips: 1000,
    indicative: false,
    routerAddress: pool.routerAddress,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function setup() {
  const store = new MemoryStore();
  await store.savePools([pool]);
  const omni = {
    getQuote: async (flow: Flow) => ({
      quote: quote(flow),
      hash: "a".repeat(64),
    }),
  };
  const ston = {
    getPools: async () => [pool],
    getPlan: async (flow: Flow) => plan(flow),
  };
  const auth = {
    verifySession: () => undefined,
  };
  const telegram = {
    start: () => ({
      user: { id: "test", firstName: "Test" },
      demo: true,
      token: "test",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    verifySession: () => undefined,
  };
  const app = await buildApp({
    config,
    store,
    omni: omni as never,
    ston: ston as never,
    auth: auth as never,
    telegram: telegram as never,
  });
  apps.push(app);
  return { app, store };
}

async function setupWithConfig(value: Config) {
  const store = new MemoryStore();
  await store.savePools([pool]);
  const app = await buildApp({
    config: value,
    store,
    auth: { verifySession: () => undefined } as never,
    telegram: { verifySession: () => undefined } as never,
  });
  apps.push(app);
  return { app, store };
}

const flowBody = {
  type: "entry",
  poolId: pool.id,
  baseWallet: "0x2222222222222222222222222222222222222222",
  tonWallet: rawTon(5),
  sourceUnits: "10000000",
} as const;

describe("flow API", () => {
  it("binds flow creation to a valid Telegram launch session", async () => {
    const store = new MemoryStore();
    await store.savePools([pool]);
    const app = await buildApp({
      config,
      store,
      auth: { verifySession: () => undefined } as never,
    });
    apps.push(app);
    const blocked = await app.inject({
      method: "POST",
      url: "/v1/flows",
      headers: { "idempotency-key": "telegram-flow-0001" },
      payload: flowBody,
    });
    expect(blocked.statusCode).toBe(401);

    const launch = await app.inject({
      method: "POST",
      url: "/v1/telegram/session",
      payload: { initData: "", demo: true },
    });
    expect(launch.statusCode).toBe(200);
    const created = await app.inject({
      method: "POST",
      url: "/v1/flows",
      headers: {
        "idempotency-key": "telegram-flow-0002",
        "x-telegram-session": launch.json().token as string,
      },
      payload: flowBody,
    });
    expect(created.statusCode).toBe(200);
  });

  it("creates one flow for duplicate idempotent requests without exposing wallets", async () => {
    const { app, store } = await setup();
    const headers = { "idempotency-key": "flow-request-0001" };
    const first = await app.inject({
      method: "POST",
      url: "/v1/flows",
      headers,
      payload: flowBody,
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/flows",
      headers,
      payload: flowBody,
    });
    expect(first.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(first.body).not.toContain(flowBody.baseWallet);
    expect(first.body).not.toContain(flowBody.tonWallet);
    expect(await store.listFlows()).toHaveLength(1);
  });

  it("rejects idempotency reuse with different input and source amounts outside caps", async () => {
    const { app } = await setup();
    const headers = { "idempotency-key": "flow-request-0002" };
    await app.inject({
      method: "POST",
      url: "/v1/flows",
      headers,
      payload: flowBody,
    });
    const conflict = await app.inject({
      method: "POST",
      url: "/v1/flows",
      headers,
      payload: { ...flowBody, sourceUnits: "20000000" },
    });
    expect(conflict.statusCode).toBe(409);

    const capped = await app.inject({
      method: "POST",
      url: "/v1/flows",
      headers: { "idempotency-key": "flow-request-0003" },
      payload: { ...flowBody, sourceUnits: "1000000001" },
    });
    expect(capped.statusCode).toBe(400);
  });

  it("advances a valid quote atomically and rejects a stale state version", async () => {
    const { app } = await setup();
    const created = await app.inject({
      method: "POST",
      url: "/v1/flows",
      headers: { "idempotency-key": "flow-request-0004" },
      payload: flowBody,
    });
    const id = created.json().flow.id as string;
    const response = await app.inject({
      method: "POST",
      url: `/v1/flows/${id}/quote`,
      headers: {
        authorization: "Bearer test",
        "idempotency-key": "quote-request-0001",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().flow.state).toBe("quoted");
    const replay = await app.inject({
      method: "POST",
      url: `/v1/flows/${id}/quote`,
      headers: {
        authorization: "Bearer test",
        "idempotency-key": "quote-request-0001",
      },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(response.json());

    const removed = await app.inject({
      method: "POST",
      url: `/v1/flows/${id}/state`,
      payload: { state: "source_pending", reference: "source:1", version: 0 },
    });
    expect(removed.statusCode).toBe(404);
  });

  it("keeps value-moving routes disabled by the global kill switch", async () => {
    const { app } = await setup();
    const created = await app.inject({
      method: "POST",
      url: "/v1/flows",
      headers: { "idempotency-key": "flow-request-0005" },
      payload: flowBody,
    });
    const id = created.json().flow.id as string;
    const response = await app.inject({
      method: "POST",
      url: `/v1/flows/${id}/source`,
      payload: { hash: `0x${"1".repeat(64)}`, attempt: 1 },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("READ_ONLY");
  });

  it("keeps Omniston execution locked independently of the global switch", async () => {
    const { app, store } = await setupWithConfig({
      ...config,
      READ_ONLY: false,
    });
    const flow = await store.createFlow(flowBody);
    await store.setState(flow.id, "quoted", "quote:test", flow.version);
    const response = await app.inject({
      method: "POST",
      url: `/v1/flows/${flow.id}/source`,
      headers: { authorization: "Bearer test" },
      payload: {
        hash: `0x${"1".repeat(64)}`,
        attempt: 1,
        version: 1,
      },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("ROUTE_UNAVAILABLE");
  });
});

describe("impact", () => {
  it("counts only confirmed completed entry evidence", async () => {
    const { store } = await setup();
    const flow = await store.createFlow(flowBody);
    const quoted = await store.setState(flow.id, "quoted", "q", flow.version);
    const source = await store.setState(
      flow.id,
      "source_pending",
      "s",
      quoted.version,
    );
    const pending = await store.setState(
      source.id,
      "trade_pending",
      "t",
      source.version,
    );
    const filled = await store.setState(
      pending.id,
      "trade_filled",
      "f",
      pending.version,
    );
    const received = await store.setState(
      filled.id,
      "funds_received",
      "r",
      filled.version,
    );
    const ready = await store.setState(
      received.id,
      "deposit_ready",
      "p",
      received.version,
    );
    const deposit = await store.setState(
      ready.id,
      "deposit_pending",
      "d",
      ready.version,
    );
    const complete = await store.setState(
      deposit.id,
      "complete",
      "lp",
      deposit.version,
    );
    const transaction = await store.saveTransaction({
      flowId: flow.id,
      kind: "source",
      chain: "base",
      hash: `0x${"2".repeat(64)}`,
      status: "confirmed",
      attempt: 1,
      confirmedAt: new Date().toISOString(),
    });
    const position = await store.savePosition({
      flowId: flow.id,
      wallet: flowBody.tonWallet,
      poolId: pool.id,
      lpUnits: "9000000",
      entryValueUsdUnits: "10000000",
      proofReference: "ton:proof-1",
      openedAt: new Date().toISOString(),
      closedAt: null,
    });
    const impact = getImpact([complete], [transaction], [position]);
    expect(impact.routedUsdcUnits).toBe("10000000");
    expect(impact.depositedUsdUnits).toBe("10000000");
    expect(impact.completedEntries).toBe(1);
  });
});
