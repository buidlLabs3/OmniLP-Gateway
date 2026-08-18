import {
  AppError,
  TON_USDT,
  poolSchema,
  sameTonAddress,
  tonAddressKey,
  type DepositPlan,
  type Flow,
  type Pool,
} from "@omnilp/shared";
import { z } from "zod";

import type { Config } from "../config.js";
import { readJson } from "./http.js";

const assetResponseSchema = z.object({
  asset_list: z.array(
    z.object({
      contract_address: z.string(),
      symbol: z.string(),
      display_name: z.string().nullable().optional(),
      decimals: z.number().int(),
      blacklisted: z.boolean(),
      deprecated: z.boolean(),
    }),
  ),
});

const poolResponseSchema = z.object({
  pool_list: z.array(
    z.object({
      address: z.string(),
      router_address: z.string(),
      token0_address: z.string(),
      token1_address: z.string(),
      lp_total_supply_usd: z.string().nullable(),
      volume_24h_usd: z.string().nullable().default(null), // live API omits the key on most pools
      deprecated: z.boolean(),
      lp_fee: z.string().optional(),
    }),
  ),
});

const routerResponseSchema = z.object({
  router_list: z.array(
    z.object({
      address: z.string(),
      major_version: z.number().int(),
    }),
  ),
});

const simulationSchema = z.object({
  pool_address: z.string(),
  token_a: z.string(),
  token_b: z.string(),
  token_a_units: z.string().regex(/^\d+$/),
  token_b_units: z.string().regex(/^\d+$/),
  min_lp_units: z.string().regex(/^\d+$/),
  router_address: z.string(),
  provision_type: z.enum(["Balanced", "Arbitrary"]),
  price_impact: z.string().optional(),
  lp_account_token_a_balance: z.string().regex(/^\d+$/),
  lp_account_token_b_balance: z.string().regex(/^\d+$/),
  router: z.object({ address: z.string(), major_version: z.number().int() }),
});

const positionSchema = z.object({
  pool: z.object({
    address: z.string(),
    lp_balance: z.string().regex(/^\d+$/).nullable().default(null),
  }),
});

const actionTreeSchema = z.object({
  tx_chain_completed: z.boolean(),
  initial_tx_id: z.object({
    hash: z.string(),
    contract_address: z.string().nullable().optional(),
  }),
  actions: z.array(
    z
      .object({
        "@type": z.string(),
        status: z
          .object({
            "@type": z.enum(["completed", "pending", "aborted"]),
            success: z.boolean().optional(),
          })
          .passthrough(),
        tx_payload: z.record(z.string(), z.unknown()),
      })
      .passthrough(),
  ),
});

function usdUnits(value: string | null): string {
  if (!value || !/^\d+(?:\.\d+)?$/.test(value)) return "0";
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(`${whole}${fraction.padEnd(6, "0").slice(0, 6)}`).toString();
}

function poolFeePips(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return 0;
  const fee = BigInt(value);
  if (fee > 100n) return null;
  return Number(fee * 100n);
}

function slug(symbol: string, address: string): string {
  return `${symbol.toLowerCase()}-${address
    .slice(-6)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")}`;
}

function impactPips(value: string | undefined): number {
  if (!value || !/^\d+(?:\.\d+)?$/.test(value)) return 0;
  const [whole = "0", fraction = ""] = value.split(".");
  const pips = BigInt(`${whole}${fraction.padEnd(6, "0").slice(0, 6)}`);
  return Number(pips > 1_000_000n ? 1_000_000n : pips);
}

export class StonService {
  private readonly options;

  constructor(private readonly config: Config) {
    this.options = {
      timeoutMs: config.UPSTREAM_TIMEOUT_MS,
      retries: config.UPSTREAM_RETRIES,
    };
  }

  private url(path: string): URL {
    const base = new URL(this.config.STON_API_URL);
    const url = new URL(path, base);
    if (url.origin !== base.origin || !url.pathname.startsWith("/v1/")) {
      throw new AppError("BAD_REQUEST", "STON.fi request escaped the V1 API");
    }
    return url;
  }

