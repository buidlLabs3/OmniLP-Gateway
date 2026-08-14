import { randomUUID } from "node:crypto";

import {
  AppError,
  assertState,
  createFlowSchema,
  flowSchema,
  poolSchema,
  type CreateFlow,
  type Flow,
  type FlowEvent,
  type FlowState,
  type Pool,
  type Quote,
  type DepositPlan,
  quoteSchema,
  depositPlanSchema,
} from "@omnilp/shared";
import pg, { type PoolClient, type QueryResultRow } from "pg";

import type {
  IdempotencyRecord,
  JobRecord,
  PositionRecord,
  Store,
  TransactionRecord,
  WalletChallenge,
} from "./types.js";

const { Pool: PgPool } = pg;

interface FlowRow extends QueryResultRow {
  id: string;
  type: "entry" | "exit";
  state: FlowState;
  pool_id: string;
  base_wallet: string;
  ton_wallet: string;
  source_units: string;
  created_at: Date;
  updated_at: Date;
  version: number;
}

interface QuoteRow extends QueryResultRow {
  flow_id: string;
  direction: "entry" | "exit";
  provider_id: string;
  resolver_id: string;
  input_units: string;
  output_units: string;
  protocol_fee_units: string;
  integrator_fee_units: string;
  source_protocol_address: string;
  destination_protocol_address: string;
  quoted_at: Date;
  expires_at: Date;
  raw_hash: string;
}

function mapFlow(row: FlowRow): Flow {
  return flowSchema.parse({
    id: row.id,
    type: row.type,
    state: row.state,
    poolId: row.pool_id,
    baseWallet: row.base_wallet,
    tonWallet: row.ton_wallet,
    sourceUnits: row.source_units,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    version: row.version,
  });
}

function mapQuote(row: QuoteRow): Quote {
  return quoteSchema.parse({
    id: row.provider_id,
    flowId: row.flow_id,
    direction: row.direction,
    resolverId: row.resolver_id,
    inputUnits: row.input_units,
    outputUnits: row.output_units,
    protocolFeeUnits: row.protocol_fee_units,
    integratorFeeUnits: row.integrator_fee_units,
    sourceProtocolAddress: row.source_protocol_address,
    destinationProtocolAddress: row.destination_protocol_address,
    quotedAt: row.quoted_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  });
}

