import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { TON_USDT, validTonWallet } from "./route.mjs";

const apiUrl = process.env.STON_API_URL ?? "https://api.ston.fi";
const wallet = process.env.TON_WALLET;
const amount = process.env.USDT_AMOUNT ?? "10";
const timeoutMs = Number(process.env.STON_TIMEOUT_MS ?? "15000");
const retryCount = Number(process.env.STON_RETRIES ?? "2");
const MAX_BODY_BYTES = 64_000_000;
const usdt = TON_USDT;

function units(value, decimals) {
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new Error(`Invalid USDT_AMOUNT: ${value}`);
  }

  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) {
    throw new Error(`USDT_AMOUNT has more than ${decimals} decimal places`);
  }

  const result = `${whole}${fraction.padEnd(decimals, "0")}`.replace(
    /^0+(?=\d)/,
    "",
  );
  if (BigInt(result) === 0n) {
    throw new Error("USDT_AMOUNT must be greater than zero");
  }

  return result;
}

function integer(value, name, allowZero = true) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error(`${name} must be an unsigned integer string`);
  }
  const result = BigInt(value);
  if (!allowZero && result === 0n) throw new Error(`${name} must be positive`);
  return result;
}

function apiBase(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("STON_API_URL is invalid");
  }
  if (url.protocol !== "https:") throw new Error("STON_API_URL must use HTTPS");
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "STON_API_URL must not contain credentials, query, or fragment",
    );
  }
  return url;
}

function requestSettings(wait = timeoutMs, retries = retryCount) {
  if (!Number.isSafeInteger(wait) || wait < 1 || wait > 120_000) {
    throw new Error("STON_TIMEOUT_MS must be an integer from 1 to 120000");
  }
  if (!Number.isSafeInteger(retries) || retries < 0 || retries > 5) {
    throw new Error("STON_RETRIES must be an integer from 0 to 5");
  }
  return { wait, retries };
}

async function readBody(response) {
  const length = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    throw new Error("STON.fi response is too large");
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) {
    throw new Error("STON.fi response is too large");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("STON.fi returned invalid JSON");
  }
}

async function request(path, options = {}) {
  const base = apiBase(options.apiUrl ?? apiUrl);
  const url = new URL(path, base);
  if (url.origin !== base.origin || !url.pathname.startsWith("/v1/")) {
    throw new Error("STON.fi request path is outside the V1 API");
  }
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const { wait, retries } = requestSettings(options.timeoutMs, options.retries);
  const fetchFn = options.fetchFn ?? fetch;
  const method = options.method ?? "GET";
  if (!["GET", "POST"].includes(method))
    throw new Error("STON.fi request method is invalid");
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchFn(url, {
        method,
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(wait),
      });
      let body;
      try {
        body = await readBody(response);
      } catch (error) {
        if (response.ok) {
          error.retryable = false;
          throw error;
        }
        body = { error: response.statusText || "invalid response" };
      }
      if (response.ok) {
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          throw new Error("STON.fi response must be an object");
        }
        return body;
      }

      const detail = JSON.stringify(body).slice(0, 1_000);
      const error = new Error(`STON.fi returned ${response.status}: ${detail}`);
      if (![408, 429].includes(response.status) && response.status < 500) {
        error.retryable = false;
        throw error;
      }
      lastError = error;
    } catch (error) {
      if (error?.retryable === false) throw error;
      lastError = error;
      if (attempt === retries) break;
    }

    await delay(250 * 2 ** attempt);
  }

  throw lastError;
}

function get(path, options) {
  return request(path, options);
}

function post(path, query, options = {}) {
  return request(path, { ...options, method: "POST", query });
}

function poolValue(pool) {
  const value = pool.lp_total_supply_usd;
  return typeof value === "string" && /^\d+(\.\d+)?$/.test(value) ? value : "0";
}

function compareDecimal(left, right) {
  const [leftWhole, leftFraction = ""] = left.split(".");
  const [rightWhole, rightFraction = ""] = right.split(".");
  const a = leftWhole.replace(/^0+(?=\d)/, "");
  const b = rightWhole.replace(/^0+(?=\d)/, "");
  if (a.length !== b.length) return a.length > b.length ? 1 : -1;
  if (a !== b) return a > b ? 1 : -1;
  const width = Math.max(leftFraction.length, rightFraction.length);
  const af = leftFraction.padEnd(width, "0");
  const bf = rightFraction.padEnd(width, "0");
  return af === bf ? 0 : af > bf ? 1 : -1;
}

