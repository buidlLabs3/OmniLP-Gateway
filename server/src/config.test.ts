import { describe, expect, it } from "vitest";

import { getConfig } from "./config.js";

const productionEnv: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  WEB_ORIGIN: "https://app.example.com",
  DATABASE_URL: "postgres://user:pass@db.example.com:5432/omnilp",
  OMNISTON_WS_URL: "wss://omni.example.com",
  STON_API_URL: "https://ston.example.com",
  BASE_RPC_URL: "https://base.example.com",
  TON_RPC_URL: "https://ton.example.com",
  MAX_SOURCE_UNITS: "1000000000",
  MIN_SOURCE_UNITS: "10000000",
  READ_ONLY: "true",
  DEMO_MODE: "false",
  TELEGRAM_BOT_TOKEN: "123456:test-token",
  TELEGRAM_APP_URL: "https://app.example.com",
  SESSION_SECRET: "test-session-secret-that-is-long-enough",
  TON_DEPOSIT_GAS_UNITS: "300000000",
};

describe("Telegram production config", () => {
  it("accepts a bot token and HTTPS Mini App URL", () => {
    const config = getConfig(productionEnv);

    expect(config.TELEGRAM_APP_URL).toBe("https://app.example.com");
    expect(config.DEMO_MODE).toBe(false);
  });

  it("rejects a missing Mini App URL", () => {
    expect(() =>
      getConfig({ ...productionEnv, TELEGRAM_APP_URL: undefined }),
    ).toThrow("TELEGRAM_APP_URL is required in production");
  });

  it("rejects a non-HTTPS Mini App URL", () => {
    expect(() =>
      getConfig({
        ...productionEnv,
        TELEGRAM_APP_URL: "http://app.example.com",
      }),
    ).toThrow("Must use https");
  });
});
