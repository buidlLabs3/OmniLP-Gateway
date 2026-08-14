import { z } from "zod";

import {
  BASE_USDC,
  TON_USDT,
  baseAddressSchema,
  tonAddressSchema,
  unitsSchema,
} from "@omnilp/shared";

const booleanValue = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

const optionalSecret = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);

const optionalHttpsUrl = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z
    .string()
    .url()
    .refine((url) => url.startsWith("https://"), "Must use https")
    .optional(),
);

const configSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    HOST: z.string().min(1).default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
    WEB_ORIGIN: z.string().url(),
    DATABASE_URL: z.string().url(),
    OMNISTON_WS_URL: z
      .string()
      .url()
      .refine((url) => url.startsWith("wss://"), "Must use wss"),
    STON_API_URL: z
      .string()
      .url()
      .refine((url) => url.startsWith("https://"), "Must use https"),
    BASE_RPC_URL: z
      .string()
      .url()
      .refine((url) => url.startsWith("https://"), "Must use https"),
    TON_RPC_URL: z
      .string()
      .url()
      .refine((url) => url.startsWith("https://"), "Must use https"),
    BASE_USDC: baseAddressSchema.default(BASE_USDC),
    TON_USDT: tonAddressSchema.default(TON_USDT),
    MAX_SOURCE_UNITS: unitsSchema.refine((value) => BigInt(value) > 0n),
    MIN_SOURCE_UNITS: unitsSchema.refine((value) => BigInt(value) > 0n),
    PLAN_CHANGE_PIPS: z.coerce
      .number()
      .int()
      .min(0)
      .max(1_000_000)
      .default(10_000),
    APPROVED_POOLS: z
      .string()
      .default("")
      .transform((value) =>
        value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      )
      .pipe(z.array(tonAddressSchema).max(20)),
    UPSTREAM_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(120_000)
      .default(15_000),
    UPSTREAM_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
    READ_ONLY: booleanValue.default(true),
    DEMO_MODE: booleanValue.default(false),
    TELEGRAM_BOT_TOKEN: optionalSecret,
    TELEGRAM_APP_URL: optionalHttpsUrl,
    TELEGRAM_MAX_AGE_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .max(86_400)
      .default(900),
    SESSION_SECRET: z.string().min(32),
    TON_DEPOSIT_GAS_UNITS: unitsSchema.refine((value) => BigInt(value) > 0n),
  })
  .strict()
  .superRefine((value, context) => {
    if (BigInt(value.MIN_SOURCE_UNITS) > BigInt(value.MAX_SOURCE_UNITS)) {
      context.addIssue({
        code: "custom",
        message: "MIN_SOURCE_UNITS cannot exceed MAX_SOURCE_UNITS",
        path: ["MIN_SOURCE_UNITS"],
      });
    }
    if (value.NODE_ENV === "production" && value.DEMO_MODE) {
      context.addIssue({
        code: "custom",
        message: "DEMO_MODE must be disabled in production",
        path: ["DEMO_MODE"],
      });
    }
    if (value.NODE_ENV === "production" && !value.TELEGRAM_BOT_TOKEN) {
      context.addIssue({
        code: "custom",
        message: "TELEGRAM_BOT_TOKEN is required in production",
        path: ["TELEGRAM_BOT_TOKEN"],
      });
    }
    if (value.NODE_ENV === "production" && !value.TELEGRAM_APP_URL) {
      context.addIssue({
        code: "custom",
        message: "TELEGRAM_APP_URL is required in production",
        path: ["TELEGRAM_APP_URL"],
      });
    }
  });

export type Config = z.infer<typeof configSchema>;

export function getConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return configSchema.parse({
    NODE_ENV: env.NODE_ENV,
    HOST: env.HOST,
    PORT: env.PORT,
    WEB_ORIGIN: env.WEB_ORIGIN,
    DATABASE_URL: env.DATABASE_URL,
    OMNISTON_WS_URL: env.OMNISTON_WS_URL,
    STON_API_URL: env.STON_API_URL,
    BASE_RPC_URL: env.BASE_RPC_URL,
    TON_RPC_URL: env.TON_RPC_URL,
    BASE_USDC: env.BASE_USDC,
    TON_USDT: env.TON_USDT,
    MAX_SOURCE_UNITS: env.MAX_SOURCE_UNITS,
    MIN_SOURCE_UNITS: env.MIN_SOURCE_UNITS,
    PLAN_CHANGE_PIPS: env.PLAN_CHANGE_PIPS,
    APPROVED_POOLS: env.APPROVED_POOLS,
    UPSTREAM_TIMEOUT_MS: env.UPSTREAM_TIMEOUT_MS,
    UPSTREAM_RETRIES: env.UPSTREAM_RETRIES,
    READ_ONLY: env.READ_ONLY,
    DEMO_MODE: env.DEMO_MODE,
    TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_APP_URL: env.TELEGRAM_APP_URL,
    TELEGRAM_MAX_AGE_SECONDS: env.TELEGRAM_MAX_AGE_SECONDS,
    SESSION_SECRET: env.SESSION_SECRET,
    TON_DEPOSIT_GAS_UNITS: env.TON_DEPOSIT_GAS_UNITS,
  });
}

export function loadLocalEnv(): void {
  if (process.env.NODE_ENV === "production") return;
  try {
    process.loadEnvFile(new URL("../../.env", import.meta.url));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