function poolAssets(pool) {
  return [pool.token0_address, pool.token1_address];
}

function otherAsset(pool) {
  const address = poolAssets(pool).find((asset) => asset !== usdt);
  if (!address)
    throw new Error(`Pool ${pool.address} has no asset beside USDT`);
  return address;
}

function selectPools(pools, assets, routers) {
  if (
    !Array.isArray(pools) ||
    !(assets instanceof Map) ||
    !(routers instanceof Map)
  ) {
    throw new Error("Pool catalog data has an invalid shape");
  }
  const candidates = pools
    .filter(
      (pool) =>
        pool &&
        typeof pool === "object" &&
        pool.deprecated === false &&
        validTonWallet(pool.address) &&
        validTonWallet(pool.router_address) &&
        poolAssets(pool).length === 2 &&
        poolAssets(pool).every(validTonWallet) &&
        new Set(poolAssets(pool)).size === 2 &&
        poolAssets(pool).includes(usdt),
    )
    .filter((pool) => {
      const asset = assets.get(otherAsset(pool));
      return asset && asset.blacklisted === false && asset.deprecated === false;
    })
    .filter((pool) => {
      const version = routers.get(pool.router_address)?.major_version;
      return Number.isInteger(version) && version >= 2;
    })
    .sort((left, right) => compareDecimal(poolValue(right), poolValue(left)));
  const selected = [];
  const seenAssets = new Set();

  for (const pool of candidates) {
    const asset = otherAsset(pool);
    if (seenAssets.has(asset)) continue;
    seenAssets.add(asset);
    selected.push(pool);
    if (selected.length === 3) break;
  }

  return selected;
}

function poolSummary(pool, assets, routers) {
  const router = routers.get(pool.router_address);
  const pair = poolAssets(pool).map((address) => ({
    address,
    symbol: assets.get(address)?.symbol ?? "unknown",
  }));

  return {
    address: pool.address,
    pair,
    router: router
      ? {
          address: router.address,
          version: `${router.major_version}.${router.minor_version}`,
          type: router.router_type,
        }
      : null,
    tvlUsd: pool.lp_total_supply_usd,
    volume24hUsd: pool.volume_24h_usd,
    deprecated: pool.deprecated,
  };
}

function simulationField(value, snake, camel) {
  return value?.[snake] ?? value?.[camel];
}

function validateSimulation(result, pool, provisionType, usdtUnits, routers) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Liquidity simulation must be an object");
  }
  const poolAddress = simulationField(result, "pool_address", "poolAddress");
  const tokenA = simulationField(result, "token_a", "tokenA");
  const tokenB = simulationField(result, "token_b", "tokenB");
  const tokenAUnits = simulationField(result, "token_a_units", "tokenAUnits");
  const tokenBUnits = simulationField(result, "token_b_units", "tokenBUnits");
  const type = simulationField(result, "provision_type", "provisionType");
  const minLpUnits = simulationField(result, "min_lp_units", "minLpUnits");
  const oldAValue = simulationField(
    result,
    "lp_account_token_a_balance",
    "lpAccountTokenABalance",
  );
  const oldBValue = simulationField(
    result,
    "lp_account_token_b_balance",
    "lpAccountTokenBBalance",
  );
  const router = result.router;

  if (poolAddress !== pool.address)
    throw new Error("Simulation returned a different pool");
  if (tokenA !== usdt || tokenB !== otherAsset(pool)) {
    throw new Error("Simulation returned a different token pair");
  }
  if (!["Arbitrary", "Balanced"].includes(provisionType)) {
    throw new Error("Unsupported provision type");
  }
  if (type !== provisionType)
    throw new Error("Simulation returned a different provision type");
  if (
    integer(tokenAUnits, "simulation token_a_units", false).toString() !==
    usdtUnits
  ) {
    throw new Error("Simulation changed the requested USDT amount");
  }
  const tokenBAmount = integer(tokenBUnits, "simulation token_b_units");
  if (provisionType === "Arbitrary" && tokenBAmount !== 0n) {
    throw new Error("Single-sided simulation added an unexpected second input");
  }
  if (provisionType === "Balanced" && tokenBAmount === 0n) {
    throw new Error("Balanced simulation returned zero second input");
  }
  integer(minLpUnits, "simulation min_lp_units", false);
  const oldA = integer(oldAValue, "LP account token A balance");
  const oldB = integer(oldBValue, "LP account token B balance");

  if (
    !router ||
    typeof router !== "object" ||
    !validTonWallet(router.address)
  ) {
    throw new Error("Simulation router is missing or invalid");
  }
  const listedRouter = routers.get(router.address);
  if (
    !listedRouter ||
    !Number.isInteger(listedRouter.major_version) ||
    listedRouter.major_version < 2
  ) {
    throw new Error("Simulation router is not an approved V2 router");
  }

  return {
    pool: pool.address,
    provisionType,
    router: router.address,
    routerChanged: router.address !== pool.router_address,
    tokenAUnits,
    tokenBUnits,
    minLpUnits,
    priceImpact: simulationField(result, "price_impact", "priceImpact") ?? null,
    oldLpAccountBalance: { tokenA: oldA.toString(), tokenB: oldB.toString() },
    safe: oldA === 0n && oldB === 0n,
  };
}

