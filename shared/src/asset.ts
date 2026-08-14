import { z } from "zod";

import { baseAddressSchema, tonAddressSchema } from "./address.js";

export const BASE_CHAIN_ID = 8453;
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const TON_USDT = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";
export const USDC_DECIMALS = 6;
export const USDT_DECIMALS = 6;

export const chainSchema = z.enum(["base", "ton"]);

export const routeAssetSchema = z.discriminatedUnion("chain", [
  z
    .object({
      chain: z.literal("base"),
      address: baseAddressSchema,
      symbol: z.literal("USDC"),
      decimals: z.literal(USDC_DECIMALS),
    })
    .strict(),
  z
    .object({
      chain: z.literal("ton"),
      address: tonAddressSchema,
      symbol: z.literal("USDT"),
      decimals: z.literal(USDT_DECIMALS),
    })
    .strict(),
]);

export const routeAssets = {
  baseUsdc: {
    chain: "base",
    address: BASE_USDC,
    symbol: "USDC",
    decimals: USDC_DECIMALS,
  },
  tonUsdt: {
    chain: "ton",
    address: TON_USDT,
    symbol: "USDT",
    decimals: USDT_DECIMALS,
  },
} as const;
