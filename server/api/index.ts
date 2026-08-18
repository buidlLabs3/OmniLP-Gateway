import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";

import { buildApp } from "../src/app.js";
import { getConfig } from "../src/config.js";
import { demoPools } from "../src/demo.js";
import { Jobs } from "../src/jobs.js";
import { OmniService } from "../src/services/omni.js";
import { StonService } from "../src/services/ston.js";
import { MemoryStore } from "../src/store/memory.js";
import { PostgresStore } from "../src/store/postgres.js";
import type { Store } from "../src/store/types.js";

let cachedApp: Awaited<ReturnType<typeof buildApp>> | null = null;

async function getApp() {
  if (cachedApp) return cachedApp;

  const config = getConfig();
  const store: Store = config.DEMO_MODE
    ? new MemoryStore()
    : new PostgresStore(config.DATABASE_URL);

  if (config.DEMO_MODE) await store.savePools(demoPools);

  const ston = new StonService(config);
  const omni = new OmniService(config);
  const app = await buildApp({ config, store, ston, omni });

  // Run one round of jobs on cold start
  const jobs = new Jobs(config, store, ston);
  await jobs.run("vercel-coldstart");

  // If DEMO_MODE, refresh pools
  if (config.DEMO_MODE) {
    try {
      const pools = await ston.getPools();
      await store.savePools(pools);
    } catch {
      // ignore pool refresh failures
    }
  }

  cachedApp = app;
  return app;
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
) {
  try {
    const app = await getApp();

    // Strip /api prefix since Fastify routes start at /v1/*
    const originalUrl = req.url ?? "/";
    if (originalUrl.startsWith("/api")) {
      req.url = originalUrl.slice(4) || "/";
    }

    // Emit request to Fastify's Node.js HTTP server
    app.server.emit("request", req, res);
  } catch (error) {
    console.error("Vercel handler error:", error);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Internal server error" }));
  }
}
