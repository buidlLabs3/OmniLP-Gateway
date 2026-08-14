import { z } from "zod";

import { tonAddressSchema } from "./address.js";
import { unitsSchema } from "./amount.js";

export const entryModeSchema = z.enum(["single", "balanced"]);

export const assetSchema = z
  .object({
    address: tonAddressSchema,
    symbol: z.string().min(1).max(16),
    name: z.string().min(1).max(80),
    decimals: z.number().int().min(0).max(30),
  })
  .strict();

export const poolSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    address: tonAddressSchema,
    routerAddress: tonAddressSchema,
    token0: assetSchema,
    token1: assetSchema,
    entryMode: entryModeSchema,
    enabled: z.boolean(),
    disabledReason: z.string().max(300).nullable(),
    tvlUsdUnits: unitsSchema,
    volume24hUsdUnits: unitsSchema,
    feePips: z.number().int().min(0).max(1_000_000),
    aprPips: z.number().int().min(0).max(10_000_000).nullable(),
    checkedAt: z.string().datetime(),
  })
  .strict();

export type Pool = z.infer<typeof poolSchema>;
