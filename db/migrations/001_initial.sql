BEGIN;

CREATE TABLE IF NOT EXISTS pool (
  id text PRIMARY KEY,
  address text NOT NULL UNIQUE,
  router_address text NOT NULL,
  token0_address text NOT NULL,
  token1_address text NOT NULL,
  entry_mode text NOT NULL CHECK (entry_mode IN ('single', 'balanced')),
  enabled boolean NOT NULL DEFAULT false,
  data jsonb NOT NULL,
  checked_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS flow (
  id uuid PRIMARY KEY,
  type text NOT NULL CHECK (type IN ('entry', 'exit')),
  state text NOT NULL,
  pool_id text NOT NULL REFERENCES pool(id),
  base_wallet text NOT NULL,
  ton_wallet text NOT NULL,
  source_units numeric(78, 0) NOT NULL CHECK (source_units > 0),
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS flow_event (
  id uuid PRIMARY KEY,
  flow_id uuid NOT NULL REFERENCES flow(id),
  prior_state text,
  next_state text NOT NULL,
  reference text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS flow_event_flow_time ON flow_event(flow_id, created_at);

CREATE TABLE IF NOT EXISTS quote (
  id uuid PRIMARY KEY,
  flow_id uuid NOT NULL REFERENCES flow(id),
  provider_id text NOT NULL,
  resolver_id text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('entry', 'exit')),
  input_units numeric(78, 0) NOT NULL CHECK (input_units > 0),
  output_units numeric(78, 0) NOT NULL CHECK (output_units > 0),
  protocol_fee_units numeric(78, 0) NOT NULL CHECK (protocol_fee_units >= 0),
  integrator_fee_units numeric(78, 0) NOT NULL CHECK (integrator_fee_units >= 0),
  source_protocol_address text NOT NULL,
  destination_protocol_address text NOT NULL,
  quoted_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  raw_hash text NOT NULL,
  UNIQUE(flow_id, provider_id)
);

CREATE TABLE IF NOT EXISTS deposit_plan (
  id uuid PRIMARY KEY,
  flow_id uuid NOT NULL REFERENCES flow(id),
  pool_id text NOT NULL REFERENCES pool(id),
  mode text NOT NULL CHECK (mode IN ('single', 'balanced')),
  input_units numeric(78, 0) NOT NULL CHECK (input_units > 0),
  token0_units numeric(78, 0) NOT NULL CHECK (token0_units >= 0),
  token1_units numeric(78, 0) NOT NULL CHECK (token1_units >= 0),
  min_lp_units numeric(78, 0) NOT NULL CHECK (min_lp_units > 0),
  lp_units_before numeric(78, 0) NOT NULL CHECK (lp_units_before >= 0),
  gas_units numeric(78, 0) NOT NULL CHECK (gas_units > 0),
  price_impact_pips integer NOT NULL CHECK (price_impact_pips BETWEEN 0 AND 1000000),
  indicative boolean NOT NULL,
  router_address text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deposit_plan_flow_time ON deposit_plan(flow_id, created_at DESC);

CREATE TABLE IF NOT EXISTS trade (
  id uuid PRIMARY KEY,
  flow_id uuid NOT NULL REFERENCES flow(id),
  quote_id uuid NOT NULL REFERENCES quote(id),
  status text NOT NULL,
  received_units numeric(78, 0),
  reference text,
  checked_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS flow_transaction (
  id uuid PRIMARY KEY,
  flow_id uuid NOT NULL REFERENCES flow(id),
  kind text NOT NULL CHECK (kind IN ('source', 'deposit', 'withdraw', 'exit')),
  chain text NOT NULL CHECK (chain IN ('base', 'ton')),
  tx_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'confirmed', 'failed')),
  attempt integer NOT NULL CHECK (attempt > 0),
  confirmed_at timestamptz,
  UNIQUE(flow_id, kind, attempt),
  UNIQUE(chain, tx_hash)
);

CREATE TABLE IF NOT EXISTS position (
  id uuid PRIMARY KEY,
  flow_id uuid NOT NULL UNIQUE REFERENCES flow(id),
  wallet text NOT NULL,
  pool_id text NOT NULL REFERENCES pool(id),
  lp_units numeric(78, 0) NOT NULL CHECK (lp_units > 0),
  entry_value_usd_units numeric(78, 0) NOT NULL,
  proof_reference text NOT NULL UNIQUE,
  opened_at timestamptz NOT NULL,
  closed_at timestamptz
);

CREATE TABLE IF NOT EXISTS idempotency (
  scope text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  status integer NOT NULL,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(scope, key)
);

CREATE TABLE IF NOT EXISTS job (
  id uuid PRIMARY KEY,
  job_key text NOT NULL UNIQUE,
  type text NOT NULL,
  payload jsonb NOT NULL,
  run_at timestamptz NOT NULL,
  locked_at timestamptz,
  locked_by text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text
);
CREATE INDEX IF NOT EXISTS job_due ON job(run_at) WHERE locked_at IS NULL;

CREATE TABLE IF NOT EXISTS wallet_challenge (
  id uuid PRIMARY KEY,
  flow_id uuid NOT NULL REFERENCES flow(id),
  chain text NOT NULL CHECK (chain IN ('base', 'ton')),
  wallet text NOT NULL,
  nonce_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX IF NOT EXISTS wallet_challenge_flow ON wallet_challenge(flow_id, chain, expires_at);

COMMIT;
