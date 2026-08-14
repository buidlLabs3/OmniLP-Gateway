import assert from "node:assert/strict";
import test from "node:test";

import {
  compareDecimal,
  request,
  selectPools,
  units,
  validateSimulation,
} from "./ston.mjs";

const usdt = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";
const ton = (id) => `0:${id.toString(16).padStart(64, "0")}`;
const routerV2 = ton(90);
const routerV1 = ton(91);

test("converts decimal USDT without floating point math", () => {
  assert.equal(units("10.25", 6), "10250000");
  assert.throws(() => units("0", 6), /greater than zero/);
  assert.throws(() => units("1.0000001", 6), /more than 6 decimal/);
});

test("selects the three largest allowed V2 USDT pools", () => {
  const pools = [
    pool(1, 11, "100"),
    pool(2, 12, "400"),
    pool(3, 13, "300"),
    pool(4, 14, "200"),
    pool(5, 15, "900", routerV1),
    pool(6, 16, "800"),
    pool(7, 12, "350"),
  ];
  const assets = new Map([
    ...[1, 2, 3, 4, 5].map((id) => [
      ton(id + 10),
      { blacklisted: false, deprecated: false },
    ]),
    [ton(16), { blacklisted: true, deprecated: false }],
  ]);
  const routers = new Map([
    [routerV2, { major_version: 2 }],
    [routerV1, { major_version: 1 }],
  ]);

  assert.deepEqual(
    selectPools(pools, assets, routers).map((item) => item.address),
    [ton(2), ton(3), ton(4)],
  );
});

test("sorts large decimal TVL values without floating point loss", () => {
  assert.equal(compareDecimal("9007199254740993", "9007199254740992"), 1);
  assert.equal(compareDecimal("1.20", "1.2"), 0);
  assert.equal(compareDecimal("0.09", "0.1"), -1);
});

test("validates simulation identity, router, amounts, and old LP state", () => {
  const selected = pool(1, 11, "100");
  const routers = new Map([[routerV2, { major_version: 2 }]]);
  const result = simulation(selected, "Arbitrary", "10000000", "0");
  assert.deepEqual(
    validateSimulation(result, selected, "Arbitrary", "10000000", routers),
    {
      pool: selected.address,
      provisionType: "Arbitrary",
      router: routerV2,
      routerChanged: false,
      tokenAUnits: "10000000",
      tokenBUnits: "0",
      minLpUnits: "999",
      priceImpact: "0.01",
      oldLpAccountBalance: { tokenA: "0", tokenB: "0" },
      safe: true,
    },
  );

  const wrongPool = { ...result, pool_address: ton(44) };
  assert.throws(
    () =>
      validateSimulation(wrongPool, selected, "Arbitrary", "10000000", routers),
    /different pool/,
  );

  const unsafe = { ...result, lp_account_token_a_balance: "1" };
  assert.equal(
    validateSimulation(unsafe, selected, "Arbitrary", "10000000", routers).safe,
    false,
  );

  const wrongRouter = {
    ...result,
    router: { address: ton(45), major_version: 2 },
  };
  assert.throws(
    () =>
      validateSimulation(
        wrongRouter,
        selected,
        "Arbitrary",
        "10000000",
        routers,
      ),
    /approved V2 router/,
  );

  const nextRouter = ton(46);
  routers.set(nextRouter, { major_version: 2 });
  const changedRouter = {
    ...result,
    router: { address: nextRouter, major_version: 2 },
  };
  assert.equal(
    validateSimulation(
      changedRouter,
      selected,
      "Arbitrary",
      "10000000",
      routers,
    ).routerChanged,
    true,
  );
});

test("retries transient reads but not rejected client requests", async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ error: "busy" }), { status: 503 });
    }
    return new Response(JSON.stringify({ asset_list: [] }), { status: 200 });
  };
  assert.deepEqual(
    await request("/v1/assets", {
      apiUrl: "https://api.example.test",
      fetchFn,
      retries: 1,
      timeoutMs: 100,
    }),
    { asset_list: [] },
  );
  assert.equal(calls, 2);

  calls = 0;
  await assert.rejects(
    request("/v1/assets", {
      apiUrl: "https://api.example.test",
      fetchFn: async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: "bad" }), { status: 400 });
      },
      retries: 2,
      timeoutMs: 100,
    }),
    /returned 400/,
  );
  assert.equal(calls, 1);
});

function pool(addressId, tokenId, value, router = routerV2) {
  return {
    address: ton(addressId),
    deprecated: false,
    token0_address: usdt,
    token1_address: ton(tokenId),
    router_address: router,
    lp_total_supply_usd: value,
  };
}

function simulation(selected, type, tokenAUnits, tokenBUnits) {
  return {
    pool_address: selected.address,
    token_a: usdt,
    token_b: selected.token1_address,
    token_a_units: tokenAUnits,
    token_b_units: tokenBUnits,
    provision_type: type,
    min_lp_units: "999",
    price_impact: "0.01",
    lp_account_token_a_balance: "0",
    lp_account_token_b_balance: "0",
    router: { address: routerV2, major_version: 2 },
  };
}
