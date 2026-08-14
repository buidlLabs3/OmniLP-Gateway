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
import { connectBaseWallet } from "../lib/base";
import { getTelegram, startTelegram, tap } from "../lib/telegram";

const demoBase = "0x1111111111111111111111111111111111111111";
const demoTon = `0:${"9".repeat(64)}`;
const botUrl = process.env.NEXT_PUBLIC_TELEGRAM_BOT_URL;
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
  const [launchError, setLaunchError] = useState("");
  const [nativeButton, setNativeButton] = useState(false);

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
    if (!telegram) {
      setLaunch("browser");
      return;
    }
    setLaunch("telegram");
    setNativeButton(Boolean(telegram.MainButton));
    const recent = localStorage.getItem("omnilp.flow");
    if (recent) setFlowId(recent);
    void startTelegramSession(telegram.initData)
      .then(async (next) => {
        setSession(next);
        if (next.demo) {
          setDemoWallets(true);
          setBaseWallet(demoBase);
        }
        await load();
      })
      .catch((cause: unknown) =>
        setLaunchError(
          cause instanceof Error
            ? cause.message
            : "Telegram session could not be verified.",
        ),
      );
  }, [load]);

  async function connectBase() {
    setError("");
    try {
      setBaseWallet(await connectBaseWallet());
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

  useEffect(() => {
    const telegram = getTelegram();
    const mainButton = telegram?.MainButton;
    const backButton = telegram?.BackButton;
    const submit = () => {
      const form = document.querySelector<HTMLFormElement>("#entry-form");
      form?.requestSubmit();
    };
    const goBack = () => setTab("enter");

    if (mainButton) {
      mainButton.offClick(submit);
      if (tab === "enter" && session) {
        mainButton.setText(busy ? "Creating..." : "Create review");
        mainButton.show();
        mainButton.onClick(submit);
        if (busy) mainButton.showProgress();
        else mainButton.hideProgress();
        if (!busy && activePool && baseWallet && tonWallet && amount) {
          mainButton.enable();
        } else {
          mainButton.disable();
        }
      } else {
        mainButton.hideProgress();
        mainButton.hide();
      }
    }

    if (backButton) {
      backButton.offClick(goBack);
      if (tab === "activity") {
        backButton.show();
        backButton.onClick(goBack);
      } else {
        backButton.hide();
      }
    }

    return () => {
      mainButton?.offClick(submit);
      backButton?.offClick(goBack);
    };
  }, [activePool, amount, baseWallet, busy, session, tab, tonWallet]);

  if (
    launch === "loading" ||
    (launch === "telegram" && !session && !launchError)
  ) {
    return (
      <main className="launch-screen">
        <span className="brand-mark" aria-hidden="true">
          OL
        </span>
        <strong>Opening OmniLP</strong>
        <span className="launch-loader" aria-label="Loading" />
      </main>
    );
  }

  if (launch === "browser" || launchError) {
    return (
      <main className="launch-screen">
        <span className="brand-mark" aria-hidden="true">
          OL
        </span>
        <strong>
          {launchError ? "Telegram launch rejected" : "Open in Telegram"}
        </strong>
        <p>
          {launchError
            ? "Close this view and launch OmniLP again from the bot."
            : "OmniLP runs inside its Telegram Mini App."}
        </p>
        {botUrl && (
          <a className="primary launch-link" href={botUrl}>
            Open Telegram
            <ExternalLink size={17} />
          </a>
        )}
      </main>
    );
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
            <span>{session?.user.firstName}</span>
          </div>
        </div>
        <div className="head-actions">
          <span className={`mode ${session?.demo ? "demo" : ""}`}>
            {session?.demo ? "Test" : "Verified"}
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
        <form
          id="entry-form"
          className="entry"
          onSubmit={(event) => void submit(event)}
        >
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
                    Test
                  </span>
                ) : (
                  <TonConnectButton />
                )}
              </div>
            </div>
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

          <div className={`action-bar ${nativeButton ? "native" : ""}`}>
            {!nativeButton && (
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
                ? "Test session. No funds move."
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
