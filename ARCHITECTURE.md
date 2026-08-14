# Architecture

## 1. Purpose

This document defines the technical boundaries, source layout, state model, and data model for OmniLP Gateway.

The design optimizes for four properties:

1. user funds are never controlled by the application;
2. completed protocol actions can be verified independently;
3. interrupted cross-chain and LP flows can resume safely;
4. the first release remains small enough to build and audit.

The coordination foundation is built in read-only mode. Gate A still controls whether value execution may be enabled; scaffolding does not count as proof that the cross-chain path is safe.

## 2. System Boundary

OmniLP coordinates existing protocols. It does not replace them.

```text
Base wallet
    |
    | user-approved USDC allowance and signed EVM order
    v
Omniston route and resolvers
    |
    | Base USDC -> TON USDT settlement
    v
User TON wallet
    |
    | user-signed swap or liquidity transaction
    v
STON.fi V2 pool
    |
    | LP ownership
    v
User TON wallet
```

The target web application requests signatures and displays state. The current web surface creates review flows, connects an injected Base wallet, lists approved pools, and resumes public status; TON wallet authorization and transaction submission remain server-gated work. The server stores flow references, verifies supported evidence, and calculates aggregate metrics. Neither component has a key capable of moving user assets.

## 3. Trust Model

### Trusted for protocol execution

- deployed Omniston contracts and services selected for the route;
- the resolver that supplies the accepted quote;
- deployed STON.fi V2 contracts for the selected pools;
- the connected wallet applications;
- configured Base and TON RPC providers.

### Trusted for coordination only

- OmniLP web application;
- OmniLP server;
- OmniLP database.

A coordination failure may delay status updates or require the user to reopen a flow. It must not grant OmniLP control of funds.

### Never stored

- seed phrases;
- private keys;
- wallet session secrets not required by the wallet library;
- unsigned reusable approvals with unlimited scope;
- full personal profiles.

## 4. Non-Custodial Invariants

These rules are implementation requirements, not product copy:

1. Cross-chain destination is the connected TON wallet.
2. The connected Base wallet is the EVM order owner and controls source withdrawal.
3. STON.fi LP receiver is the connected TON wallet.
4. Withdrawal receiver is the connected TON wallet.
5. Exit destination is the connected Base wallet.
6. The server never creates or loads an asset-holding private key.
7. A transaction is complete only after protocol or chain verification.
8. An unavailable route stops the flow; it never falls back to project inventory.
9. Every address and amount shown for signing is derived from the active flow and revalidated.
10. Every value-moving step requires the user's wallet approval.

## 5. Source Layout

The repository uses a small pnpm workspace.

```text
OmniLP-Gateway/
  web/
    app/
    lib/
  server/
    src/
      services/
      store/
      app.ts
      jobs.ts
      index.ts
  shared/
    src/
      amount.ts
      flow.ts
      pool.ts
      quote.ts
      state.ts
  db/
    migrations/
  tests/
    e2e/
  package.json
  pnpm-workspace.yaml
  tsconfig.json
  README.md
  ARCHITECTURE.md
```

Directory names stay literal: `web`, `server`, `shared`, `db`, and `tests`. Avoid generic framework names such as `engine`, `orchestrator`, `manager`, or `processor` when a concrete domain name is available.

### Naming rules

- Functions use direct verbs: `getPools`, `getQuote`, `saveFlow`, `trackTrade`, `buildDeposit`, `checkPosition`.
- Variables use domain nouns: `flow`, `pool`, `quote`, `trade`, `deposit`, `wallet`, `amount`.
- Files are named after one domain concern: `quote.ts`, `flow.ts`, `pool.ts`, `trade.ts`.
- Boolean names answer a question: `isExpired`, `hasGas`, `canDeposit`.
- Database columns use full words except standard terms such as `id`, `tx_hash`, and `usd`.
- Avoid novelty names, unexplained abbreviations, and wrapper classes that only rename a library call.

## 6. Runtime Components

### 6.1 Web

Next.js renders a mobile-first Telegram Mini App. It owns Telegram launch, Base wallet connection, TON Connect, and review-flow input; all value-moving wallet requests remain locked.