  async getPools(): Promise<Pool[]> {
    const [assetRaw, poolRaw, routerRaw] = await Promise.all([
      readJson(this.url("/v1/assets"), { method: "GET" }, this.options),
      readJson(
        this.url("/v1/pools?dex_v2=true"),
        { method: "GET" },
        this.options,
      ),
      readJson(
        this.url("/v1/routers?dex_v2=true"),
        { method: "GET" },
        this.options,
      ),
    ]);
    const assets = new Map(
      assetResponseSchema.parse(assetRaw).asset_list.flatMap((asset) => {
        const key = tonAddressKey(asset.contract_address);
        return key ? [[key, asset] as const] : [];
      }),
    );
    const routers = new Map(
      routerResponseSchema.parse(routerRaw).router_list.flatMap((router) => {
        const key = tonAddressKey(router.address);
        return key ? [[key, router] as const] : [];
      }),
    );
    const pools = poolResponseSchema.parse(poolRaw).pool_list;
    const approved = new Set(
      this.config.APPROVED_POOLS.flatMap(
        (address) => tonAddressKey(address) ?? [],
      ),
    );
    const checkedAt = new Date().toISOString();

    return pools
      .filter(
        (pool) =>
          !pool.deprecated &&
          !sameTonAddress(pool.token0_address, pool.token1_address),
      )
      .filter(
        (pool) =>
          sameTonAddress(pool.token0_address, TON_USDT) ||
          sameTonAddress(pool.token1_address, TON_USDT),
      )
      .filter((pool) => approved.has(tonAddressKey(pool.address) ?? ""))
      .map((pool) => {
        const token0 = assets.get(tonAddressKey(pool.token0_address) ?? "");
        const token1 = assets.get(tonAddressKey(pool.token1_address) ?? "");
        const router = routers.get(tonAddressKey(pool.router_address) ?? "");
        const feePips = poolFeePips(pool.lp_fee);
        const usdt = assets.get(tonAddressKey(TON_USDT) ?? "");
        const enabled = Boolean(
          token0 &&
          token1 &&
          !token0.blacklisted &&
          !token1.blacklisted &&
          !token0.deprecated &&
          !token1.deprecated &&
          router &&
          router.major_version >= 2 &&
          usdt &&
          ["USDT", "USD₮"].includes(usdt.symbol) &&
          usdt.decimals === 6 &&
          feePips !== null &&
          approved.has(tonAddressKey(pool.address) ?? ""),
        );
        const other = sameTonAddress(pool.token0_address, TON_USDT)
          ? token1
          : token0;
        return poolSchema.parse({
          id: slug(other?.symbol ?? "pool", pool.address),
          address: pool.address,
          routerAddress: pool.router_address,
          token0: {
            address: pool.token0_address,
            symbol: token0?.symbol ?? "unknown",
            name: token0?.display_name ?? token0?.symbol ?? "Unknown asset",
            decimals: token0?.decimals ?? 0,
          },
          token1: {
            address: pool.token1_address,
            symbol: token1?.symbol ?? "unknown",
            name: token1?.display_name ?? token1?.symbol ?? "Unknown asset",
            decimals: token1?.decimals ?? 0,
          },
          entryMode: "single",
          enabled,
          disabledReason: enabled
            ? null
            : "Pool metadata or router validation failed",
          tvlUsdUnits: usdUnits(pool.lp_total_supply_usd),
          volume24hUsdUnits: usdUnits(pool.volume_24h_usd),
          feePips: feePips ?? 0,
          aprPips: null,
          checkedAt,
        });
      })
      .sort((left, right) => {
        const a = BigInt(left.tvlUsdUnits);
        const b = BigInt(right.tvlUsdUnits);
        return a === b ? 0 : a > b ? -1 : 1;
      });
  }

