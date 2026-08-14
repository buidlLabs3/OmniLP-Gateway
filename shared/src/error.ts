import { z } from "zod";

export const errorCodes = [
  "BAD_REQUEST",
  "NOT_FOUND",
  "CONFLICT",
  "UNAUTHORIZED",
  "RATE_LIMITED",
  "ROUTE_UNAVAILABLE",
  "QUOTE_EXPIRED",
  "QUOTE_INVALID",
  "POOL_DISABLED",
  "PLAN_CHANGED",
  "INSUFFICIENT_BALANCE",
  "INSUFFICIENT_GAS",
  "PROOF_REQUIRED",
  "UPSTREAM_FAILED",
  "READ_ONLY",
  "INTERNAL_ERROR",
] as const;

export const errorCodeSchema = z.enum(errorCodes);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly status = 400,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const errorSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string().min(1).max(500),
    retryable: z.boolean(),
    requestId: z.string().min(1),
  }),
});
