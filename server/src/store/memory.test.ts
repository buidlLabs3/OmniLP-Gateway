import { randomUUID } from "node:crypto";

import { BASE_USDC, TON_USDT, type Quote } from "@omnilp/shared";
import { describe, expect, it } from "vitest";

import { MemoryStore } from "./memory.js";

describe("memory store jobs", () => {
  it("allows only one worker to claim a due job", async () => {
    const store = new MemoryStore();
    await store.addJob(
      "verify:one",
      "verify",
      { id: 1 },
      new Date().toISOString(),
    );
    const [first, second] = await Promise.all([
      store.claimJobs("worker-a", 1),
      store.claimJobs("worker-b", 1),
    ]);
    expect(first.length + second.length).toBe(1);
  });
});

describe("memory store quotes", () => {
  it("rejects a provider quote ID reused with different data", async () => {
    const store = new MemoryStore();
    const quote: Quote = {
      id: "quote-1",
      flowId: randomUUID(),
      direction: "entry",
      resolverId: "resolver-1",
      inputUnits: "10000000",
      outputUnits: "9900000",
      protocolFeeUnits: "100000",
      integratorFeeUnits: "0",
      sourceProtocolAddress: BASE_USDC,
      destinationProtocolAddress: TON_USDT,
      quotedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await store.saveQuote(quote, "a".repeat(64));
    await expect(store.saveQuote(quote, "b".repeat(64))).rejects.toMatchObject({
      code: "QUOTE_INVALID",
    });
  });
});
