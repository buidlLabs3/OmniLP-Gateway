"use client";

import { formatAmount, parseAmount } from "@omnilp/shared";
import {
  Activity,
  ArrowRight,
  CircleDollarSign,
  Database,
  RefreshCw,
  Search,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";

import {
  createFlow,
  getFlow,
  getImpact,
  getPools,
  type FlowView,
  type Impact,
  type Pool,
} from "../lib/api";

const emptyImpact: Impact = {
  checkedAt: new Date(0).toISOString(),
  routedUsdcUnits: "0",
  depositedUsdUnits: "0",
  retained7dUsdUnits: "0",
  retained30dUsdUnits: "0",
  completedEntries: 0,
  completedExits: 0,
  sourceWithdrawals: 0,
  completionPips: 0,
  medianEntryUnits: "0",
  pools: [],
};

function money(units: string): string {
  const [whole = "0", fraction = ""] = formatAmount(units, 6, 2).split(".");
  return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction.padEnd(2, "0")}`;
}

function short(value: string): string {
  return value.length > 14
    ? `${value.slice(0, 7)}...${value.slice(-5)}`
    : value;
}

export default function Home() {
  const [pools, setPools] = useState<Pool[]>([]);
  const [impact, setImpact] = useState<Impact>(emptyImpact);
  const [selected, setSelected] = useState("");
  const [query, setQuery] = useState("");
  const [baseWallet, setBaseWallet] = useState("");
  const [tonWallet, setTonWallet] = useState("");
  const [amount, setAmount] = useState("10");
  const [flowId, setFlowId] = useState("");
  const [flow, setFlow] = useState<FlowView | null>(null);
  const [status, setStatus] = useState("Connecting to gateway");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    const [poolResult, impactResult] = await Promise.allSettled([
      getPools(),
      getImpact(),
    ]);
    if (poolResult.status === "fulfilled") {
      setPools(poolResult.value);
      setSelected(
        (current) =>
          current || poolResult.value.find((pool) => pool.enabled)?.id || "",
      );
    }
    if (impactResult.status === "fulfilled") setImpact(impactResult.value);
    if (
      poolResult.status === "rejected" ||
      impactResult.status === "rejected"
    ) {
      setStatus("Gateway unavailable");
      setError("The API or database is not reachable.");
    } else {
      setStatus("Read-only pilot");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const shownPools = useMemo(() => {
    const value = query.trim().toLowerCase();
    return pools.filter(
      (pool) =>
        !value ||
        pool.id.includes(value) ||
        pool.token0.symbol.toLowerCase().includes(value) ||
        pool.token1.symbol.toLowerCase().includes(value),
    );
  }, [pools, query]);

  async function connectBase() {
    const provider = (
      window as Window & {
        ethereum?: {
          request: (input: {
            method: string;
            params?: unknown[];
          }) => Promise<unknown>;
        };
      }
    ).ethereum;
    if (!provider) {
      setError("No injected Base wallet was found.");
      return;
    }
    setError("");
    try {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x2105" }],
      });
      const accounts = await provider.request({
        method: "eth_requestAccounts",
      });
      if (!Array.isArray(accounts) || typeof accounts[0] !== "string")
        throw new Error();
      setBaseWallet(accounts[0]);
    } catch {
      setError("Base wallet connection was not completed.");
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const created = await createFlow({
        poolId: selected,
        baseWallet,
        tonWallet,
        sourceUnits: parseAmount(amount, 6),
      });
      setFlow(created);
      setFlowId(created.id);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Flow could not be created.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function resume(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      setFlow(await getFlow(flowId.trim()));
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Flow could not be loaded.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <header className="topbar">
        <div className="brand">
          <span className="mark" aria-hidden="true">
            <span />
          </span>
          <div>
            <strong>OmniLP Gateway</strong>
            <small>STON.fi liquidity ingress</small>
          </div>
        </div>
        <div className="top-actions">
          <span className="runtime">
            <span />
            {status}
          </span>
          <button
            className="icon-button"
            type="button"
            title="Refresh data"
            onClick={() => void load()}
          >
            <RefreshCw size={17} />
          </button>
        </div>
      </header>

      <section className="metrics" aria-label="Protocol impact">
        <div>
          <CircleDollarSign size={18} />
          <span>Routed volume</span>
          <strong>{money(impact.routedUsdcUnits)}</strong>
        </div>
        <div>
          <Database size={18} />
          <span>Deposited TVL</span>
          <strong>{money(impact.depositedUsdUnits)}</strong>
        </div>
        <div>
          <ShieldCheck size={18} />
          <span>Completed entries</span>
          <strong>{impact.completedEntries}</strong>
        </div>
        <div>
          <Activity size={18} />
          <span>Pools reached</span>
          <strong>{impact.pools.length}</strong>
        </div>
      </section>

      <div className="workspace">
        <section className="catalog">
          <div className="section-head">
            <div>
              <h1>Approved pools</h1>
              <p>{pools.filter((pool) => pool.enabled).length} available</p>
            </div>
            <label className="search">
              <Search size={16} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter pools"
                aria-label="Filter pools"
              />
            </label>
          </div>
          <div className="pool-list">
            {shownPools.map((pool) => (
              <button
                key={pool.id}
                className={`pool-row ${selected === pool.id ? "selected" : ""}`}
                type="button"
                disabled={!pool.enabled}
                onClick={() => setSelected(pool.id)}
              >
                <span className="pair">
                  <span className="token">
                    {pool.token1.symbol.slice(0, 2)}
                  </span>
                  <span>
                    <strong>
                      {pool.token0.symbol} / {pool.token1.symbol}
                    </strong>
                    <small>{short(pool.address)}</small>
                  </span>
                </span>
                <span>
                  <small>TVL</small>
                  <strong>{money(pool.tvlUsdUnits)}</strong>
                </span>
                <span>
                  <small>24h volume</small>
                  <strong>{money(pool.volume24hUsdUnits)}</strong>
                </span>
                <span className={pool.enabled ? "enabled" : "disabled"}>
                  {pool.enabled ? "Ready" : "Locked"}
                </span>
              </button>
            ))}
            {shownPools.length === 0 && (
              <div className="empty">
                <Database size={20} />
                <span>No approved pool data</span>
              </div>
            )}
          </div>
        </section>

        <aside className="flow-panel">
          <div className="tabs">
            <button className="active" type="button">
              New entry
            </button>
            <button type="button" disabled>
              Exit
            </button>
          </div>
          <form onSubmit={(event) => void submit(event)}>
            <label>
              Source amount
              <span className="amount-input">
                <input
                  value={amount}
                  inputMode="decimal"
                  onChange={(event) => setAmount(event.target.value)}
                />
                <b>USDC</b>
              </span>
            </label>
            <label>
              Base wallet
              <span className="wallet-input">
                <input
                  value={baseWallet}
                  onChange={(event) => setBaseWallet(event.target.value)}
                  placeholder="0x..."
                />
                <button type="button" onClick={() => void connectBase()}>
                  <Wallet size={16} />
                  Connect
                </button>
              </span>
            </label>
            <label>
              TON wallet
              <input
                value={tonWallet}
                onChange={(event) => setTonWallet(event.target.value)}
                placeholder="EQ... or 0:..."
              />
            </label>
            <label>
              Destination pool
              <select
                value={selected}
                onChange={(event) => setSelected(event.target.value)}
              >
                <option value="">Select a pool</option>
                {pools
                  .filter((pool) => pool.enabled)
                  .map((pool) => (
                    <option key={pool.id} value={pool.id}>
                      {pool.token0.symbol} / {pool.token1.symbol}
                    </option>
                  ))}
              </select>
            </label>
            <button
              className="primary"
              type="submit"
              disabled={busy || !selected || !baseWallet || !tonWallet}
            >
              {busy ? "Creating..." : "Create review"}
              <ArrowRight size={17} />
            </button>
          </form>

          <div className="resume">
            <h2>Resume flow</h2>
            <form onSubmit={(event) => void resume(event)}>
              <input
                value={flowId}
                onChange={(event) => setFlowId(event.target.value)}
                placeholder="Flow ID"
                aria-label="Flow ID"
              />
              <button className="icon-button" title="Load flow" disabled={busy}>
                <ArrowRight size={17} />
              </button>
            </form>
          </div>

          {flow && (
            <div className="flow-result">
              <span>Current state</span>
              <strong>{flow.state.replaceAll("_", " ")}</strong>
              <code>{flow.id}</code>
            </div>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </aside>
      </div>
    </main>
  );
}
