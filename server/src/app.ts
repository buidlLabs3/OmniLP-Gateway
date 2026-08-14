import { randomUUID } from "node:crypto";

import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import {
  AppError,
  createFlowSchema,
  getNextActions,
  isExpired,
  tonHashSchema,
  transactionReferenceSchema,
} from "@omnilp/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { z, ZodError } from "zod";

import type { Config } from "./config.js";
import { AuthService } from "./services/auth.js";
import { getImpact } from "./services/impact.js";
import { idempotent } from "./services/idempotency.js";
import { OmniService } from "./services/omni.js";
import { StonService } from "./services/ston.js";
import { TelegramService } from "./services/telegram.js";
import type { Store } from "./store/types.js";

const idSchema = z.object({ id: z.string().uuid() });
const poolIdSchema = z.object({ id: z.string().regex(/^[a-z0-9-]+$/) });
const challengeSchema = z.object({ chain: z.enum(["base", "ton"]) }).strict();

function safeFlow(flow: Awaited<ReturnType<Store["getFlow"]>>) {
  if (!flow) return null;
  return {
    id: flow.id,
    type: flow.type,
    state: flow.state,
    poolId: flow.poolId,
    sourceUnits: flow.sourceUnits,
    createdAt: flow.createdAt,
    updatedAt: flow.updatedAt,
    version: flow.version,
    nextActions: getNextActions(flow.state),
  };
}

function transactionKind(
  path: string,
): "source" | "deposit" | "withdraw" | "exit" {
  if (path.endsWith("/source")) return "source";
  if (path.endsWith("/deposit")) return "deposit";
  if (path.endsWith("/withdraw")) return "withdraw";
  return "exit";
}

