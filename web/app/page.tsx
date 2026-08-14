"use client";

import { formatAmount, parseAmount } from "@omnilp/shared";
import { TonConnectButton, useTonAddress } from "@tonconnect/ui-react";
import {
  ArrowDown,
  ArrowRight,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  Copy,
  ExternalLink,
  History,
  RefreshCw,
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
  startTelegramSession,
  type FlowView,
  type Impact,
  type Pool,
  type TelegramSession,
} from "../lib/api";
import { startTelegram, tap } from "../lib/telegram";

const demoBase = "0x1111111111111111111111111111111111111111";
const demoTon = `0:${"9".repeat(64)}`;
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

function money(units: string, decimals = 0): string {
  const value = Number(formatAmount(units, 6, decimals));
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

function short(value: string): string {
  return value.length > 13
    ? `${value.slice(0, 6)}...${value.slice(-4)}`
    : value;
}

function stateLabel(value: string): string {
  return value.replaceAll("_", " ");
}

export default function Home() {
  const connectedTon = useTonAddress(false);
  const [tab, setTab] = useState<"enter" | "activity">("enter");
  const [session, setSession] = useState<TelegramSession | null>(null);
  const [pools, setPools] = useState<Pool[]>([]);
  const [impact, setImpact] = useState<Impact>(emptyImpact);
  const [selected, setSelected] = useState("");
  const [amount, setAmount] = useState("25");
  const [baseWallet, setBaseWallet] = useState("");
  const [demoWallets, setDemoWallets] = useState(false);
  const [flowId, setFlowId] = useState("");
  const [flow, setFlow] = useState<FlowView | null>(null);
  const [launch, setLaunch] = useState<"loading" | "telegram" | "browser">(
    "loading",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const tonWallet = connectedTon || (demoWallets ? demoTon : "");
  const activePool = useMemo(
    () => pools.find((pool) => pool.id === selected) ?? null,
    [pools, selected],
  );

  const load = useCallback(async () => {
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
    if (poolResult.status === "rejected") {
      setError("Gateway is offline. Start the local demo server and retry.");
    }
  }, []);

  useEffect(() => {
    const telegram = startTelegram();
    setLaunch(telegram?.initData ? "telegram" : "browser");
    if (telegram?.initData) {
      void startTelegramSession(telegram.initData)
        .then(setSession)
        .catch((cause: unknown) =>
          setError(
            cause instanceof Error
              ? cause.message
              : "Telegram session could not be verified.",
          ),
        );
    }
    void load();
    const recent = localStorage.getItem("omnilp.flow");
    if (recent) setFlowId(recent);
  }, [load]);

  async function openPreview() {
    setBusy(true);
    setError("");
    try {
      const next = await startTelegramSession("", true);
      setSession(next);
      setDemoWallets(true);
      setBaseWallet(demoBase);
      tap("success");
    } catch (cause) {
      tap("error");
      setError(cause instanceof Error ? cause.message : "Preview unavailable.");
    } finally {
      setBusy(false);
    }
  }

  async function connectBase() {
    const provider = window.ethereum;
    if (!provider) {
      setError("No Base wallet was found in this browser.");
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
      if (!Array.isArray(accounts) || typeof accounts[0] !== "string") {
        throw new Error("Wallet did not return an account.");
      }
      setBaseWallet(accounts[0]);
      tap("success");
    } catch {
      tap("error");
      setError("Base wallet connection was not completed.");
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!session) return;
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
      localStorage.setItem("omnilp.flow", created.id);
      setTab("activity");
      tap("success");
    } catch (cause) {
      tap("error");
      setError(
        cause instanceof Error ? cause.message : "Flow was not created.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function resume(event: FormEvent) {
    event.preventDefault();
    if (!flowId.trim()) return;
    setBusy(true);
    setError("");
    try {
      const next = await getFlow(flowId.trim());
      setFlow(next);
      localStorage.setItem("omnilp.flow", next.id);
      tap("success");
    } catch (cause) {
      tap("error");
      setError(cause instanceof Error ? cause.message : "Flow was not found.");
    } finally {
      setBusy(false);
    }
  }

  function selectPool(id: string) {
    setSelected(id);
    tap();
  }

  async function copyFlow() {
    if (!flow) return;
    await navigator.clipboard.writeText(flow.id);
    tap("success");
  }

  return (
    <main className="app-shell">
      <header className="app-head">
        <div className="identity">
          <span className="brand-mark" aria-hidden="true">
            OL
          </span>
          <div>
            <strong>OmniLP</strong>
            <span>
              {session?.user.firstName ??
                (launch === "loading" ? "Opening..." : "Telegram Gateway")}
            </span>
          </div>
        </div>
        <div className="head-actions">
          <span className={`mode ${session?.demo ? "demo" : ""}`}>
            {session?.demo ? "Demo" : session ? "Verified" : "Read only"}
          </span>
          <button
            className="icon-button"
            type="button"
            title="Refresh pools"
            onClick={() => void load()}
          >
            <RefreshCw size={18} />
          </button>
        </div>
      </header>

      <nav className="app-tabs" aria-label="Gateway views">
        <button
          type="button"
          className={tab === "enter" ? "active" : ""}
          onClick={() => setTab("enter")}
        >
          Enter
        </button>
        <button
          type="button"
          className={tab === "activity" ? "active" : ""}
          onClick={() => setTab("activity")}
        >
          Activity
          {flowId && <span className="tab-dot" />}
        </button>
      </nav>

      {tab === "enter" ? (
        <form className="entry" onSubmit={(event) => void submit(event)}>
          <section className="amount-section">
            <label htmlFor="amount">You send from Base</label>
            <div className="amount-row">
              <span>$</span>
              <input
                id="amount"
                inputMode="decimal"
                aria-label="USDC amount"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
              <b>USDC</b>
            </div>
            <span className="limit">Pilot limit $10 - $1,000</span>
          </section>

          <div className="route-step" aria-hidden="true">
            <span />
            <ArrowDown size={15} />
            <span />
          </div>

          <section className="pool-section">
            <div className="section-title">
              <div>
                <span>Destination</span>
                <h1>STON.fi pool</h1>
              </div>
              <small>{pools.filter((pool) => pool.enabled).length} live</small>
            </div>
            <div className="pool-options">
              {pools.map((pool) => (
                <button
                  key={pool.id}
                  type="button"
                  className={selected === pool.id ? "selected" : ""}
                  disabled={!pool.enabled}
                  onClick={() => selectPool(pool.id)}
                >
                  <span className="pair-icons" aria-hidden="true">
                    <i>{pool.token0.symbol.slice(0, 1)}</i>
                    <i>{pool.token1.symbol.slice(0, 1)}</i>
                  </span>
                  <span className="pool-name">
                    <strong>
                      {pool.token0.symbol} / {pool.token1.symbol}
                    </strong>
                    <small>{pool.entryMode} entry</small>
                  </span>
                  <span className="pool-stat">
                    <small>TVL</small>
                    <strong>{money(pool.tvlUsdUnits)}</strong>
                  </span>
                  {selected === pool.id ? (
                    <Check className="pool-check" size={18} />
                  ) : (
                    <ChevronRight size={18} />
                  )}
                </button>
              ))}
              {!pools.length && (
                <button className="empty-pool" type="button" disabled>
                  No approved pools loaded
                </button>
              )}
            </div>
          </section>

          <section className="wallet-section">
            <div className="section-title">
              <div>
                <span>Signatures</span>
                <h2>Wallets</h2>
              </div>
              <ShieldCheck size={19} />
            </div>
            <div className="wallet-row">
              <span className="chain base">B</span>
              <span>
                <strong>Base</strong>
                <small>
                  {baseWallet ? short(baseWallet) : "Not connected"}
                </small>
              </span>
              <button type="button" onClick={() => void connectBase()}>
                {baseWallet ? "Change" : "Connect"}
              </button>
            </div>
            <div className="wallet-row">
              <span className="chain ton">T</span>
              <span>
                <strong>TON</strong>
                <small>{tonWallet ? short(tonWallet) : "Not connected"}</small>
              </span>
              <div className="ton-connect">
                {demoWallets && !connectedTon ? (
                  <span className="demo-connected">
                    <Check size={14} />
                    Demo
                  </span>
                ) : (
                  <TonConnectButton />
                )}
              </div>
            </div>
            {session?.demo && (
              <button
                className="demo-wallets"
                type="button"
                onClick={() => {
                  setDemoWallets(true);
                  setBaseWallet(demoBase);
                  tap();
                }}
              >
                <Wallet size={16} />
                Restore demo wallets
              </button>
            )}
          </section>

          <section className="impact-strip" aria-label="Gateway impact">
            <div>
              <small>Routed</small>
              <strong>{money(impact.routedUsdcUnits)}</strong>
            </div>
            <div>
              <small>Entries</small>
              <strong>{impact.completedEntries}</strong>
            </div>
            <div>
              <small>Pools</small>
              <strong>{impact.pools.length}</strong>
            </div>
          </section>

          {error && (
            <p className="notice error" role="alert">
              <CircleAlert size={17} />
              {error}
            </p>
          )}

          <div className="action-bar">
            {!session ? (
              <button
                className="primary"
                type="button"
                disabled={busy}
                onClick={() => void openPreview()}
              >
                {busy ? "Opening..." : "Open preview"}
                <ArrowRight size={18} />
              </button>
            ) : (
              <button
                className="primary"
                type="submit"
                disabled={
                  busy || !activePool || !baseWallet || !tonWallet || !amount
                }
              >
                {busy ? "Creating..." : "Create review"}
                <ArrowRight size={18} />
              </button>
            )}
            <span>
              {session?.demo
                ? "Preview only. No funds move."
                : "Execution stays locked until route verification passes."}
            </span>
          </div>
        </form>
      ) : (
        <section className="activity-view">
          <div className="activity-head">
            <div>
              <span>Persistent state</span>
              <h1>Activity</h1>
            </div>
            <History size={20} />
          </div>

          <form
            className="resume-form"
            onSubmit={(event) => void resume(event)}
          >
            <input
              aria-label="Flow ID"
              placeholder="Flow ID"
              value={flowId}
              onChange={(event) => setFlowId(event.target.value)}
            />
            <button type="submit" title="Load flow" disabled={busy || !flowId}>
              <ArrowRight size={18} />
            </button>
          </form>

          {flow ? (
            <div className="flow-status">
              <div className="flow-title">
                <span>
                  <strong>{activePool?.token0.symbol ?? "USDC"}</strong>
                  <ArrowRight size={15} />
                  <strong>{activePool?.token1.symbol ?? flow.poolId}</strong>
                </span>
                <b>{stateLabel(flow.state)}</b>
              </div>
              <button
                className="flow-id"
                type="button"
                onClick={() => void copyFlow()}
              >
                <code>{short(flow.id)}</code>
                <Copy size={15} />
              </button>
              <ol className="timeline">
                <li className="done">
                  <span>
                    <Check size={13} />
                  </span>
                  <div>
                    <strong>Review created</strong>
                    <small>Saved and resumable</small>
                  </div>
                </li>
                <li className="current">
                  <span>
                    <Clock3 size={13} />
                  </span>
                  <div>
                    <strong>Wallet proof</strong>
                    <small>Required before a quote</small>
                  </div>
                </li>
                <li>
                  <span />
                  <div>
                    <strong>Route execution</strong>
                    <small>Locked in this pilot</small>
                  </div>
                </li>
              </ol>
              <button className="secondary" type="button" disabled>
                View route receipt
                <ExternalLink size={16} />
              </button>
            </div>
          ) : (
            <div className="empty-activity">
              <History size={24} />
              <strong>No flow loaded</strong>
              <span>Create a review or enter its ID.</span>
            </div>
          )}

          {error && (
            <p className="notice error" role="alert">
              <CircleAlert size={17} />
              {error}
            </p>
          )}
        </section>
      )}
    </main>
  );
}

declare global {
  interface Window {
    ethereum?: {
      request(input: { method: string; params?: unknown[] }): Promise<unknown>;
    };
  }
}
