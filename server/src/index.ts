import { buildApp } from "./app.js";
import { getConfig, loadLocalEnv } from "./config.js";
import { demoPools } from "./demo.js";
import { Jobs } from "./jobs.js";
import { StonService } from "./services/ston.js";
import { MemoryStore } from "./store/memory.js";
import { PostgresStore } from "./store/postgres.js";
import type { Store } from "./store/types.js";

loadLocalEnv();
const config = getConfig();
const store: Store = config.DEMO_MODE
  ? new MemoryStore()
  : new PostgresStore(config.DATABASE_URL);
if (config.DEMO_MODE) await store.savePools(demoPools);
const ston = new StonService(config);
const app = await buildApp({ config, store, ston });
const jobs = new Jobs(config, store, ston);
const worker = `server:${process.pid}`;
let running = false;
const runJobs = async () => {
  if (running) return;
  running = true;
  try {
    await jobs.run(worker);
  } finally {
    running = false;
  }
};
const runJobsSafely = () => {
  void runJobs().catch((error: unknown) =>
    app.log.error({ err: error }, "Worker poll failed"),
  );
};
const jobTimer = setInterval(runJobsSafely, 5_000);
jobTimer.unref();

const refreshPools = async () => {
  const pools = await ston.getPools();
  await store.savePools(pools);
  app.log.info(
    {
      enabled: pools.filter((pool) => pool.enabled).length,
      total: pools.length,
    },
    "Pool catalog refreshed",
  );
};
const refreshPoolsSafely = () => {
  void refreshPools().catch((error: unknown) =>
    app.log.error({ err: error }, "Pool catalog refresh failed"),
  );
};
const poolTimer = config.DEMO_MODE
  ? undefined
  : setInterval(refreshPoolsSafely, 15 * 60_000);
poolTimer?.unref();

const shutdown = async () => {
  clearInterval(jobTimer);
  if (poolTimer) clearInterval(poolTimer);
  await app.close();
  if (store instanceof PostgresStore) await store.close();
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await app.listen({ host: config.HOST, port: config.PORT });
runJobsSafely();
if (!config.DEMO_MODE) refreshPoolsSafely();