  async getPlan(
    flow: Flow,
    pool: Pool,
    inputUnits: string,
    indicative: boolean,
  ): Promise<DepositPlan> {
    if (!pool.enabled)
      throw new AppError("POOL_DISABLED", "Pool is not enabled", 409);
    const tokenB = sameTonAddress(pool.token0.address, TON_USDT)
      ? pool.token1.address
      : pool.token0.address;
    const url = this.url("/v1/liquidity_provision/simulate");
    url.searchParams.set("token_a", TON_USDT);
    url.searchParams.set("token_b", tokenB);
    url.searchParams.set("pool_address", pool.address);
    url.searchParams.set("token_a_units", inputUnits);
    url.searchParams.set("token_b_units", "0");
    url.searchParams.set("provision_type", "Arbitrary");
    url.searchParams.set("slippage_tolerance", "0.01");
    url.searchParams.set("wallet_address", flow.tonWallet);
    const [simulationRaw, routerRaw, positionRaw] = await Promise.all([
      readJson(url, { method: "POST" }, this.options),
      readJson(
        this.url("/v1/routers?dex_v2=true"),
        { method: "GET" },
        this.options,
      ),
      readJson(
        this.url(
          `/v1/wallets/${encodeURIComponent(flow.tonWallet)}/pools/${encodeURIComponent(pool.address)}`,
        ),
        { method: "GET" },
        this.options,
      ).catch((error: unknown) => {
        if (indicative)
          return { pool: { address: pool.address, lp_balance: "0" } };
        throw error;
      }),
    ]);
    const result = simulationSchema.parse(simulationRaw);
    const routers = new Map(
      routerResponseSchema
        .parse(routerRaw)
        .router_list.map((router) => [router.address, router]),
    );
    const position = positionSchema.parse(positionRaw).pool;
    if (
      !sameTonAddress(result.pool_address, pool.address) ||
      !sameTonAddress(result.token_a, TON_USDT) ||
      !sameTonAddress(result.token_b, tokenB) ||
      result.token_a_units !== inputUnits ||
      result.token_b_units !== "0" ||
      result.provision_type !== "Arbitrary" ||
      !sameTonAddress(result.router_address, result.router.address) ||
      result.router.major_version < 2 ||
      BigInt(result.min_lp_units) === 0n
    ) {
      throw new AppError(
        "UPSTREAM_FAILED",
        "STON.fi simulation changed the approved plan",
        502,
      );
    }
    if (
      BigInt(result.lp_account_token_a_balance) !== 0n ||
      BigInt(result.lp_account_token_b_balance) !== 0n
    ) {
      throw new AppError(
        "PLAN_CHANGED",
        "Old LP-account balances must be refunded before provision",
        409,
      );
    }
    const listedRouter = [...routers.values()].find((router) =>
      sameTonAddress(router.address, result.router.address),
    );
    if (!listedRouter || listedRouter.major_version < 2) {
      throw new AppError(
        "UPSTREAM_FAILED",
        "Simulation router is not listed as V2",
        502,
      );
    }
    if (!sameTonAddress(position.address, pool.address)) {
      throw new AppError(
        "UPSTREAM_FAILED",
        "Position response returned a different pool",
        502,
      );
    }
    return {
      id: crypto.randomUUID(),
      flowId: flow.id,
      poolId: pool.id,
      mode: "single",
      inputUnits,
      token0Units: sameTonAddress(pool.token0.address, TON_USDT)
        ? inputUnits
        : "0",
      token1Units: sameTonAddress(pool.token1.address, TON_USDT)
        ? inputUnits
        : "0",
      minLpUnits: result.min_lp_units,
      lpUnitsBefore: position.lp_balance ?? "0",
      gasUnits: this.config.TON_DEPOSIT_GAS_UNITS,
      priceImpactPips: impactPips(result.price_impact),
      indicative,
      routerAddress: result.router.address,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
  }

  async getPosition(wallet: string, pool: string): Promise<string> {
    const result = positionSchema.parse(
      await readJson(
        this.url(
          `/v1/wallets/${encodeURIComponent(wallet)}/pools/${encodeURIComponent(pool)}`,
        ),
        { method: "GET" },
        this.options,
      ),
    ).pool;
    if (!sameTonAddress(result.address, pool)) {
      throw new AppError(
        "UPSTREAM_FAILED",
        "Position response returned a different pool",
        502,
      );
    }
    return result.lp_balance ?? "0";
  }

  async verifyLiquidityAction(
    hash: string,
    wallet: string,
    type: "deposit" | "withdraw",
  ): Promise<"pending" | "failed" | "confirmed"> {
    const result = actionTreeSchema.parse(
      await readJson(
        this.url(`/v1/transactions/${encodeURIComponent(hash)}/action_tree`),
        { method: "GET" },
        this.options,
      ),
    );
    if (!sameTonHash(result.initial_tx_id.hash, hash)) {
      throw new AppError(
        "UPSTREAM_FAILED",
        "STON.fi action tree hash does not match",
        502,
      );
    }
    if (
      result.initial_tx_id.contract_address &&
      !sameTonAddress(result.initial_tx_id.contract_address, wallet)
    ) {
      throw new AppError(
        "PROOF_REQUIRED",
        "TON transaction is not owned by the flow wallet",
        409,
      );
    }
    const types =
      type === "deposit"
        ? ["provide_liquidity", "direct_add_liquidity"]
        : ["jetton_burn"];
    const actions = result.actions.filter((action) =>
      types.includes(action["@type"]),
    );
    if (actions.length !== 1) {
      if (!result.tx_chain_completed) return "pending";
      throw new AppError(
        "PROOF_REQUIRED",
        "Expected STON.fi action was not found",
        409,
      );
    }
    const action = actions[0];
    if (!action)
      throw new AppError("INTERNAL_ERROR", "STON.fi action is missing", 500);
    for (const field of [
      "receiver_address",
      "refund_address",
      "user_wallet_address",
      "response_destination",
    ]) {
      const address = action.tx_payload[field];
      if (typeof address === "string" && !sameTonAddress(address, wallet)) {
        throw new AppError(
          "PROOF_REQUIRED",
          `STON.fi ${field} does not match the flow wallet`,
          409,
        );
      }
    }
    if (action.status["@type"] === "aborted" || action.status.success === false)
      return "failed";
    if (!result.tx_chain_completed || action.status["@type"] === "pending")
      return "pending";
    return action.status.success === true ? "confirmed" : "failed";
  }
}

function tonHashBytes(value: string): Buffer | null {
  try {
    if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, "hex");
    const bytes = Buffer.from(
      value.replaceAll("-", "+").replaceAll("_", "/"),
      "base64",
    );
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

function sameTonHash(left: string, right: string): boolean {
  const a = tonHashBytes(left);
  const b = tonHashBytes(right);
  return Boolean(a && b && a.equals(b));
}
