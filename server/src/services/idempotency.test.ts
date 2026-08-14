import { describe, expect, it } from "vitest";

import { MemoryStore } from "../store/memory.js";
import { idempotent } from "./idempotency.js";

describe("idempotency", () => {
  it("blocks a concurrent duplicate before running another side effect", async () => {
    const store = new MemoryStore();
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let runs = 0;
    const first = idempotent(
      store,
      "test",
      "concurrent-key-0001",
      { value: 1 },
      async () => {
        runs += 1;
        await waiting;
        return { ok: true };
      },
    );
    await expect(
      idempotent(
        store,
        "test",
        "concurrent-key-0001",
        { value: 1 },
        async () => {
          runs += 1;
          return { ok: false };
        },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT", retryable: true });
    release?.();
    await expect(first).resolves.toEqual({ status: 200, value: { ok: true } });
    expect(runs).toBe(1);
  });

  it("clears a failed reservation so the request can be retried", async () => {
    const store = new MemoryStore();
    const run = () => Promise.reject(new Error("failed"));
    await expect(
      idempotent(store, "test", "retryable-key-0001", {}, run),
    ).rejects.toThrow("failed");
    await expect(
      idempotent(
        store,
        "test",
        "retryable-key-0001",
        {},
        async () => "complete",
      ),
    ).resolves.toEqual({ status: 200, value: "complete" });
  });
});
