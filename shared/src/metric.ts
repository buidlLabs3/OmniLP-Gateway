import { z } from "zod";

import { unitsSchema } from "./amount.js";

export const impactSchema = z
  .object({
    checkedAt: z.string().datetime(),
    routedUsdcUnits: unitsSchema,
    depositedUsdUnits: unitsSchema,
    retained7dUsdUnits: unitsSchema,
    retained30dUsdUnits: unitsSchema,
    completedEntries: z.number().int().nonnegative(),
    completedExits: z.number().int().nonnegative(),
    sourceWithdrawals: z.number().int().nonnegative(),
    completionPips: z.number().int().min(0).max(1_000_000),
    medianEntryUnits: unitsSchema,
    pools: z.array(
      z.object({
        poolId: z.string().min(1),
        depositUsdUnits: unitsSchema,
        positions: z.number().int().nonnegative(),
      }),
    ),
  })
  .strict();

export type Impact = z.infer<typeof impactSchema>;
