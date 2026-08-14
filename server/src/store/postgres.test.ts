import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

const query = vi.fn(async (_text: string, _parameters?: unknown[]) => ({
  rows: [],
  rowCount: 1,
}));

vi.mock("pg", () => ({
  default: {
    Pool: class {
      query = query;
    },
  },
}));

import { PostgresStore } from "./postgres.js";

describe("postgres bindings", () => {
  it("binds every deposit-plan column exactly once", async () => {
    query.mockClear();
    const store = new PostgresStore("postgres://test:test@127.0.0.1/test");
    await store.savePlan({
      id: randomUUID(),
      flowId: randomUUID(),
      poolId: "usdt-ston",
      mode: "single",
      inputUnits: "10000000",
      token0Units: "10000000",
      token1Units: "0",
      minLpUnits: "9000000",
      lpUnitsBefore: "0",
      gasUnits: "300000000",
      priceImpactPips: 1000,
      indicative: false,
      routerAddress: `0:${"1".repeat(64)}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const parameters = query.mock.calls[0]?.[1];
    expect(parameters).toHaveLength(14);
    expect(parameters?.slice(5, 8)).toEqual(["10000000", "0", "9000000"]);
  });
});
