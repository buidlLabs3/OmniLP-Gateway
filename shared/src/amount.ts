import { z } from "zod";

export const unitsSchema = z
  .string()
  .regex(/^\d+$/, "Amount must be an unsigned integer");
export const positiveUnitsSchema = unitsSchema.refine(
  (value) => BigInt(value) > 0n,
  {
    message: "Amount must be positive",
  },
);

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) {
    throw new Error("Decimals must be an integer from 0 to 30");
  }
}

export function parseAmount(value: string, decimals: number): string {
  assertDecimals(decimals);
  if (!/^\d+(?:\.\d+)?$/.test(value))
    throw new Error("Amount must be a positive decimal string");
  const [whole = "", fraction = ""] = value.split(".");
  if (fraction.length > decimals)
    throw new Error(`Amount has more than ${decimals} decimals`);
  const result = `${whole}${fraction.padEnd(decimals, "0")}`.replace(
    /^0+(?=\d)/,
    "",
  );
  return BigInt(result).toString();
}

export function formatAmount(
  value: string,
  decimals: number,
  places = decimals,
): string {
  assertDecimals(decimals);
  if (!Number.isInteger(places) || places < 0 || places > decimals) {
    throw new Error("Display places must be within token decimals");
  }
  const amount = BigInt(unitsSchema.parse(value));
  const divisor = 10n ** BigInt(decimals - places);
  const rounded = amount / divisor;
  const displayScale = 10n ** BigInt(places);
  const whole = rounded / displayScale;
  if (places === 0) return whole.toString();
  const fraction = (rounded % displayScale)
    .toString()
    .padStart(places, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function addAmount(left: string, right: string): string {
  return (
    BigInt(unitsSchema.parse(left)) + BigInt(unitsSchema.parse(right))
  ).toString();
}

export function subtractAmount(left: string, right: string): string {
  const result =
    BigInt(unitsSchema.parse(left)) - BigInt(unitsSchema.parse(right));
  if (result < 0n) throw new Error("Amount subtraction would be negative");
  return result.toString();
}

export function compareAmount(left: string, right: string): -1 | 0 | 1 {
  const a = BigInt(unitsSchema.parse(left));
  const b = BigInt(unitsSchema.parse(right));
  return a === b ? 0 : a > b ? 1 : -1;
}

export function multiplyPips(
  value: string,
  pips: number,
  round: "down" | "up",
): string {
  if (!Number.isSafeInteger(pips) || pips < 0 || pips > 1_000_000) {
    throw new Error("Pips must be an integer from 0 to 1000000");
  }
  const numerator = BigInt(unitsSchema.parse(value)) * BigInt(pips);
  const denominator = 1_000_000n;
  const result =
    round === "up" && numerator % denominator !== 0n
      ? numerator / denominator + 1n
      : numerator / denominator;
  return result.toString();
}

export function changePips(previous: string, current: string): number {
  const before = BigInt(positiveUnitsSchema.parse(previous));
  const after = BigInt(unitsSchema.parse(current));
  const difference = before > after ? before - after : after - before;
  const pips = (difference * 1_000_000n) / before;
  return Number(pips > 1_000_000n ? 1_000_000n : pips);
}