export interface AppOptions {
  config: Config;
  store: Store;
  omni?: OmniService;
  ston?: StonService;
  auth?: AuthService;
  telegram?: TelegramService;
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const { config, store } = options;
  const omni = options.omni ?? new OmniService(config);
  const ston = options.ston ?? new StonService(config);
  const auth = options.auth ?? new AuthService(config, store);
  const telegram = options.telegram ?? new TelegramService(config);
  const app = Fastify({
    bodyLimit: 64 * 1024,
    genReqId: () => randomUUID(),
    logger: {
      level: config.NODE_ENV === "test" ? "silent" : "info",
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers.x-telegram-session",
        "req.body.initData",
        "req.body.signature",
        "req.body.typedData",
        "res.headers.set-cookie",
      ],
    },
    requestTimeout: 20_000,
  });

  await app.register(cors, {
    origin: config.WEB_ORIGIN,
    methods: ["GET", "POST"],
    allowedHeaders: [
      "Content-Type",
      "Idempotency-Key",
      "Authorization",
      "X-Telegram-Session",
    ],
    credentials: false,
  });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
    ban: 3,
    errorResponseBuilder: () => ({
      error: {
        code: "RATE_LIMITED",
        message: "Request limit reached",
        retryable: true,
      },
    }),
  });

  app.setErrorHandler((error, request, reply) => {
    const appError =
      error instanceof AppError
        ? error
        : error instanceof ZodError
          ? new AppError("BAD_REQUEST", "Request validation failed", 400)
          : new AppError("INTERNAL_ERROR", "Request failed", 500, true);
    request.log.error({ code: appError.code, err: error }, appError.message);
    return reply.status(appError.status).send({
      error: {
        code: appError.code,
        message: appError.message,
        retryable: appError.retryable,
        requestId: request.id,
      },
    });
  });

  app.get("/health", async (_request, reply) => {
    const database = await store.health().catch(() => false);
    return reply.status(database ? 200 : 503).send({
      status: database ? "ok" : "degraded",
      database,
      readOnly: config.READ_ONLY,
      checkedAt: new Date().toISOString(),
    });
  });

  app.post("/v1/telegram/session", (request) => telegram.start(request.body));

  app.get("/v1/pools", async () => ({ pools: await store.listPools() }));

  app.get("/v1/pools/:id", async (request) => {
    const { id } = poolIdSchema.parse(request.params);
    const pool = await store.getPool(id);
    if (!pool) throw new AppError("NOT_FOUND", "Pool not found", 404);
    return { pool };
  });

  app.post("/v1/flows", async (request, reply) => {
    telegram.verifySession(request.headers["x-telegram-session"]);
    const input = createFlowSchema.parse(request.body);
    const result = await idempotent(
      store,
      "create-flow",
      request.headers["idempotency-key"] as string | undefined,
      input,
      async () => {
        const pool = await store.getPool(input.poolId);
        if (!pool) throw new AppError("NOT_FOUND", "Pool not found", 404);
        if (!pool.enabled)
          throw new AppError("POOL_DISABLED", "Pool is not enabled", 409);
        if (
          BigInt(input.sourceUnits) < BigInt(config.MIN_SOURCE_UNITS) ||
          BigInt(input.sourceUnits) > BigInt(config.MAX_SOURCE_UNITS)
        ) {
          throw new AppError(
            "BAD_REQUEST",
            "Source amount is outside the enabled range",
            400,
          );
        }
        return store.createFlow(input);
      },
    );
    return reply.status(result.status).send({ flow: safeFlow(result.value) });
  });

  app.get("/v1/flows/:id", async (request) => {
    const { id } = idSchema.parse(request.params);
    auth.verifySession(id, request.headers.authorization);
    const flow = await store.getFlow(id);
    if (!flow) throw new AppError("NOT_FOUND", "Flow not found", 404);
    const [events, transactions] = await Promise.all([
      store.listEvents(id),
      store.listTransactions(id),
    ]);
    return { flow: safeFlow(flow), events, transactions };
  });

  app.get("/v1/flows/:id/status", async (request) => {
    const { id } = idSchema.parse(request.params);
    const flow = await store.getFlow(id);
    if (!flow) throw new AppError("NOT_FOUND", "Flow not found", 404);
    return { flow: safeFlow(flow) };
  });

  app.post("/v1/flows/:id/auth/challenge", async (request) => {
    const { id } = idSchema.parse(request.params);
    const { chain } = challengeSchema.parse(request.body);
    return { challenge: await auth.createChallenge(id, chain) };
  });

  app.post("/v1/flows/:id/auth/base", async (request) => {
    const { id } = idSchema.parse(request.params);
    await auth.verifyBase(id, request.body);
    return {
      verified: true,
      chain: "base",
      token: (await store.hasWalletProofs(id))
        ? await auth.issueSession(id)
        : null,
    };
  });

  app.post("/v1/flows/:id/auth/ton", async (request) => {
    const { id } = idSchema.parse(request.params);
    await auth.verifyTon(id, request.body);
    return {
      verified: true,
      chain: "ton",
      token: (await store.hasWalletProofs(id))
        ? await auth.issueSession(id)
        : null,
    };
  });

  app.post("/v1/flows/:id/quote", async (request) => {
    const { id } = idSchema.parse(request.params);
    auth.verifySession(id, request.headers.authorization);
    const result = await idempotent(
      store,
      `quote:${id}`,
      request.headers["idempotency-key"] as string | undefined,
      { flowId: id },
      async () => {
        const flow = await store.getFlow(id);
        if (!flow) throw new AppError("NOT_FOUND", "Flow not found", 404);
        if (
          !["draft", "quote_expired", "source_rejected"].includes(flow.state)
        ) {
          throw new AppError(
            "CONFLICT",
            "Flow is not ready for a new quote",
            409,
          );
        }
        const { quote, hash } = await omni.getQuote(flow, "entry");
        await store.saveQuote(quote, hash);
        const updated = await store.setState(
          flow.id,
          "quoted",
          `quote:${quote.id}`,
          flow.version,
        );
        return { flow: safeFlow(updated), quote };
      },
    );
    return result.value;
  });

  app.post("/v1/flows/:id/exit-quote", async (request) => {
    const { id } = idSchema.parse(request.params);
    auth.verifySession(id, request.headers.authorization);
    const result = await idempotent(
      store,
      `exit-quote:${id}`,
      request.headers["idempotency-key"] as string | undefined,
      { flowId: id },
      async () => {
        const flow = await store.getFlow(id);
        if (!flow) throw new AppError("NOT_FOUND", "Flow not found", 404);
        if (
          !["assets_received", "exit_quote_expired", "exit_failed"].includes(
            flow.state,
          )
        ) {
          throw new AppError(
            "CONFLICT",
            "Withdrawal assets are not verified",
            409,
          );
        }
        const { quote, hash } = await omni.getQuote(flow, "exit");
        await store.saveQuote(quote, hash);
        const updated = await store.setState(
          flow.id,
          "exit_quoted",
          `quote:${quote.id}`,
          flow.version,
        );
        return { flow: safeFlow(updated), quote };
      },
    );
    return result.value;
  });

  app.post("/v1/flows/:id/deposit-plan", async (request) => {
    const { id } = idSchema.parse(request.params);
    auth.verifySession(id, request.headers.authorization);
    const result = await idempotent(
      store,
      `deposit-plan:${id}`,
      request.headers["idempotency-key"] as string | undefined,
      { flowId: id },
      async () => {
        const flow = await store.getFlow(id);
        if (!flow) throw new AppError("NOT_FOUND", "Flow not found", 404);
        if (
          !["funds_received", "deposit_changed", "deposit_failed"].includes(
            flow.state,
          )
        ) {
          throw new AppError(
            "PROOF_REQUIRED",
            "Verified TON receipt is required",
            409,
          );
        }
        const pool = await store.getPool(flow.poolId);
        if (!pool) throw new AppError("NOT_FOUND", "Pool not found", 404);
        const plan = await ston.getPlan(flow, pool, flow.sourceUnits, false);
        await store.savePlan(plan);
        const updated = await store.setState(
          flow.id,
          "deposit_ready",
          `plan:${plan.id}`,
          flow.version,
        );
        return { flow: safeFlow(updated), plan };
      },
    );
    return result.value;
  });

  for (const path of [
    "/v1/flows/:id/source",
    "/v1/flows/:id/deposit",
    "/v1/flows/:id/withdraw",
    "/v1/flows/:id/exit",
  ]) {
    app.post(path, async (request) => {
      if (config.READ_ONLY) {
        throw new AppError(
          "READ_ONLY",
          "Value-moving routes are disabled",
          503,
        );
      }
      const { id } = idSchema.parse(request.params);
      auth.verifySession(id, request.headers.authorization);
      const input = transactionReferenceSchema.parse(request.body);
      const kind = transactionKind(request.routeOptions.url ?? path);
      if (kind === "source" || kind === "exit") {
        throw new AppError(
          "ROUTE_UNAVAILABLE",
          "Omniston order execution is not enabled",
          503,
        );
      }
      const chain = "ton" as const;
      const hash = tonHashSchema.parse(input.hash);
      const expected = {
        deposit: { state: "deposit_ready", next: "deposit_pending" },
        withdraw: { state: "withdraw_ready", next: "withdraw_pending" },
      } as const;
      const rule = expected[kind];
      const result = await idempotent(
        store,
        `transaction:${id}:${kind}`,
        request.headers["idempotency-key"] as string | undefined,
        { ...input, hash },
        async () => {
          const flow = await store.getFlow(id);
          if (!flow) throw new AppError("NOT_FOUND", "Flow not found", 404);
          if (flow.state !== rule.state) {
            throw new AppError(
              "CONFLICT",
              `${kind} reference is not allowed in this flow state`,
              409,
            );
          }
          if (kind === "deposit") {
            const plan = await store.getPlan(id);
            if (!plan || isExpired(plan.expiresAt)) {
              throw new AppError(
                "PLAN_CHANGED",
                "A current deposit plan is required",
                409,
              );
            }
          }
          return store.submitTransaction(
            {
              flowId: id,
              kind,
              chain,
              hash,
              status: "pending",
              attempt: input.attempt,
              confirmedAt: null,
            },
            rule.next,
            input.version,
          );
        },
      );
      return {
        flow: safeFlow(result.value.flow),
        transaction: result.value.transaction,
        message: "Submitted reference is pending independent verification",
      };
    });
  }

  app.get("/v1/positions", async (request) => {
    const query = z.object({ flowId: z.string().uuid() }).parse(request.query);
    auth.verifySession(query.flowId, request.headers.authorization);
    const flow = await store.getFlow(query.flowId);
    if (!flow) throw new AppError("NOT_FOUND", "Flow not found", 404);
    const positions = await store.listPositions(flow.tonWallet);
    return {
      positions: positions.filter((position) => position.flowId === flow.id),
    };
  });

  app.get("/v1/metrics", async () => {
    const [flows, positions] = await Promise.all([
      store.listFlows(),
      store.listPositions(),
    ]);
    const transactionLists = await Promise.all(
      flows.map((flow) => store.listTransactions(flow.id)),
    );
    return { impact: getImpact(flows, transactionLists.flat(), positions) };
  });

  return app;
}
