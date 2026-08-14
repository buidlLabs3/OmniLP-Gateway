import { createHash } from "node:crypto";

import { AppError } from "@omnilp/shared";

import type { Store } from "../store/types.js";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

export function requestHash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export async function idempotent<T>(
  store: Store,
  scope: string,
  key: string | undefined,
  input: unknown,
  run: () => Promise<T>,
): Promise<{ status: number; value: T }> {
  if (!key || !/^[A-Za-z0-9._:-]{16,128}$/.test(key)) {
    throw new AppError(
      "BAD_REQUEST",
      "A valid Idempotency-Key header is required",
      400,
    );
  }
  const hash = requestHash(input);
  const current = await store.reserveIdempotency(scope, key, hash);
  if (current) {
    if (current.hash !== hash) {
      throw new AppError(
        "CONFLICT",
        "Idempotency key was used for different input",
        409,
      );
    }
    if (current.status === 102) {
      throw new AppError(
        "CONFLICT",
        "An identical request is still in progress",
        409,
        true,
      );
    }
    return { status: current.status, value: current.response as T };
  }
  try {
    const value = await run();
    await store.saveIdempotency(scope, key, hash, 200, value);
    return { status: 200, value };
  } catch (error) {
    await store.clearIdempotency(scope, key, hash);
    throw error;
  }
}
