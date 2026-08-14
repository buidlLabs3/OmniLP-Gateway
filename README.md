# OmniLP Gateway

OmniLP Gateway is a non-custodial path from external stablecoins into selected STON.fi V2 liquidity pools.

The first release targets one route:

```text
USDC on Base
  -> Omniston cross-chain trade
  -> USDT in the user's TON wallet
  -> STON.fi V2 liquidity position
```

The user starts with the pool they want to enter. OmniLP then coordinates the required quotes, wallet transactions, settlement tracking, pool preparation, and liquidity provision. Assets move through existing Omniston routes and STON.fi contracts. OmniLP does not hold funds, provide inventory, run a resolver, or guarantee route availability.

## Why It Matters

The normal route into a TON liquidity pool is fragmented. A user must move capital across chains, wait for settlement, acquire the correct pool assets, calculate the deposit, and complete a separate liquidity transaction. Generic bridges and swap interfaces stop before the STON.fi position is created.

OmniLP turns that sequence into one resumable product flow. Its value to STON.fi is measurable:

- external capital becomes STON.fi TVL;
- every entry produces attributable Omniston volume;
- pool preparation can produce STON.fi swap volume;
- completed positions provide fee-generating liquidity;
- later withdrawals and exits create additional protocol activity;
- retained TVL can be measured after 7 and 30 days.

## Core Rules

1. **No custody.** Funds settle to the user's wallets and LP ownership belongs to the user.
2. **No project liquidity.** OmniLP uses existing Omniston resolvers, routes, and STON.fi pools.
3. **No false atomicity.** Cross-chain settlement and LP provision are separate, resumable stages.
4. **No stale execution.** Quotes and pool simulations are refreshed before each signature.
5. **No arbitrary assets in the first release.** Source assets, destination assets, and pools are allowlisted.
6. **No yield promises.** APR is indicative and every pool exposes its material risks.
7. **No hidden failure state.** Expired quotes, source withdrawals, retries, and interrupted flows remain visible.

## MVP

### Included

- Base as the source chain;
- USDC as the source asset;
- TON as the destination chain;
- USDT as the first destination asset;
- a maximum of $1,000 per cross-chain swap while the current Omniston cap applies;
- three selected STON.fi V2 pools;
- EVM wallet and TON wallet connection;
- Omniston quote, order authorization, and order tracking;
- complete cost, price-impact, and minimum-output preview;
- supported single-asset or balanced STON.fi liquidity provision;
- a persistent entry state that survives reloads and wallet reconnects;
- verification of the resulting LP position;
- a receipt with explorer links for every transaction;
- withdrawal and exit to USDC on Base;
- aggregate protocol-impact metrics.

### Excluded

- custody or pooled user balances;
- proprietary bridging or market making;
- resolver operation or token inventory;
- a public integration SDK;
- managed vaults and automatic rebalancing;
- leverage, borrowing, or hedging;
- permissionless pool listing;
- fiat services;
- yield guarantees, points, or token incentives.

## Entry Flow

1. User connects a Base wallet and a TON wallet.
2. User chooses one of the approved STON.fi pools.
3. User enters the USDC amount they want to use.
4. OmniLP displays an executable cross-chain quote and an indicative LP plan.
5. User approves USDC when required and signs the EVM HTLC order from the Base wallet.
6. OmniLP tracks the Omniston trade until TON settlement is confirmed.
7. OmniLP refreshes pool state and calculates the current LP transaction.
8. User reviews any changed amount, fees, or price impact.
9. User signs the STON.fi transaction from the TON wallet.
10. OmniLP verifies the LP position and issues a receipt.

Funds arriving on TON do not force the user to continue. If pool conditions change or the user stops, the assets remain in the user's TON wallet.

## Exit Flow

1. User selects a position created through OmniLP.
2. OmniLP simulates the STON.fi withdrawal.
3. User signs the withdrawal to their TON wallet.
4. OmniLP refreshes the Omniston quote for USDC on Base.
5. User signs the exit transaction.
6. OmniLP tracks settlement to the user's Base wallet.

Entry and exit are both stateful flows. A failed or interrupted stage can be resumed without repeating a completed transaction.

## Product Surfaces

### Pools

Shows the approved pools, pair, TVL, recent volume, fee tier, indicative APR, and a plain risk summary. Contract addresses and metric sources remain visible.

### Plan

Shows the cross-chain route, source amount, estimated TON output, LP preparation method, projected pool assets, projected LP share, fees, gas, price impact, minimum outputs, quote expiry, and required signatures.

### Activity

Shows the current stage, confirmed transactions, pending actions, withdrawal availability, retry options, and explorer links.

### Positions

