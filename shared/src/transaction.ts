import { z } from "zod";

import { baseAddressSchema, tonAddressSchema } from "./address.js";
import { positiveUnitsSchema } from "./amount.js";

export const transactionKindSchema = z.enum([
  "source",
  "deposit",
  "withdraw",
  "exit",
]);
export const transactionStatusSchema = z.enum([
  "pending",
  "confirmed",
  "failed",
]);
export const evmHashSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "Invalid EVM transaction hash");
export const tonHashSchema = z
  .string()
  .regex(/^[A-Za-z0-9_+/=-]{32,128}$/, "Invalid TON transaction hash");

export const sourceReviewSchema = z
  .object({
    flowId: z.string().uuid(),
    quoteId: z.string().min(1).max(256),
    owner: baseAddressSchema,
    recipient: tonAddressSchema,
    inputUnits: positiveUnitsSchema,
    expiresAt: z.string().datetime(),
    typedData: z.record(z.string(), z.unknown()),
    orderExtension: z.string().min(1).max(1_000_000),
    orderDetails: z.string().min(1).max(1_000_000),
  })
  .strict();

export const walletRequestSchema = z
  .object({
    chain: z.enum(["base", "ton"]),
    flowId: z.string().uuid(),
    kind: transactionKindSchema,
    expiresAt: z.string().datetime(),
    receiver: z.union([baseAddressSchema, tonAddressSchema]),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

export const transactionReferenceSchema = z
  .object({
    hash: z.string().min(16).max(256),
    attempt: z.number().int().min(1).max(100),
    version: z.number().int().nonnegative(),
  })
  .strict();

export type WalletRequest = z.infer<typeof walletRequestSchema>;
