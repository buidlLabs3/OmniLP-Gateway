import { z } from "zod";

import { baseAddressSchema, tonAddressSchema } from "./address.js";
import { positiveUnitsSchema } from "./amount.js";
import { flowStateSchema } from "./state.js";

export const flowTypeSchema = z.enum(["entry", "exit"]);

export const createFlowSchema = z
  .object({
    type: flowTypeSchema.default("entry"),
    poolId: z.string().regex(/^[a-z0-9-]+$/),
    baseWallet: baseAddressSchema,
    tonWallet: tonAddressSchema,
    sourceUnits: positiveUnitsSchema,
  })
  .strict();

export const flowSchema = z
  .object({
    id: z.string().uuid(),
    type: flowTypeSchema,
    state: flowStateSchema,
    poolId: z.string().min(1),
    baseWallet: baseAddressSchema,
    tonWallet: tonAddressSchema,
    sourceUnits: positiveUnitsSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    version: z.number().int().nonnegative(),
  })
  .strict();

export const eventSchema = z
  .object({
    id: z.string().uuid(),
    flowId: z.string().uuid(),
    priorState: flowStateSchema.nullable(),
    nextState: flowStateSchema,
    reference: z.string().min(1).max(300),
    createdAt: z.string().datetime(),
  })
  .strict();

export type CreateFlow = z.input<typeof createFlowSchema>;
export type Flow = z.infer<typeof flowSchema>;
export type FlowEvent = z.infer<typeof eventSchema>;