Shows positions created through OmniLP, original entry estimate, current underlying assets, transaction history, and exit actions.

### Impact

Shows aggregate routed volume, completed deposits, destination pools, retained TVL, completion rate, and median entry size. It does not publish private labels or unnecessary wallet profiles.

## Success Measures

The main measure is net STON.fi TVL deposited through OmniLP and retained for at least 30 days.

Initial 90-day targets after public launch:

- $100,000 in cumulative deposits;
- $50,000 in 30-day retained TVL;
- 100 completed entries;
- 35% conversion from valid plan to completed LP position;
- 90% of started cross-chain trades reaching a resolved terminal state;
- less than 2% of flows requiring manual support;
- complete attribution of routed volume and destination pools.

These are adoption targets, not guarantees.

## Delivery Boundaries

Protocol research has confirmed these current constraints:

- Omniston v1beta8 supports stablecoin routes between Base and TON;
- the first route is Base USDC to TON USDT;
- each atomic cross-chain swap is currently capped at $1,000;
- STON.fi V2 supports API-simulated balanced and arbitrary provision, including single-sided arbitrary provision;
- live simulation must supply the router metadata used to build the transaction;
- a wallet with old LP-account token balances must refund them before relying on a new `min_lp_units` result.

Value execution remains locked until the following checks are confirmed with signed, limited-value evidence:

- executable Base USDC to TON USDT quotes are returned at the tested amounts;
- the EVM order binds the connected Base wallet as source owner and the connected TON wallet as destination recipient;
- failed entry orders can be withdrawn only by the source owner;
- received TON USDT can fund each chosen LP path;
- three STON.fi V2 pools pass simulation and transaction tests;
- the user has a workable way to cover TON gas after ingress;
- entry and exit volume can be attributed without custody;
- production transaction limits and referral behavior are understood.

If the Base route is not production-ready, the first release falls back to a TON-native single-asset entry flow. The project will not introduce a private bridge or hot wallet as a workaround.

## Stack

- TypeScript;
- Next.js for the web application;
- Fastify for the server;
- PostgreSQL for flow state and aggregate metrics;
- an EVM wallet provider for Base transactions;
- STON.fi V1 API, Omniston v1beta8, Base RPC, and TON RPC interfaces;
- Playwright for browser flows;
- Vitest for unit and integration tests.

## Local Development

Node 22 and pnpm 10 are required. Configure a local PostgreSQL database, then run:

```bash
cp .env.example .env
pnpm install
pnpm db:migrate
pnpm dev
```

`APPROVED_POOLS` is intentionally empty in the sample configuration. No pool becomes executable until its address is explicitly configured and its current token, fee, router, and V2 metadata pass validation. `READ_ONLY=true` disables every value-moving route.

Run the complete local quality gate with:

```bash
pnpm check
pnpm test:e2e
```

## Protocol Check

Run the dependency-free read-only checks with Node 22 or newer:

```bash
TON_WALLET=EQ... node check/run.mjs
```

The runner validates the route rules, requests sandbox entry and exit quotes at `$10`, `$250`, and `$1,000`, selects three active V2 USDT pools, and simulates balanced and arbitrary provision. Quote responses must be fresh, order-only, correlated to their acknowledgment, and internally reconcile amounts and fees. Pool simulations must return the selected pool and token pair, a listed V2 router, positive minimum LP output, and zero old LP-account balances before they are marked safe. Read calls use bounded timeouts and retries. The runner does not sign, register, or submit transactions.

The source layout and implementation plan are defined in [ARCHITECTURE.md](./ARCHITECTURE.md).

## Project Status

The read-only technical foundation is implemented:

- responsive pool, impact, flow-creation, and public-resume surfaces;
- strict shared schemas, integer amount math, and explicit entry and exit states;
- PostgreSQL persistence with append-only events, optimistic state versions, atomic transaction transitions, job claiming, and side-effect-safe idempotency reservations;
- one-use Base and TON wallet ownership proofs with short-lived flow sessions;
- allowlisted STON.fi V2 catalog refresh, deposit simulation validation, action-tree verification, and LP balance-delta proof;
- fail-closed Omniston quote validation and Base receipt checks;
- a global read-only switch, exact CORS, rate limits, log redaction, bounded upstream reads, and bounded verification retries.

Gate A is not complete. Live signed Omniston order construction, registration, trade tracking, independently verified TON settlement amounts, TON Connect transaction building, withdrawal construction, and the reverse exit path are not wired. Source and reverse-exit routes therefore return `ROUTE_UNAVAILABLE` even if the general read-only switch is changed. Keep `READ_ONLY=true` until those paths pass the limited-value protocol checks; the current build must not be represented as production execution.
