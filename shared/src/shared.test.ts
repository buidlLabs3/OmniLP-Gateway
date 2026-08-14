import { describe, expect, it } from "vitest";

import {
  TON_USDT,
  addAmount,
  assertState,
  canSetState,
  changePips,
  formatAmount,
  isTonAddress,
  sameTonAddress,
  multiplyPips,
  parseAmount,
  subtractAmount,
} from "./index.js";

describe("amounts", () => {
  it("uses integer math and explicit rounding", () => {
    expect(parseAmount("10.25", 6)).toBe("10250000");
    expect(formatAmount("10250001", 6, 2)).toBe("10.25");
    expect(addAmount("9", "2")).toBe("11");
    expect(subtractAmount("9", "2")).toBe("7");
    expect(() => subtractAmount("2", "9")).toThrow(/negative/);
    expect(multiplyPips("101", 500_000, "down")).toBe("50");
    expect(multiplyPips("101", 500_000, "up")).toBe("51");
    expect(changePips("1000", "990")).toBe(10_000);
  });
});

describe("addresses", () => {
  it("checks TON friendly checksums and raw workchains", () => {
    expect(isTonAddress(TON_USDT)).toBe(true);
    expect(isTonAddress("0:".padEnd(66, "0"))).toBe(true);
    expect(isTonAddress(`${TON_USDT.slice(0, -1)}A`)).toBe(false);
    expect(
      sameTonAddress(
        TON_USDT,
        "0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe",
      ),
    ).toBe(true);
    expect(sameTonAddress(TON_USDT, "0:".padEnd(66, "0"))).toBe(false);
  });
});

describe("flow state", () => {
  it("allows only explicit forward and recovery transitions", () => {
    expect(canSetState("trade_filled", "funds_received")).toBe(true);
    expect(canSetState("trade_filled", "complete")).toBe(false);
    expect(() => assertState("draft", "complete")).toThrow(
      /Cannot change flow/,
    );
  });
});