Target responsibilities:

- connect Base and TON wallets;
- apply Telegram theme, viewport, safe-area, and haptic primitives;
- show approved pools;
- request plans and quotes;
- present exact addresses, amounts, fees, and expiry;
- submit transactions through the user's wallet;
- send transaction references to the server;
- resume a flow from its public ID and connected wallets;
- show recovery and next actions.

The web application must not infer settlement from a wallet success callback. It waits for server verification. Until both wallet integrations and transaction builders are complete, the UI cannot enable execution.

Outside Telegram, the local build exposes an explicit demo session. It uses fixed non-funded wallet addresses and labels every draft as preview-only. Demo mode is rejected when `NODE_ENV=production`.

### 6.2 Server

Fastify exposes a small HTTP API and runs background checks.

Implemented responsibilities:

- load and validate pool metadata;
- request or coordinate Omniston quotes;
- calculate entry and exit plans;
- persist flow state;
- verify Base and TON transactions;
- verify STON.fi LP positions;
- calculate aggregate impact metrics;
- reserve idempotency keys before writes and retry bounded verification reads.
- validate signed Telegram launch data and bind flow creation to a short-lived launch session.

Telegram identity is verified with the bot-token HMAC over raw `initData`, including a freshness bound. The server returns only a short-lived signed launch token and does not persist the Telegram profile. Wallet ownership still requires independent Base and TON proofs; Telegram identity never substitutes for a wallet signature.

Omniston order construction, signed-order registration, trade tracking, destination settlement proof, transaction building, withdrawal planning, and quote-expiry scheduling remain release blockers.

The source and reverse-exit routes are registered for contract stability but return `ROUTE_UNAVAILABLE` independently of `READ_ONLY`. A successful generic call to a quoted contract is not sufficient evidence of the exact Omniston order.

The server does not sign wallet transactions. It may return protocol-built transaction data only after validating the active flow.

### 6.3 Shared

The `shared` package contains plain types, schemas, amount helpers, and state-transition rules used by both runtimes.

It must not contain network clients, database access, UI components, or environment reads.

### 6.4 Database

PostgreSQL stores flow state and public transaction references. Numeric token amounts are stored as integer strings or fixed-precision numeric values, never JavaScript floating-point numbers.

The database is not a ledger of user balances. It records what the protocols and chains report.

### 6.5 Background jobs

The first release uses a database-backed job table and one server worker. A separate queue service is unnecessary at initial scale.

Current jobs perform:

- transaction confirmation checks;
- LP position verification;
- bounded retry of verification reads with distinct recovery states.

Trade refresh, quote expiry, and metric snapshots are required before the execution lock is removed.

Each job uses a unique key so restarts cannot duplicate state transitions.

## 7. External Interfaces

### Omniston

Required capabilities:

- request a v1beta8 quote for Base USDC to TON USDT;
- accept only order settlement for the cross-chain route;
- identify the trade-start deadline, estimated fees, and gas data;
- build EIP-712 order data for the connected Base owner and TON recipient;
- support the protocol-selected USDC authorization path, including Permit2 or EIP-2612 when returned;
- register only a wallet-signed order;
- track the accepted trade to a terminal state;
- expose destination settlement references;
- perform the reverse route for exit.

The proposed cross-chain release is stablecoin-only and caps each atomic swap at $1,000. In v1beta8 the Base order has no independent generic refund address: `owner_src_address` owns the source position and receives withdrawals, while `trader_dst_address` receives the TON output. Local validators cover those roles, but live signed evidence is still required before execution.

### STON.fi

Required capabilities:

- list and inspect selected V2 pools;
- read reserves, assets, fees, TVL, and recent activity;
- simulate required swaps and liquidity provision;
- build user-authorized V2 transactions;
- query swap and transaction status;
- read wallet pool positions;
- build withdrawal transactions.

### Base

Required capabilities:

- read USDC balance and allowance;
- submit user-approved transactions;
- confirm source transaction and logs;
- verify final USDC settlement on exit.

### TON

Required capabilities:

- connect through TON Connect;
- read asset balances and TON gas balance;
- submit STON.fi transactions;
- confirm transfers and resulting LP position.

