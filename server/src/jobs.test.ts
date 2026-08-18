import { randomUUID } from "node:crypto";

import {
  BASE_USDC,
  TON_USDT,
  type Flow,
  type Pool,
  type Quote,
} from "@omnilp/shared";
import { describe, expect, it } from "vitest";

import { getFailedState, Jobs } from "./jobs.js";
import { MemoryStore } from "./store/memory.js";

const rawTon = (id: number) => `0:${id.toString(16).padStart(64, "0")}`;

const config = {
  NODE_ENV: "test" as const,
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
  APPROVED_POOLS: [rawTon(1)],
  UPSTREAM_TIMEOUT_MS: 100,
  UPSTREAM_RETRIES: 0,
  READ_ONLY: true,
  DEMO_MODE: true,
  TELEGRAM_BOT_TOKEN: undefined,
  TELEGRAM_APP_URL: undefined,
  TELEGRAM_MAX_AGE_SECONDS: 900,
  SESSION_SECRET: "test-session-secret-that-is-long-enough",
  TON_DEPOSIT_GAS_UNITS: "300000000",
};

const pool: Pool = {
  id: "usdt-ston",
  address: rawTon(1),
  routerAddress: rawTon(2),
  token0: { address: TON_USDT, symbol: "USDT", name: "Tether USD", decimals: 6 },
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

const flowBody = {
  type: "entry" as const,
  poolId: pool.id,
  baseWallet: "0x2222222222222222222222222222222222222222",
  tonWallet: rawTon(5),
  sourceUnits: "10000000",
};

describe("verification failures", () => {
  it("keeps each transaction kind in its own recovery state", () => {
    expect(getFailedState("source")).toBe("source_rejected");
    expect(getFailedState("deposit")).toBe("deposit_failed");
    expect(getFailedState("withdraw")).toBe("withdraw_failed");
    expect(getFailedState("exit")).toBe("exit_failed");
  });
});

describe("trade tracking", () => {
  it("transitions trade_pending to trade_filled on filled status", async () => {
    const store = new MemoryStore();
    await store.savePools([pool]);
    const flow = await store.createFlow(flowBody);
    const quoted = await store.setState(flow.id, "quoted", "q", flow.version);
    const pending = await store.setState(quoted.id, "source_pending", "s", quoted.version);
    const tradePending = await store.setState(pending.id, "trade_pending", "t", pending.version);
    const q: Quote = {
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
    await store.saveQuote(q, "a".repeat(64));
    await store.saveTrade({
      flowId: flow.id,
      quoteId: "quote-1",
      orderHash: "trade-test-001",
      status: "registered",
      receivedUnits: null,
      reference: null,
      checkedAt: new Date().toISOString(),
    });
    await store.addJob(`track-trade:${flow.id}`, "track_trade", { flowId: flow.id, tradeId: "trade-test-001" }, new Date().toISOString());
    const omni = {
      trackTrade: async () => ({ status: "FULLY_FILLED", receivedUnits: "9900000" }),
    };
    const ston = { verifyLiquidityAction: async () => "confirmed" as const, getPosition: async () => "0" };
    const jobs = new Jobs(config, store, ston as never, omni as never);
    const count = await jobs.run("test-worker");
    expect(count).toBe(1);
    const updated = await store.getFlow(flow.id);
    expect(updated?.state).toBe("funds_received");
    const trade = await store.getTrade(flow.id);
    expect(trade?.status).toBe("filled");
    expect(trade?.receivedUnits).toBe("9900000");
  });

  it("transitions trade_pending to trade_failed on failed status", async () => {
    const store = new MemoryStore();
    await store.savePools([pool]);
    const flow = await store.createFlow(flowBody);
    const quoted = await store.setState(flow.id, "quoted", "q", flow.version);
    const pending = await store.setState(quoted.id, "source_pending", "s", quoted.version);
    await store.setState(pending.id, "trade_pending", "t", pending.version);
    const q: Quote = {
      id: "quote-1", flowId: flow.id, direction: "entry", resolverId: "r",
      inputUnits: flow.sourceUnits, outputUnits: "9900000",
      protocolFeeUnits: "10000", integratorFeeUnits: "0",
      sourceProtocolAddress: "0x1111111111111111111111111111111111111111",
      destinationProtocolAddress: rawTon(4),
      quotedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await store.saveQuote(q, "a".repeat(64));
    await store.saveTrade({
      flowId: flow.id, quoteId: "quote-1", orderHash: "trade-001",
      status: "registered", receivedUnits: null, reference: null,
      checkedAt: new Date().toISOString(),
    });
    await store.addJob(`track-trade:${flow.id}`, "track_trade", { flowId: flow.id, tradeId: "trade-001" }, new Date().toISOString());
    const omni = {
      trackTrade: async () => ({ status: "CANCELLED", receivedUnits: null }),
    };
    const ston = { verifyLiquidityAction: async () => "confirmed" as const, getPosition: async () => "0" };
    const jobs = new Jobs(config, store, ston as never, omni as never);
    await jobs.run("test-worker");
    const updated = await store.getFlow(flow.id);
    expect(updated?.state).toBe("trade_failed");
  });

  it("skips trade tracking for terminal trade states", async () => {
    const store = new MemoryStore();
    await store.savePools([pool]);
    const flow = await store.createFlow(flowBody);
    const quoted = await store.setState(flow.id, "quoted", "q", flow.version);
    const pending = await store.setState(quoted.id, "source_pending", "s", quoted.version);
    await store.setState(pending.id, "trade_pending", "t", pending.version);
    const q: Quote = {
      id: "quote-1", flowId: flow.id, direction: "entry", resolverId: "r",
      inputUnits: flow.sourceUnits, outputUnits: "9900000",
      protocolFeeUnits: "10000", integratorFeeUnits: "0",
      sourceProtocolAddress: "0x1111111111111111111111111111111111111111",
      destinationProtocolAddress: rawTon(4),
      quotedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await store.saveQuote(q, "a".repeat(64));
    await store.saveTrade({
      flowId: flow.id, quoteId: "quote-1", orderHash: "trade-001",
      status: "filled", receivedUnits: "9900000", reference: null,
      checkedAt: new Date().toISOString(),
    });
    await store.addJob(`track-trade:${flow.id}`, "track_trade", { flowId: flow.id, tradeId: "trade-001" }, new Date().toISOString());
    const omni = {
      trackTrade: async () => { throw new Error("should not be called"); },
    };
    const ston = { verifyLiquidityAction: async () => "confirmed" as const, getPosition: async () => "0" };
    const jobs = new Jobs(config, store, ston as never, omni as never);
    const count = await jobs.run("test-worker");
    expect(count).toBe(1);
    const flowAfter = await store.getFlow(flow.id);
    expect(flowAfter?.state).toBe("trade_pending");
  });
});

describe("quote expiry", () => {
  it("expires a quoted flow when quote deadline passes", async () => {
    const store = new MemoryStore();
    await store.savePools([pool]);
    const flow = await store.createFlow(flowBody);
    await store.setState(flow.id, "quoted", "q", flow.version);
    const q: Quote = {
      id: "quote-1", flowId: flow.id, direction: "entry", resolverId: "r",
      inputUnits: flow.sourceUnits, outputUnits: "9900000",
      protocolFeeUnits: "10000", integratorFeeUnits: "0",
      sourceProtocolAddress: "0x1111111111111111111111111111111111111111",
      destinationProtocolAddress: rawTon(4),
      quotedAt: new Date(Date.now() - 120_000).toISOString(),
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    };
    await store.saveQuote(q, "a".repeat(64));
    await store.addJob(`quote-expiry:${flow.id}`, "quote_expiry", { flowId: flow.id }, new Date().toISOString());
    const jobs = new Jobs(config, store);
    await jobs.run("test-worker");
    const updated = await store.getFlow(flow.id);
    expect(updated?.state).toBe("quote_expired");
  });

  it("does not expire a quote that is still valid", async () => {
    const store = new MemoryStore();
    await store.savePools([pool]);
    const flow = await store.createFlow(flowBody);
    await store.setState(flow.id, "quoted", "q", flow.version);
    const q: Quote = {
      id: "quote-1", flowId: flow.id, direction: "entry", resolverId: "r",
      inputUnits: flow.sourceUnits, outputUnits: "9900000",
      protocolFeeUnits: "10000", integratorFeeUnits: "0",
      sourceProtocolAddress: "0x1111111111111111111111111111111111111111",
      destinationProtocolAddress: rawTon(4),
      quotedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await store.saveQuote(q, "a".repeat(64));
    await store.addJob(`quote-expiry:${flow.id}`, "quote_expiry", { flowId: flow.id }, new Date().toISOString());
    const jobs = new Jobs(config, store);
    await jobs.run("test-worker");
    const updated = await store.getFlow(flow.id);
    expect(updated?.state).toBe("quoted");
  });
});
