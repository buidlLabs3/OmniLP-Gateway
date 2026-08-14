import { z } from "zod";

import { baseAddressSchema, tonAddressSchema } from "./address.js";
import { positiveUnitsSchema, unitsSchema } from "./amount.js";

export const directionSchema = z.enum(["entry", "exit"]);
export type Direction = z.infer<typeof directionSchema>;

export const quoteSchema = z
  .object({
    id: z.string().min(1).max(256),
    flowId: z.string().uuid(),
    direction: directionSchema,
    resolverId: z.string().min(1).max(256),
    inputUnits: positiveUnitsSchema,
    outputUnits: positiveUnitsSchema,
    protocolFeeUnits: unitsSchema,
    integratorFeeUnits: unitsSchema,
    sourceProtocolAddress: z.union([baseAddressSchema, tonAddressSchema]),
    destinationProtocolAddress: z.union([baseAddressSchema, tonAddressSchema]),
    quotedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();

export const depositPlanSchema = z
  .object({
    id: z.string().uuid(),
    flowId: z.string().uuid(),
    poolId: z.string().min(1),
    mode: z.enum(["single", "balanced"]),
    inputUnits: positiveUnitsSchema,
    token0Units: unitsSchema,
    token1Units: unitsSchema,
    minLpUnits: positiveUnitsSchema,
    lpUnitsBefore: unitsSchema,
    gasUnits: positiveUnitsSchema,
    priceImpactPips: z.number().int().min(0).max(1_000_000),
    indicative: z.boolean(),
    routerAddress: tonAddressSchema,
    expiresAt: z.string().datetime(),
  })
  .strict();

export function isExpired(expiresAt: string, now = Date.now()): boolean {
  const expires = Date.parse(expiresAt);
  return !Number.isFinite(expires) || expires <= now;
}

export type Quote = z.infer<typeof quoteSchema>;
export type DepositPlan = z.infer<typeof depositPlanSchema>;