async function simulate(pool, usdtUnits, routers) {
  const tokenB = otherAsset(pool);
  const common = {
    token_a: usdt,
    token_b: tokenB,
    pool_address: pool.address,
    token_a_units: usdtUnits,
    slippage_tolerance: "0.01",
    wallet_address: wallet,
  };

  const single = await post("/v1/liquidity_provision/simulate", {
    ...common,
    token_b_units: "0",
    provision_type: "Arbitrary",
  });
  const balanced = await post("/v1/liquidity_provision/simulate", {
    ...common,
    provision_type: "Balanced",
  });
  const singleResult = validateSimulation(
    single,
    pool,
    "Arbitrary",
    usdtUnits,
    routers,
  );
  const balancedResult = validateSimulation(
    balanced,
    pool,
    "Balanced",
    usdtUnits,
    routers,
  );

  return {
    pool: pool.address,
    single: singleResult,
    balanced: balancedResult,
    safe: singleResult.safe && balancedResult.safe,
  };
}

async function main() {
  const [assetData, poolData, routerData] = await Promise.all([
    get("/v1/assets"),
    get("/v1/pools?dex_v2=true"),
    get("/v1/routers?dex_v2=true"),
  ]);

  if (
    !Array.isArray(assetData.asset_list) ||
    !Array.isArray(poolData.pool_list) ||
    !Array.isArray(routerData.router_list)
  ) {
    throw new Error("STON.fi catalog response is incomplete");
  }
  const assets = new Map(
    assetData.asset_list.map((asset) => [asset.contract_address, asset]),
  );
  const routers = new Map(
    routerData.router_list.map((router) => [router.address, router]),
  );
  const usdtAsset = assets.get(usdt);
  if (
    !usdtAsset ||
    usdtAsset.blacklisted !== false ||
    usdtAsset.deprecated !== false ||
    !["USDT", "USD₮"].includes(usdtAsset.symbol) ||
    usdtAsset.decimals !== 6
  ) {
    throw new Error("Canonical TON USDT metadata is missing or unsafe");
  }
  const pools = selectPools(poolData.pool_list, assets, routers);

  if (pools.length < 3) {
    throw new Error(`Expected 3 active V2 USDT pools, found ${pools.length}`);
  }

  const output = {
    checkedAt: new Date().toISOString(),
    apiUrl,
    usdt: {
      address: usdt,
      symbol: assets.get(usdt)?.symbol ?? "unknown",
      decimals: assets.get(usdt)?.decimals ?? null,
      tags: assets.get(usdt)?.tags ?? null,
    },
    pools: pools.map((pool) => poolSummary(pool, assets, routers)),
    simulations: [],
  };

  if (!wallet) {
    output.blocked =
      "Set TON_WALLET to check old LP balances and run simulations";
    console.log(JSON.stringify(output, null, 2));
    process.exitCode = 2;
    return;
  }
  if (!validTonWallet(wallet)) throw new Error("TON_WALLET is invalid");

  const decimals = usdtAsset.decimals;

  const usdtUnits = units(amount, decimals);
  output.simulations = await Promise.all(
    pools.map((pool) => simulate(pool, usdtUnits, routers)),
  );
  output.safe = output.simulations.every((result) => result.safe);
  console.log(JSON.stringify(output, null, 2));
  if (!output.safe) process.exitCode = 3;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const cause = error instanceof Error ? error.cause : null;
    console.error(
      JSON.stringify(
        {
          checkedAt: new Date().toISOString(),
          apiUrl,
          error: error instanceof Error ? error.message : String(error),
          cause:
            cause && typeof cause === "object"
              ? {
                  code: cause.code,
                  host: cause.hostname,
                  message: cause.message,
                }
              : undefined,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  });
}

export { compareDecimal, request, selectPools, units, validateSimulation };