## 8. Entry Planning

The entry plan has two precision levels.

### Indicative plan

Created before the cross-chain transaction. It combines:

- current Omniston quote;
- current destination asset value;
- current STON.fi pool state;
- current LP simulation;
- estimated network costs.

It helps the user decide whether to begin. It is not the final LP promise because settlement takes time.

### Final deposit plan

Created after TON settlement. It uses:

- actual destination asset received;
- current user balances;
- current pool reserves;
- fresh swap and liquidity simulations;
- current gas requirement.

If the final plan differs beyond a configured threshold, the user must explicitly accept the new values.

### Pool entry modes

Only modes proven in Chunk 0 are enabled:

- `single`: one supported asset enters using the pool's supported single-sided or arbitrary provision path;
- `balanced`: assets are prepared in the required ratio before provision.

The project will not write a new custody or zap contract for the MVP. If a selected pool cannot be entered safely through supported STON.fi transactions, it is removed from the allowlist.

For V2 provision, the application uses the router returned by the live STON.fi simulation. It does not hardcode a router independently of that result. A non-zero old LP-account token balance blocks execution until the user refunds that account because it can make the simulated minimum LP output unsafe.

## 9. Flow State

One flow represents one entry or exit attempt.

### Entry states

```text
draft
quoted
source_pending
trade_pending
trade_filled
funds_received
deposit_ready
deposit_pending
complete
```

### Entry exception states

```text
quote_expired
source_rejected
trade_partial
trade_failed
trade_unknown
source_withdrawal_available
source_withdrawn
deposit_changed
deposit_failed
cancelled
```

### Exit states

```text
exit_draft
withdraw_ready
withdraw_pending
withdraw_failed
assets_received
exit_quoted
exit_pending
exit_failed
exit_quote_expired
exit_complete
```

### Transition rules

- The client requests a transition; the server validates it.
- Chain-confirmed states require an RPC or protocol proof.
- State never moves backward.
- Omniston `FULLY_FILLED` first reaches `trade_filled`; only an independently verified destination receipt can advance it to `funds_received`.
- `PARTIALLY_FILLED`, `CANCELLED`, `FAILED`, and unknown results never become deposit-ready.
- A new quote creates a new quote record rather than mutating the expired one.
- A failed deposit does not invalidate confirmed cross-chain settlement.
- Retrying a transaction requires a new attempt record.
- `complete` requires a verified LP balance change or matching position evidence.
- `exit_complete` requires verified destination settlement.

The `shared/src/state.ts` module exposes only explicit functions such as `canSetState` and `getNextActions`. It must not contain a broad workflow framework.

## 10. Data Model

### `pool`

| Field            | Purpose                |
| ---------------- | ---------------------- |
| `id`             | Internal stable ID     |
| `address`        | STON.fi pool address   |
| `router_address` | Approved V2 router     |
| `token0_address` | First pool asset       |
| `token1_address` | Second pool asset      |
| `entry_mode`     | `single` or `balanced` |
| `enabled`        | Public availability    |
| `checked_at`     | Last metadata check    |

### `flow`

| Field          | Purpose                   |
| -------------- | ------------------------- |
| `id`           | Public random flow ID     |
| `type`         | `entry` or `exit`         |
| `state`        | Current verified state    |
| `base_wallet`  | Source or exit wallet     |
| `ton_wallet`   | Destination and LP wallet |
| `pool_id`      | Selected pool             |
| `source_units` | Integer base units        |
| `version`      | Optimistic write version  |
| `created_at`   | Creation time             |
| `updated_at`   | Last transition time      |

### `quote`

| Field                  | Purpose                      |
| ---------------------- | ---------------------------- |
| `id`                   | Internal UUID                |
| `flow_id`              | Parent flow                  |
| `provider_id`          | Omniston quote ID            |
| `resolver_id`          | Resolver identity            |
| `input_units`          | Exact input base units       |
| `output_units`         | Expected output base units   |
| `protocol_fee_units`   | Reported protocol fee        |
| `integrator_fee_units` | Reported integrator fee      |
| `expires_at`           | Last valid start time        |
| `raw_hash`             | Hash of canonical quote data |

