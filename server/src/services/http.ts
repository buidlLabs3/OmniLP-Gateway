import { setTimeout as delay } from "node:timers/promises";

import { AppError } from "@omnilp/shared";

const MAX_BODY_BYTES = 64_000_000;

export interface ReadOptions {
  timeoutMs: number;
  retries: number;
  fetch?: typeof fetch;
}

export async function readJson(
  url: URL,
  init: RequestInit,
  options: ReadOptions,
): Promise<unknown> {
  if (url.protocol !== "https:")
    throw new AppError("BAD_REQUEST", "Upstream must use HTTPS");
  if (url.username || url.password)
    throw new AppError("BAD_REQUEST", "Upstream URL has credentials");
  const fetcher = options.fetch ?? fetch;
  let lastError: unknown;

  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    try {
      const response = await fetcher(url, {
        ...init,
        headers: { accept: "application/json", ...init.headers },
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      const length = Number(response.headers.get("content-length"));
      if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
        throw new AppError(
          "UPSTREAM_FAILED",
          "Upstream response is too large",
          502,
        );
      }
      const text = await response.text();
      if (Buffer.byteLength(text) > MAX_BODY_BYTES) {
        throw new AppError(
          "UPSTREAM_FAILED",
          "Upstream response is too large",
          502,
        );
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new AppError(
          "UPSTREAM_FAILED",
          "Upstream returned invalid JSON",
          502,
        );
      }
      if (response.ok) return body;
      if (![408, 429].includes(response.status) && response.status < 500) {
        throw new AppError(
          "UPSTREAM_FAILED",
          `Upstream rejected request (${response.status})`,
          502,
        );
      }
      lastError = new AppError(
        "UPSTREAM_FAILED",
        `Upstream temporarily unavailable (${response.status})`,
        502,
        true,
      );
    } catch (error) {
      lastError = error;
      if (error instanceof AppError && !error.retryable) throw error;
      if (attempt === options.retries) break;
    }
    await delay(250 * 2 ** attempt);
  }
  throw new AppError(
    "UPSTREAM_FAILED",
    lastError instanceof Error ? lastError.message : "Upstream read failed",
    502,
    true,
  );
}
