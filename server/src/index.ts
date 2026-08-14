import { buildApp } from "./app.js";
import { getConfig } from "./config.js";
import { Jobs } from "./jobs.js";
import { StonService } from "./services/ston.js";
import { PostgresStore } from "./store/postgres.js";

const config = getConfig();
const store = new PostgresStore(config.DATABASE_URL);
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
const poolTimer = setInterval(refreshPoolsSafely, 15 * 60_000);
poolTimer.unref();

const shutdown = async () => {
  clearInterval(jobTimer);
  clearInterval(poolTimer);
  await app.close();
  await store.close();
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await app.listen({ host: config.HOST, port: config.PORT });
runJobsSafely();
refreshPoolsSafely();