Raw quote payloads may be stored only when needed for transaction reproduction and must be size-limited.

### `transaction`

| Field          | Purpose                                    |
| -------------- | ------------------------------------------ |
| `id`           | Internal ID                                |
| `flow_id`      | Parent flow                                |
| `kind`         | `source`, `deposit`, `withdraw`, or `exit` |
| `chain`        | `base` or `ton`                            |
| `tx_hash`      | Chain transaction hash                     |
| `status`       | `pending`, `confirmed`, or `failed`        |
| `attempt`      | Monotonic attempt number                   |
| `confirmed_at` | Verification time                          |

### `trade`

| Field            | Purpose                              |
| ---------------- | ------------------------------------ |
| `id`             | Internal ID                          |
| `flow_id`        | Parent flow                          |
| `quote_id`       | Accepted quote                       |
| `status`         | Normalized Omniston state            |
| `result`         | Filled, partial, aborted, or unknown |
| `received_units` | Verified destination amount          |
| `checked_at`     | Last status check                    |

### `position`

| Field                   | Purpose                                |
| ----------------------- | -------------------------------------- |
| `id`                    | Internal ID                            |
| `flow_id`               | Entry flow                             |
| `wallet`                | LP owner                               |
| `pool_id`               | STON.fi pool                           |
| `lp_units`              | Verified LP amount                     |
| `entry_value_usd_units` | Estimated entry value                  |
| `opened_at`             | Position confirmation time             |
| `closed_at`             | Exit confirmation time when applicable |

### `event`

Append-only state history containing flow ID, prior state, next state, public reference, and timestamp. It must not contain wallet secrets or unneeded personal data.

## 11. HTTP API

The API remains small and uses versioned routes.

```text
GET    /v1/pools
GET    /v1/pools/:id
POST   /v1/flows
GET    /v1/flows/:id
GET    /v1/flows/:id/status
POST   /v1/flows/:id/auth/challenge
POST   /v1/flows/:id/auth/base
POST   /v1/flows/:id/auth/ton
POST   /v1/flows/:id/quote
POST   /v1/flows/:id/source
POST   /v1/flows/:id/deposit-plan
POST   /v1/flows/:id/deposit
POST   /v1/flows/:id/withdraw
POST   /v1/flows/:id/exit-quote
POST   /v1/flows/:id/exit
GET    /v1/positions
GET    /v1/metrics
```

Rules:

- business write routes require an idempotency key;
- wallet ownership is proven through a short-lived signed message when private flow data is requested;
- public flow IDs have enough entropy to prevent enumeration;
- transaction submission routes receive hashes, not private signatures;
- server responses use integer amount strings plus token decimals;
- raw upstream errors are mapped to stable local error codes.

## 12. Amounts and Prices

- Token amounts use integer base units at protocol boundaries.
- Display conversion uses token decimals and decimal arithmetic.
- JavaScript `number` is not used for token balances, quotes, minimum output, or LP amounts.
- USD values always include price source and observation time.
- APR values include period and methodology.
- Rounding direction is explicit: costs round up; minimum received and user output round down.
- Comparisons use base units, not formatted strings.

## 13. Security Controls

### Address validation

- validate chain and format before persistence;
- normalize addresses for comparison without changing the displayed wallet form;
- verify configured tokens and pools against an allowlist;
- verify router and pool relationships before building a transaction;
- display complete addresses in the final review.

### Quote integrity

- hash canonical quote data;
- reject expired quotes;
- bind quotes to flow, wallets, assets, and amount;
- require order-only settlement and correlate stream events to the acknowledged RFQ;
- reconcile resolver output with net output and protocol and integrator fees;
- reject unknown HTLC hashes, ambiguous chain values, and malformed security deposits;
- bind the EIP-712 domain to Base and the exact source protocol contract from the accepted quote;
- reject client changes to the source owner or destination recipient;
- re-fetch or verify transaction data before display.

### Simulation integrity

