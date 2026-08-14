import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { Config } from "../config.js";
import { TelegramService, verifyTelegramData } from "./telegram.js";

const token = "123456:test-bot-token";
const now = 1_800_000_000_000;

function launchData(overrides: Record<string, string> = {}): string {
  const values = new Map(
    Object.entries({
      auth_date: String(Math.floor(now / 1_000)),
      query_id: "AAHdF6IQAAAAAN0XohDhrOrc",
      user: JSON.stringify({
        id: 279058397,
        first_name: "Ada",
        username: "ada",
      }),
      ...overrides,
    }),
  );
  const dataCheck = [...values.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(dataCheck).digest("hex");
  values.set("hash", hash);
  return new URLSearchParams([...values.entries()]).toString();
}

describe("verifyTelegramData", () => {
  it("accepts fresh signed launch data", () => {
    expect(verifyTelegramData(launchData(), token, 900, now)).toEqual({
      id: "279058397",
      firstName: "Ada",
      username: "ada",
    });
  });

  it("rejects changed and expired launch data", () => {
    const changed = launchData().replace("Ada", "Eve");
    expect(() => verifyTelegramData(changed, token, 900, now)).toThrow(
      "signature is invalid",
    );
    expect(() =>
      verifyTelegramData(
        launchData({ auth_date: String(Math.floor(now / 1_000) - 901) }),
        token,
        900,
        now,
      ),
    ).toThrow("has expired");
  });

  it("issues a signed launch session and rejects token changes", () => {
    const service = new TelegramService({
      NODE_ENV: "test",
      DEMO_MODE: true,
      SESSION_SECRET: "test-telegram-session-secret-long-enough",
    } as Config);
    const session = service.start({ initData: "", demo: true });
    expect(() => service.verifySession(session.token)).not.toThrow();
    expect(() => service.verifySession(`${session.token}x`)).toThrow(
      "session is invalid",
    );
    const production = new TelegramService({
      NODE_ENV: "production",
      DEMO_MODE: false,
      SESSION_SECRET: "test-telegram-session-secret-long-enough",
    } as Config);
    expect(() => production.verifySession(session.token)).toThrow(
      "demo access is disabled",
    );
  });
});
