import { createHmac, timingSafeEqual } from "node:crypto";

import { AppError } from "@omnilp/shared";
import { z } from "zod";

import type { Config } from "../config.js";

const launchSchema = z
  .object({
    initData: z.string().max(10_000),
    demo: z.boolean().optional(),
  })
  .strict();

const userSchema = z
  .object({
    id: z.number().int().nonnegative().safe(),
    first_name: z.string().min(1).max(128),
    last_name: z.string().max(128).optional(),
    username: z.string().max(64).optional(),
    language_code: z.string().max(16).optional(),
    photo_url: z.string().url().max(2_048).optional(),
  })
  .passthrough();

const tokenSchema = z
  .object({
    sub: z.string().min(1).max(32),
    demo: z.boolean(),
    exp: z.number().int().positive(),
  })
  .strict();

export interface TelegramUser {
  id: string;
  firstName: string;
  lastName?: string;
  username?: string;
  languageCode?: string;
  photoUrl?: string;
}

export interface TelegramSession {
  user: TelegramUser;
  demo: boolean;
  token: string;
  expiresAt: string;
}

function unauthorized(message: string): AppError {
  return new AppError("UNAUTHORIZED", message, 401);
}

export function verifyTelegramData(
  initData: string,
  botToken: string,
  maxAgeSeconds: number,
  now = Date.now(),
): TelegramUser {
  const params = new URLSearchParams(initData);
  const values = new Map<string, string>();
  for (const [key, value] of params) {
    if (values.has(key)) throw unauthorized("Telegram launch data is invalid");
    values.set(key, value);
  }

  const hash = values.get("hash");
  const authDateValue = values.get("auth_date");
  const userValue = values.get("user");
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash) || !authDateValue || !userValue) {
    throw unauthorized("Telegram launch data is incomplete");
  }

  const authDate = Number(authDateValue);
  if (!Number.isSafeInteger(authDate) || authDate <= 0) {
    throw unauthorized("Telegram launch time is invalid");
  }
  const age = Math.floor(now / 1_000) - authDate;
  if (age < -60 || age > maxAgeSeconds) {
    throw unauthorized("Telegram launch data has expired");
  }

  values.delete("hash");
  const dataCheck = [...values.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(dataCheck).digest();
  const supplied = Buffer.from(hash, "hex");
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    throw unauthorized("Telegram launch signature is invalid");
  }

  let rawUser: unknown;
  try {
    rawUser = JSON.parse(userValue);
  } catch {
    throw unauthorized("Telegram user data is invalid");
  }
  const parsed = userSchema.safeParse(rawUser);
  if (!parsed.success) throw unauthorized("Telegram user data is invalid");

  return {
    id: String(parsed.data.id),
    firstName: parsed.data.first_name,
    ...(parsed.data.last_name ? { lastName: parsed.data.last_name } : {}),
    ...(parsed.data.username ? { username: parsed.data.username } : {}),
    ...(parsed.data.language_code
      ? { languageCode: parsed.data.language_code }
      : {}),
    ...(parsed.data.photo_url ? { photoUrl: parsed.data.photo_url } : {}),
  };
}

export class TelegramService {
  constructor(private readonly config: Config) {}

  private issue(user: TelegramUser, demo: boolean): TelegramSession {
    const exp = Math.floor(Date.now() / 1_000) + 3_600;
    const payload = Buffer.from(
      JSON.stringify({ sub: user.id, demo, exp }),
    ).toString("base64url");
    const signature = createHmac("sha256", this.config.SESSION_SECRET)
      .update(`telegram.${payload}`)
      .digest("base64url");
    return {
      user,
      demo,
      token: `${payload}.${signature}`,
      expiresAt: new Date(exp * 1_000).toISOString(),
    };
  }

  start(input: unknown): TelegramSession {
    const value = launchSchema.parse(input);
    if (value.demo) {
      if (!this.config.DEMO_MODE || this.config.NODE_ENV === "production") {
        throw unauthorized("Telegram demo access is disabled");
      }
      return this.issue(
        { id: "demo", firstName: "Builder", username: "omnilp_demo" },
        true,
      );
    }
    if (!this.config.TELEGRAM_BOT_TOKEN) {
      throw unauthorized("Telegram launch verification is not configured");
    }
    return this.issue(
      verifyTelegramData(
        value.initData,
        this.config.TELEGRAM_BOT_TOKEN,
        this.config.TELEGRAM_MAX_AGE_SECONDS,
      ),
      false,
    );
  }

  verifySession(token: unknown): void {
    if (typeof token !== "string") {
      throw unauthorized("Telegram session is required");
    }
    const [payload, supplied, extra] = token.split(".");
    if (!payload || !supplied || extra) {
      throw unauthorized("Telegram session is invalid");
    }
    const expected = createHmac("sha256", this.config.SESSION_SECRET)
      .update(`telegram.${payload}`)
      .digest();
    const signature = Buffer.from(supplied, "base64url");
    if (
      signature.length !== expected.length ||
      !timingSafeEqual(signature, expected)
    ) {
      throw unauthorized("Telegram session is invalid");
    }
    let raw: unknown;
    try {
      raw = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      throw unauthorized("Telegram session is invalid");
    }
    const parsed = tokenSchema.safeParse(raw);
    if (!parsed.success || parsed.data.exp <= Math.floor(Date.now() / 1_000)) {
      throw unauthorized("Telegram session has expired");
    }
    if (
      parsed.data.demo &&
      (!this.config.DEMO_MODE || this.config.NODE_ENV === "production")
    ) {
      throw unauthorized("Telegram demo access is disabled");
    }
  }
}