- bind each result to the requested pool, token pair, provision type, and integer input amount;
- use only router metadata returned by the simulation when that router is listed as V2;
- require positive minimum LP output and validate both balanced and arbitrary results;
- block execution when either result reports old LP-account token balances;
- treat missing, malformed, or oversized upstream responses as failed evidence.

### Request protection

- schema validation on every route;
- pre-write idempotency reservations for business mutations;
- per-IP rate limits;
- strict CORS configuration;
- no secrets in browser bundles;
- short server timeouts and bounded retries for upstream calls.

### Data protection

- collect no name, email, or identity data for the MVP;
- retain transaction data needed for support and metrics;
- keep public metrics aggregated;
- redact upstream payloads from logs when they contain unnecessary wallet data;
- separate application logs from audit events.

## 14. Failure Handling

| Failure                             | Required behavior                                                     |
| ----------------------------------- | --------------------------------------------------------------------- |
| No Omniston quote                   | Disable execution and offer amount change or retry                    |
| Quote expires                       | Preserve the plan, request a new quote, require reconfirmation        |
| Wallet rejects source               | Mark attempt rejected; do not advance flow                            |
| Source tx submitted but not found   | Keep pending with clear timeout and support reference                 |
| Order is partially filled           | Show actual settlement and block LP planning until reconciled         |
| Order is cancelled or failed        | Show the terminal result and any protocol-supported source withdrawal |
| Source withdrawal becomes available | Require the Base order owner's wallet and expose the exact action     |
| TON funds arrive below estimate     | Rebuild the deposit plan from actual balance                          |
| Pool state changes                  | Re-simulate and require acceptance if threshold is crossed            |
| TON gas is insufficient             | Block deposit and show the exact shortfall                            |
| Deposit tx fails                    | Preserve TON assets and allow a fresh plan                            |
| LP verification is delayed          | Show pending; never claim completion from client state                |
| Browser closes                      | Restore flow from server state and connected wallets                  |
| Server restarts                     | Resume due jobs from database without duplicate transitions           |

## 15. Observability

### Logs

Structured logs include request ID, flow ID, upstream service, operation, duration, and stable error code. Logs must not include private wallet material or full unbounded payloads.

### Metrics

- quote request count and availability;
- quote latency and expiry rate;
- source transaction success rate;
- cross-chain settlement time;
- deposit simulation and completion rate;
- flow abandonment by state;
- source-withdrawal and failure counts;
- routed source volume;
- completed LP value;
- 7-day and 30-day retained TVL.

### Alerts

- upstream quote failure spike;
- stalled trade jobs;
- chain RPC error spike;
- position-verification mismatch;
- database job backlog;
- abnormal source-withdrawal frequency.

## 16. Test Strategy

### Unit tests

- amount conversion and rounding;
- quote expiry;
- address validation;
- state transitions;
- deposit threshold comparison;
- metric aggregation.

### Integration tests

- Omniston adapter against sandbox fixtures and approved live read endpoints;
- STON.fi pool and simulation adapter;
- transaction verification against fixed chain data;
- database idempotency and job retries;
- API authentication and error mapping.

### Browser tests

Current browser coverage verifies the pool workspace on desktop and mobile Chromium viewports, selected-pool behavior, impact data, and horizontal overflow. Wallet proofs, quote refresh, rejected source transactions, settlement, changed deposit plans, LP verification, withdrawal, exit, and keyboard flows remain required release coverage.

### Manual protocol tests

Small-value transactions cover every enabled pool and route before public release. Each test records wallet, route, quote, transaction hashes, actual output, expected output, and observed failure behavior.

## 17. Completion Definition

The MVP is complete when:

- a user can start with approved USDC on Base;
- the user receives assets in their own TON wallet through Omniston;
- the user can review a fresh deposit plan;
- the user can create an approved STON.fi V2 LP position;
- the position is independently verified and visible;
- interrupted and failed flows resolve without project custody;
- the user can withdraw and use the proven exit path, or the documented TON-wallet fallback if cross-chain exit is deferred;
- aggregate metrics show attributable volume and retained TVL;
- all release acceptance checks pass.

The detailed implementation backlog is maintained outside the repository. This architecture never authorizes deployment or removal of the read-only execution lock by itself.