async function transaction<T>(
  pool: pg.Pool,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export class PostgresStore implements Store {
  readonly pool: pg.Pool;

  constructor(url: string) {
    this.pool = new PgPool({
      connectionString: url,
      max: 10,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 15_000,
      application_name: "omnilp-server",
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async health(): Promise<boolean> {
    const result = await this.pool.query<{ ok: number }>("SELECT 1 AS ok");
    return result.rows[0]?.ok === 1;
  }

  async listPools(): Promise<Pool[]> {
    const result = await this.pool.query<{ data: unknown }>(
      "SELECT data FROM pool ORDER BY enabled DESC, id ASC",
    );
    return result.rows.map((row) => poolSchema.parse(row.data));
  }

  async getPool(id: string): Promise<Pool | null> {
    const result = await this.pool.query<{ data: unknown }>(
      "SELECT data FROM pool WHERE id = $1",
      [id],
    );
    return result.rows[0] ? poolSchema.parse(result.rows[0].data) : null;
  }

  async savePools(pools: Pool[]): Promise<void> {
    await transaction(this.pool, async (client) => {
      for (const item of pools) {
        const pool = poolSchema.parse(item);
        await client.query(
          `INSERT INTO pool (
             id, address, router_address, token0_address, token1_address,
             entry_mode, enabled, data, checked_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (id) DO UPDATE SET
             address = EXCLUDED.address,
             router_address = EXCLUDED.router_address,
             token0_address = EXCLUDED.token0_address,
             token1_address = EXCLUDED.token1_address,
             entry_mode = EXCLUDED.entry_mode,
             enabled = EXCLUDED.enabled,
             data = EXCLUDED.data,
             checked_at = EXCLUDED.checked_at`,
          [
            pool.id,
            pool.address,
            pool.routerAddress,
            pool.token0.address,
            pool.token1.address,
            pool.entryMode,
            pool.enabled,
            JSON.stringify(pool),
            pool.checkedAt,
          ],
        );
      }
    });
  }

  async saveQuote(quote: Quote, rawHash: string): Promise<Quote> {
    const value = quoteSchema.parse(quote);
    if (!/^[0-9a-f]{64}$/.test(rawHash)) {
      throw new AppError("QUOTE_INVALID", "Quote hash is invalid", 502);
    }
    const inserted = await this.pool.query<QuoteRow>(
      `INSERT INTO quote (
         id, flow_id, provider_id, resolver_id, direction, input_units, output_units,
         protocol_fee_units, integrator_fee_units, source_protocol_address,
         destination_protocol_address, quoted_at, expires_at, raw_hash
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (flow_id, provider_id) DO NOTHING
       RETURNING *`,
      [
        randomUUID(),
        value.flowId,
        value.id,
        value.resolverId,
        value.direction,
        value.inputUnits,
        value.outputUnits,
        value.protocolFeeUnits,
        value.integratorFeeUnits,
        value.sourceProtocolAddress,
        value.destinationProtocolAddress,
        value.quotedAt,
        value.expiresAt,
        rawHash,
      ],
    );
    const saved = inserted.rows[0];
    if (saved) return mapQuote(saved);
    const existing = await this.pool.query<QuoteRow>(
      "SELECT * FROM quote WHERE flow_id = $1 AND provider_id = $2",
      [value.flowId, value.id],
    );
    const current = existing.rows[0];
    if (!current || current.raw_hash !== rawHash) {
      throw new AppError(
        "QUOTE_INVALID",
        "Quote ID was reused with different data",
        502,
      );
    }
    return mapQuote(current);
  }

  async getQuote(flowId: string): Promise<Quote | null> {
    const result = await this.pool.query<QuoteRow>(
      "SELECT * FROM quote WHERE flow_id = $1 ORDER BY quoted_at DESC LIMIT 1",
      [flowId],
    );
    const row = result.rows[0];
    return row ? mapQuote(row) : null;
  }

  async savePlan(plan: DepositPlan): Promise<DepositPlan> {
    const value = depositPlanSchema.parse(plan);
    await this.pool.query(
      `INSERT INTO deposit_plan (
         id, flow_id, pool_id, mode, input_units, token0_units, token1_units,
         min_lp_units, lp_units_before, gas_units, price_impact_pips, indicative, router_address, expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        value.id,
        value.flowId,
        value.poolId,
        value.mode,
        value.inputUnits,
        value.token0Units,
        value.token1Units,
        value.minLpUnits,
        value.lpUnitsBefore,
        value.gasUnits,
        value.priceImpactPips,
        value.indicative,
        value.routerAddress,
        value.expiresAt,
      ],
    );
    return value;
  }

  async getPlan(flowId: string): Promise<DepositPlan | null> {
    const result = await this.pool.query<{
      id: string;
      flow_id: string;
      pool_id: string;
      mode: "single" | "balanced";
      input_units: string;
      token0_units: string;
      token1_units: string;
      min_lp_units: string;
      lp_units_before: string;
      gas_units: string;
      price_impact_pips: number;
      indicative: boolean;
      router_address: string;
      expires_at: Date;
    }>(
      "SELECT * FROM deposit_plan WHERE flow_id = $1 ORDER BY created_at DESC LIMIT 1",
      [flowId],
    );
    const row = result.rows[0];
    return row
      ? depositPlanSchema.parse({
          id: row.id,
          flowId: row.flow_id,
          poolId: row.pool_id,
          mode: row.mode,
          inputUnits: row.input_units,
          token0Units: row.token0_units,
          token1Units: row.token1_units,
          minLpUnits: row.min_lp_units,
          lpUnitsBefore: row.lp_units_before,
          gasUnits: row.gas_units,
          priceImpactPips: row.price_impact_pips,
          indicative: row.indicative,
          routerAddress: row.router_address,
          expiresAt: row.expires_at.toISOString(),
        })
      : null;
  }

  async createFlow(input: CreateFlow): Promise<Flow> {
    const value = createFlowSchema.parse(input);
    const id = randomUUID();
    const eventId = randomUUID();
    const state = value.type === "entry" ? "draft" : "exit_draft";
    return transaction(this.pool, async (client) => {
      const result = await client.query<FlowRow>(
        `INSERT INTO flow (
           id, type, state, pool_id, base_wallet, ton_wallet, source_units
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING *`,
        [
          id,
          value.type,
          state,
          value.poolId,
          value.baseWallet,
          value.tonWallet,
          value.sourceUnits,
        ],
      );
      await client.query(
        `INSERT INTO flow_event (id, flow_id, prior_state, next_state, reference)
         VALUES ($1,$2,NULL,$3,'flow_created')`,
        [eventId, id, state],
      );
      const row = result.rows[0];
      if (!row)
        throw new AppError(
          "INTERNAL_ERROR",
          "Flow insert returned no row",
          500,
        );
      return mapFlow(row);
    });
  }

  async listFlows(): Promise<Flow[]> {
    const result = await this.pool.query<FlowRow>(
      "SELECT * FROM flow ORDER BY created_at DESC",
    );
    return result.rows.map(mapFlow);
  }

  async getFlow(id: string): Promise<Flow | null> {
    const result = await this.pool.query<FlowRow>(
      "SELECT * FROM flow WHERE id = $1",
      [id],
    );
    return result.rows[0] ? mapFlow(result.rows[0]) : null;
  }

  async listEvents(flowId: string): Promise<FlowEvent[]> {
    const result = await this.pool.query<{
      id: string;
      flow_id: string;
      prior_state: FlowState | null;
      next_state: FlowState;
      reference: string;
      created_at: Date;
    }>(
      `SELECT id, flow_id, prior_state, next_state, reference, created_at
       FROM flow_event WHERE flow_id = $1 ORDER BY created_at, id`,
      [flowId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      flowId: row.flow_id,
      priorState: row.prior_state,
      nextState: row.next_state,
      reference: row.reference,
      createdAt: row.created_at.toISOString(),
    }));
  }

  async setState(
    flowId: string,
    next: FlowState,
    reference: string,
    version: number,
  ): Promise<Flow> {
    return transaction(this.pool, async (client) => {
      const selected = await client.query<FlowRow>(
        "SELECT * FROM flow WHERE id = $1 FOR UPDATE",
        [flowId],
      );
      const current = selected.rows[0];
      if (!current) throw new AppError("NOT_FOUND", "Flow not found", 404);
      if (current.version !== version) {
        throw new AppError(
          "CONFLICT",
          "Flow changed; reload before continuing",
          409,
          true,
        );
      }
      assertState(current.state, next);
      const updated = await client.query<FlowRow>(
        `UPDATE flow SET state = $2, version = version + 1, updated_at = now()
         WHERE id = $1 AND version = $3 RETURNING *`,
        [flowId, next, version],
      );
      const row = updated.rows[0];
      if (!row)
        throw new AppError(
          "CONFLICT",
          "Flow changed; reload before continuing",
          409,
          true,
        );
      await client.query(
        `INSERT INTO flow_event (id, flow_id, prior_state, next_state, reference)
         VALUES ($1,$2,$3,$4,$5)`,
        [randomUUID(), flowId, current.state, next, reference],
      );
      return mapFlow(row);
    });
  }

  async getIdempotency(
    scope: string,
    key: string,
  ): Promise<IdempotencyRecord | null> {
    const result = await this.pool.query<{
      request_hash: string;
      status: number;
      response: unknown;
    }>(
      `SELECT request_hash, status, response FROM idempotency
       WHERE scope = $1 AND key = $2 AND expires_at > now()`,
      [scope, key],
    );
    const row = result.rows[0];
    return row
      ? { hash: row.request_hash, status: row.status, response: row.response }
      : null;
  }

  async reserveIdempotency(
    scope: string,
    key: string,
    hash: string,
  ): Promise<IdempotencyRecord | null> {
    const inserted = await this.pool.query(
      `INSERT INTO idempotency (scope, key, request_hash, status, response, expires_at)
       VALUES ($1,$2,$3,102,NULL,now() + interval '24 hours')
       ON CONFLICT (scope, key) DO UPDATE SET
         request_hash = EXCLUDED.request_hash,
         status = EXCLUDED.status,
         response = EXCLUDED.response,
         expires_at = EXCLUDED.expires_at
       WHERE idempotency.expires_at <= now()
       RETURNING scope`,
      [scope, key, hash],
    );
    if ((inserted.rowCount ?? 0) > 0) return null;
    const current = await this.getIdempotency(scope, key);
    if (!current) {
      throw new AppError(
        "CONFLICT",
        "Idempotency reservation changed; retry the request",
        409,
        true,
      );
    }
    return current;
  }

  async saveIdempotency(
    scope: string,
    key: string,
    hash: string,
    status: number,
    response: unknown,
  ): Promise<void> {
    const result = await this.pool.query(
      `UPDATE idempotency SET status = $4, response = $5, expires_at = now() + interval '24 hours'
       WHERE scope = $1 AND key = $2 AND request_hash = $3`,
      [scope, key, hash, status, JSON.stringify(response)],
    );
    if (result.rowCount === 0) {
      const current = await this.getIdempotency(scope, key);
      if (current?.hash !== hash)
        throw new AppError(
          "CONFLICT",
          "Idempotency key was used for different input",
          409,
        );
      throw new AppError(
        "CONFLICT",
        "Idempotency reservation expired; retry the request",
        409,
        true,
      );
    }
  }

  async clearIdempotency(
    scope: string,
    key: string,
    hash: string,
  ): Promise<void> {
    await this.pool.query(
      `DELETE FROM idempotency
       WHERE scope = $1 AND key = $2 AND request_hash = $3 AND status = 102`,
      [scope, key, hash],
    );
  }

  async saveTransaction(
    input: Omit<TransactionRecord, "id">,
  ): Promise<TransactionRecord> {
    const result = await this.pool.query<{
      id: string;
      flow_id: string;
      kind: TransactionRecord["kind"];
      chain: TransactionRecord["chain"];
      tx_hash: string;
      status: TransactionRecord["status"];
      attempt: number;
      confirmed_at: Date | null;
    }>(
      `INSERT INTO flow_transaction (
         id, flow_id, kind, chain, tx_hash, status, attempt, confirmed_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (chain, tx_hash) DO NOTHING
       RETURNING *`,
      [
        randomUUID(),
        input.flowId,
        input.kind,
        input.chain,
        input.hash,
        input.status,
        input.attempt,
        input.confirmedAt,
      ],
    );
    let row = result.rows[0];
    if (!row) {
      const current = await this.pool.query<{
        id: string;
        flow_id: string;
        kind: TransactionRecord["kind"];
        chain: TransactionRecord["chain"];
        tx_hash: string;
        status: TransactionRecord["status"];
        attempt: number;
        confirmed_at: Date | null;
      }>("SELECT * FROM flow_transaction WHERE chain = $1 AND tx_hash = $2", [
        input.chain,
        input.hash,
      ]);
      row = current.rows[0];
      if (
        !row ||
        row.flow_id !== input.flowId ||
        row.kind !== input.kind ||
        row.attempt !== input.attempt
      ) {
        throw new AppError(
          "CONFLICT",
          "Transaction reference is already assigned",
          409,
        );
      }
    }
    return {
      id: row.id,
      flowId: row.flow_id,
      kind: row.kind,
      chain: row.chain,
      hash: row.tx_hash,
      status: row.status,
      attempt: row.attempt,
      confirmedAt: row.confirmed_at?.toISOString() ?? null,
    };
  }

  async submitTransaction(
    input: Omit<TransactionRecord, "id">,
    next: FlowState,
    version: number,
  ): Promise<{ flow: Flow; transaction: TransactionRecord }> {
    return transaction(this.pool, async (client) => {
      const existing = await client.query<{
        id: string;
        flow_id: string;
        kind: TransactionRecord["kind"];
        chain: TransactionRecord["chain"];
        tx_hash: string;
        status: TransactionRecord["status"];
        attempt: number;
        confirmed_at: Date | null;
      }>("SELECT * FROM flow_transaction WHERE chain = $1 AND tx_hash = $2", [
        input.chain,
        input.hash,
      ]);
      const prior = existing.rows[0];
      if (prior) {
        if (
          prior.flow_id !== input.flowId ||
          prior.kind !== input.kind ||
          prior.attempt !== input.attempt
        ) {
          throw new AppError(
            "CONFLICT",
            "Transaction reference is already assigned",
            409,
          );
        }
        const flowResult = await client.query<FlowRow>(
          "SELECT * FROM flow WHERE id = $1",
          [input.flowId],
        );
        const currentFlow = flowResult.rows[0];
        if (!currentFlow)
          throw new AppError("NOT_FOUND", "Flow not found", 404);
        return {
          flow: mapFlow(currentFlow),
          transaction: {
            id: prior.id,
            flowId: prior.flow_id,
            kind: prior.kind,
            chain: prior.chain,
            hash: prior.tx_hash,
            status: prior.status,
            attempt: prior.attempt,
            confirmedAt: prior.confirmed_at?.toISOString() ?? null,
          },
        };
      }

      const selected = await client.query<FlowRow>(
        "SELECT * FROM flow WHERE id = $1 FOR UPDATE",
        [input.flowId],
      );
      const current = selected.rows[0];
      if (!current) throw new AppError("NOT_FOUND", "Flow not found", 404);
      if (current.version !== version) {
        throw new AppError(
          "CONFLICT",
          "Flow changed; reload before continuing",
          409,
          true,
        );
      }
      assertState(current.state, next);
      const duplicateAttempt = await client.query(
        `SELECT id FROM flow_transaction
         WHERE flow_id = $1 AND kind = $2 AND attempt = $3`,
        [input.flowId, input.kind, input.attempt],
      );
      if ((duplicateAttempt.rowCount ?? 0) > 0) {
        throw new AppError(
          "CONFLICT",
          "Transaction attempt already has a reference",
          409,
        );
      }

      const id = randomUUID();
      const inserted = await client.query<{
        id: string;
        flow_id: string;
        kind: TransactionRecord["kind"];
        chain: TransactionRecord["chain"];
        tx_hash: string;
        status: TransactionRecord["status"];
        attempt: number;
        confirmed_at: Date | null;
      }>(
        `INSERT INTO flow_transaction (
           id, flow_id, kind, chain, tx_hash, status, attempt, confirmed_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [
          id,
          input.flowId,
          input.kind,
          input.chain,
          input.hash,
          input.status,
          input.attempt,
          input.confirmedAt,
        ],
      );
      const updated = await client.query<FlowRow>(
        `UPDATE flow SET state = $2, version = version + 1, updated_at = now()
         WHERE id = $1 AND version = $3 RETURNING *`,
        [input.flowId, next, version],
      );
      const flowRow = updated.rows[0];
      const transactionRow = inserted.rows[0];
      if (!flowRow || !transactionRow) {
        throw new AppError(
          "CONFLICT",
          "Flow changed; reload before continuing",
          409,
          true,
        );
      }
      await client.query(
        `INSERT INTO flow_event (id, flow_id, prior_state, next_state, reference)
         VALUES ($1,$2,$3,$4,$5)`,
        [randomUUID(), input.flowId, current.state, next, `transaction:${id}`],
      );
      await client.query(
        `INSERT INTO job (id, job_key, type, payload, run_at)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (job_key) DO NOTHING`,
        [
          randomUUID(),
          `verify:${input.chain}:${input.hash}`,
          "verify_transaction",
          JSON.stringify({ flowId: input.flowId, transactionId: id }),
          new Date().toISOString(),
        ],
      );
      return {
        flow: mapFlow(flowRow),
        transaction: {
          id: transactionRow.id,
          flowId: transactionRow.flow_id,
          kind: transactionRow.kind,
          chain: transactionRow.chain,
          hash: transactionRow.tx_hash,
          status: transactionRow.status,
          attempt: transactionRow.attempt,
          confirmedAt: transactionRow.confirmed_at?.toISOString() ?? null,
        },
      };
    });
  }

  async getTransaction(id: string): Promise<TransactionRecord | null> {
    const result = await this.pool.query<{
      id: string;
      flow_id: string;
      kind: TransactionRecord["kind"];
      chain: TransactionRecord["chain"];
      tx_hash: string;
      status: TransactionRecord["status"];
      attempt: number;
      confirmed_at: Date | null;
    }>("SELECT * FROM flow_transaction WHERE id = $1", [id]);
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          flowId: row.flow_id,
          kind: row.kind,
          chain: row.chain,
          hash: row.tx_hash,
          status: row.status,
          attempt: row.attempt,
          confirmedAt: row.confirmed_at?.toISOString() ?? null,
        }
      : null;
  }

  async setTransactionStatus(
    id: string,
    status: TransactionRecord["status"],
    confirmedAt: string | null,
  ): Promise<TransactionRecord> {
    const result = await this.pool.query<{
      id: string;
      flow_id: string;
      kind: TransactionRecord["kind"];
      chain: TransactionRecord["chain"];
      tx_hash: string;
      status: TransactionRecord["status"];
      attempt: number;
      confirmed_at: Date | null;
    }>(
      `UPDATE flow_transaction SET status = $2, confirmed_at = $3
       WHERE id = $1 RETURNING *`,
      [id, status, confirmedAt],
    );
    const row = result.rows[0];
    if (!row) throw new AppError("NOT_FOUND", "Transaction not found", 404);
    return {
      id: row.id,
      flowId: row.flow_id,
      kind: row.kind,
      chain: row.chain,
      hash: row.tx_hash,
      status: row.status,
      attempt: row.attempt,
      confirmedAt: row.confirmed_at?.toISOString() ?? null,
    };
  }

  async finishTransaction(
    id: string,
    status: "confirmed" | "failed",
    next: FlowState,
    version: number,
    reference: string,
    position?: Omit<PositionRecord, "id">,
  ): Promise<Flow> {
    return transaction(this.pool, async (client) => {
      const transactionResult = await client.query<{
        id: string;
        flow_id: string;
        status: TransactionRecord["status"];
      }>(
        "SELECT id, flow_id, status FROM flow_transaction WHERE id = $1 FOR UPDATE",
        [id],
      );
      const savedTransaction = transactionResult.rows[0];
      if (!savedTransaction)
        throw new AppError("NOT_FOUND", "Transaction not found", 404);
      if (savedTransaction.status !== "pending") {
        throw new AppError("CONFLICT", "Transaction was already verified", 409);
      }
      const flowResult = await client.query<FlowRow>(
        "SELECT * FROM flow WHERE id = $1 FOR UPDATE",
        [savedTransaction.flow_id],
      );
      const current = flowResult.rows[0];
      if (!current) throw new AppError("NOT_FOUND", "Flow not found", 404);
      if (current.version !== version) {
        throw new AppError(
          "CONFLICT",
          "Flow changed; reload before continuing",
          409,
          true,
        );
      }
      assertState(current.state, next);
      const now = new Date().toISOString();
      await client.query(
        `UPDATE flow_transaction SET status = $2, confirmed_at = $3 WHERE id = $1`,
        [id, status, status === "confirmed" ? now : null],
      );
      const updated = await client.query<FlowRow>(
        `UPDATE flow SET state = $2, version = version + 1, updated_at = now()
         WHERE id = $1 AND version = $3 RETURNING *`,
        [current.id, next, version],
      );
      const row = updated.rows[0];
      if (!row)
        throw new AppError(
          "CONFLICT",
          "Flow changed; reload before continuing",
          409,
          true,
        );
      await client.query(
        `INSERT INTO flow_event (id, flow_id, prior_state, next_state, reference)
         VALUES ($1,$2,$3,$4,$5)`,
        [randomUUID(), current.id, current.state, next, reference],
      );
      if (position) {
        await client.query(
          `INSERT INTO position (
             id, flow_id, wallet, pool_id, lp_units, entry_value_usd_units,
             proof_reference, opened_at, closed_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            randomUUID(),
            position.flowId,
            position.wallet,
            position.poolId,
            position.lpUnits,
            position.entryValueUsdUnits,
            position.proofReference,
            position.openedAt,
            position.closedAt,
          ],
        );
      }
      return mapFlow(row);
    });
  }

  async listTransactions(flowId: string): Promise<TransactionRecord[]> {
    const result = await this.pool.query<{
      id: string;
      flow_id: string;
      kind: TransactionRecord["kind"];
      chain: TransactionRecord["chain"];
      tx_hash: string;
      status: TransactionRecord["status"];
      attempt: number;
      confirmed_at: Date | null;
    }>(
      "SELECT * FROM flow_transaction WHERE flow_id = $1 ORDER BY kind, attempt",
      [flowId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      flowId: row.flow_id,
      kind: row.kind,
      chain: row.chain,
      hash: row.tx_hash,
      status: row.status,
      attempt: row.attempt,
      confirmedAt: row.confirmed_at?.toISOString() ?? null,
    }));
  }

  async saveChallenge(
    input: Omit<WalletChallenge, "id" | "usedAt">,
  ): Promise<WalletChallenge> {
    const result = await this.pool.query<{
      id: string;
      flow_id: string;
      chain: WalletChallenge["chain"];
      wallet: string;
      nonce_hash: string;
      expires_at: Date;
      used_at: Date | null;
    }>(
      `INSERT INTO wallet_challenge (id, flow_id, chain, wallet, nonce_hash, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [
        randomUUID(),
        input.flowId,
        input.chain,
        input.wallet,
        input.valueHash,
        input.expiresAt,
      ],
    );
    const row = result.rows[0];
    if (!row)
      throw new AppError(
        "INTERNAL_ERROR",
        "Challenge insert returned no row",
        500,
      );
    return {
      id: row.id,
      flowId: row.flow_id,
      chain: row.chain,
      wallet: row.wallet,
      valueHash: row.nonce_hash,
      expiresAt: row.expires_at.toISOString(),
      usedAt: row.used_at?.toISOString() ?? null,
    };
  }

  async useChallenge(
    flowId: string,
    chain: WalletChallenge["chain"],
    wallet: string,
    valueHash: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE wallet_challenge SET used_at = now()
       WHERE id = (
         SELECT id FROM wallet_challenge
         WHERE flow_id = $1 AND chain = $2 AND wallet = $3 AND nonce_hash = $4
           AND used_at IS NULL AND expires_at > now()
         ORDER BY expires_at DESC LIMIT 1 FOR UPDATE SKIP LOCKED
       )`,
      [flowId, chain, wallet, valueHash],
    );
    return result.rowCount === 1;
  }

  async hasWalletProofs(flowId: string): Promise<boolean> {
    const result = await this.pool.query<{ chain: "base" | "ton" }>(
      `SELECT DISTINCT challenge.chain
       FROM wallet_challenge challenge
       JOIN flow ON flow.id = challenge.flow_id
       WHERE challenge.flow_id = $1 AND challenge.used_at IS NOT NULL
         AND ((challenge.chain = 'base' AND lower(challenge.wallet) = lower(flow.base_wallet))
           OR (challenge.chain = 'ton' AND challenge.wallet = flow.ton_wallet))`,
      [flowId],
    );
    return new Set(result.rows.map((row) => row.chain)).size === 2;
  }

  async savePosition(
    input: Omit<PositionRecord, "id">,
  ): Promise<PositionRecord> {
    const result = await this.pool.query<{
      id: string;
      flow_id: string;
      wallet: string;
      pool_id: string;
      lp_units: string;
      entry_value_usd_units: string;
      proof_reference: string;
      opened_at: Date;
      closed_at: Date | null;
    }>(
      `INSERT INTO position (
         id, flow_id, wallet, pool_id, lp_units, entry_value_usd_units,
         proof_reference, opened_at, closed_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        randomUUID(),
        input.flowId,
        input.wallet,
        input.poolId,
        input.lpUnits,
        input.entryValueUsdUnits,
        input.proofReference,
        input.openedAt,
        input.closedAt,
      ],
    );
    let row = result.rows[0];
    if (!row) {
      const current = await this.pool.query<{
        id: string;
        flow_id: string;
        wallet: string;
        pool_id: string;
        lp_units: string;
        entry_value_usd_units: string;
        proof_reference: string;
        opened_at: Date;
        closed_at: Date | null;
      }>("SELECT * FROM position WHERE flow_id = $1 OR proof_reference = $2", [
        input.flowId,
        input.proofReference,
      ]);
      row = current.rows[0];
      if (
        !row ||
        row.flow_id !== input.flowId ||
        row.proof_reference !== input.proofReference ||
        row.wallet !== input.wallet ||
        row.pool_id !== input.poolId ||
        row.lp_units !== input.lpUnits
      ) {
        throw new AppError(
          "CONFLICT",
          "Position proof is already assigned",
          409,
        );
      }
    }
    return {
      id: row.id,
      flowId: row.flow_id,
      wallet: row.wallet,
      poolId: row.pool_id,
      lpUnits: row.lp_units,
      entryValueUsdUnits: row.entry_value_usd_units,
      proofReference: row.proof_reference,
      openedAt: row.opened_at.toISOString(),
      closedAt: row.closed_at?.toISOString() ?? null,
    };
  }

  async listPositions(wallet?: string): Promise<PositionRecord[]> {
    const result = await this.pool.query<{
      id: string;
      flow_id: string;
      wallet: string;
      pool_id: string;
      lp_units: string;
      entry_value_usd_units: string;
      proof_reference: string;
      opened_at: Date;
      closed_at: Date | null;
    }>(
      wallet
        ? "SELECT * FROM position WHERE wallet = $1 ORDER BY opened_at DESC"
        : "SELECT * FROM position ORDER BY opened_at DESC",
      wallet ? [wallet] : [],
    );
    return result.rows.map((row) => ({
      id: row.id,
      flowId: row.flow_id,
      wallet: row.wallet,
      poolId: row.pool_id,
      lpUnits: row.lp_units,
      entryValueUsdUnits: row.entry_value_usd_units,
      proofReference: row.proof_reference,
      openedAt: row.opened_at.toISOString(),
      closedAt: row.closed_at?.toISOString() ?? null,
    }));
  }

  async addJob(
    key: string,
    type: string,
    payload: unknown,
    runAt: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO job (id, job_key, type, payload, run_at)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (job_key) DO NOTHING`,
      [randomUUID(), key, type, JSON.stringify(payload), runAt],
    );
  }

  async claimJobs(worker: string, limit: number): Promise<JobRecord[]> {
    const result = await this.pool.query<{
      id: string;
      job_key: string;
      type: string;
      payload: unknown;
      run_at: Date;
      attempts: number;
    }>(
      `WITH selected AS (
         SELECT id FROM job
         WHERE run_at <= now() AND (locked_at IS NULL OR locked_at < now() - interval '2 minutes')
         ORDER BY run_at
         FOR UPDATE SKIP LOCKED
         LIMIT $2
       )
       UPDATE job SET locked_at = now(), locked_by = $1, attempts = attempts + 1
       WHERE id IN (SELECT id FROM selected)
       RETURNING id, job_key, type, payload, run_at, attempts`,
      [worker, limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      key: row.job_key,
      type: row.type,
      payload: row.payload,
      runAt: row.run_at.toISOString(),
      attempts: row.attempts,
    }));
  }

  async finishJob(id: string): Promise<void> {
    await this.pool.query("DELETE FROM job WHERE id = $1", [id]);
  }

  async failJob(id: string, error: string, nextRunAt: string): Promise<void> {
    await this.pool.query(
      `UPDATE job SET locked_at = NULL, locked_by = NULL, last_error = $2, run_at = $3
       WHERE id = $1`,
      [id, error.slice(0, 500), nextRunAt],
    );
  }
}
