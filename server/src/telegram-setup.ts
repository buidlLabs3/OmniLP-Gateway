import { z } from "zod";

import { getConfig, loadLocalEnv } from "./config.js";

const resultSchema = z.object({
  ok: z.literal(true),
  result: z.unknown().optional(),
});

loadLocalEnv();
const config = getConfig();
if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_APP_URL) {
  throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_APP_URL are required");
}

async function call(method: string, body: unknown): Promise<unknown> {
  const response = await fetch(
    `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    },
  );
  const value: unknown = await response.json();
  if (!response.ok) throw new Error(`Telegram ${method} failed`);
  return resultSchema.parse(value).result;
}

const bot = z
  .object({ username: z.string().min(1) })
  .parse(await call("getMe", {}));
await call("setChatMenuButton", {
  menu_button: {
    type: "web_app",
    text: "Open OmniLP",
    web_app: { url: config.TELEGRAM_APP_URL },
  },
});

console.log(`Telegram menu ready: https://t.me/${bot.username}`);
