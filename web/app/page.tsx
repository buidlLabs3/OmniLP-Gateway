"use client";

import { formatAmount, parseAmount } from "@omnilp/shared";
import {
  TonConnectButton,
  useTonAddress,
  useTonConnectUI,
  useTonWallet,
} from "@tonconnect/ui-react";
import {
  ArrowDown,
  ArrowRight,
  BadgeCheck,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  Copy,
  ExternalLink,
  History,
  KeyRound,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  WalletCards,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";

import {
  buildDepositPlan,
  buildWithdrawalPlan,
  createFlow,
  getChallenge,
  getDepositTx,
  getFlow,
  getImpact,
  getOrderData,
  getPools,
  getSourceWithdrawData,
  getTradeStatus,
  getWithdrawTx,
  proveBase as submitBaseProof,
  proveTon as submitTonProof,
  requestExitQuote,
  requestQuote,
  startTelegramSession,
  submitDeposit,
  submitExit,
  submitSourceOrder,
  submitSourceWithdraw,
  submitWithdraw,
  type FlowDetail,
  type Impact,
  type Pool,
  type TelegramSession,
  type Trade,
} from "../lib/api";
import {
  buildSourceWithdrawTx,
  connectBaseWallet,
  getBaseAddress,
  sendBaseTransaction,
  signBaseMessage,
  signBaseTypedData,
} from "../lib/base";
import { getTelegram, startTelegram, tap } from "../lib/telegram";
import { sendTonTransaction } from "../lib/tonTx";

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

function entryTimeline(state: string): Array<{
  label: string;
  note: string;
  state: "done" | "current" | "pending";
}> {
  const stages = [
    { label: "Review created", note: "Saved and resumable" },
    { label: "Wallet proof", note: "Sign with both wallets" },
    { label: "Route quote", note: "Live Omniston quote" },
    { label: "Cross-chain execution", note: "Base USDC to TON USDT" },
    { label: "Funds received", note: "Verified on TON" },
    { label: "Deposit plan", note: "Fresh STON.fi simulation" },
    { label: "LP position", note: "Verified in your wallet" },
  ];
  const index: Record<string, number> = {
    draft: 1,
    quoted: 2,
    source_pending: 3,
    trade_pending: 3,
    trade_filled: 3,
    funds_received: 4,
    deposit_ready: 5,
    deposit_changed: 5,
    deposit_pending: 5,
    complete: 6,
    quote_expired: 2,
    source_rejected: 2,
    source_withdrawal_available: 3,
    source_withdrawn: 3,
    trade_partial: 3,
    trade_failed: 3,
    trade_unknown: 3,
    deposit_failed: 5,
  };
  const current = index[state] ?? 1;
  return stages.map((stage, i) => ({
    ...stage,
    state: i < current ? "done" : i === current ? "current" : "pending",
  }));
}

function exitTimeline(state: string): Array<{
  label: string;
  note: string;
  state: "done" | "current" | "pending";
}> {
  const stages = [
    { label: "Build withdrawal", note: "LP tokens to TON USDT" },
    { label: "Submit withdrawal", note: "TON transaction" },
    { label: "Assets received", note: "Verified on TON" },
    { label: "Exit quote", note: "TON USDT to Base USDC" },
    { label: "Exit execution", note: "Cross-chain settlement" },
    { label: "Funds returned", note: "USDC in your wallet" },
  ];
  const index: Record<string, number> = {
    exit_draft: 0,
    withdraw_ready: 0,
    withdraw_pending: 1,
    withdraw_failed: 1,
    assets_received: 2,
    exit_quoted: 3,
    exit_quote_expired: 3,
    exit_pending: 4,
    exit_failed: 4,
    exit_complete: 5,
  };
  const current = index[state] ?? 0;
  return stages.map((stage, i) => ({
    ...stage,
    state: i < current ? "done" : i === current ? "current" : "pending",
  }));
}

const actionLabels: Record<string, string> = {
  request_quote: "Request live quote",
  review_source: "Review source order",
  refresh_trade: "Refresh trade state",
  withdraw_source: "Withdraw source funds",
  build_deposit_plan: "Build deposit plan",
  review_deposit: "Accept changed plan",
  submit_deposit: "Submit LP deposit",
  view_position: "View position",
  start_exit: "Start exit",
  build_withdrawal: "Build withdrawal",
  submit_withdrawal: "Submit withdrawal",
  request_exit_quote: "Request exit quote",
  review_exit: "Review exit",
};

const executableActions = new Set([
  "request_quote",
  "review_source",
  "build_deposit_plan",
  "review_deposit",
  "submit_deposit",
  "start_exit",
  "build_withdrawal",
  "submit_withdrawal",
  "request_exit_quote",
  "review_exit",
  "withdraw_source",
  "refresh_trade",
]);

export default function Home() {
  const connectedTon = useTonAddress(false);
  const connectedWallet = useTonWallet();
  const [tonConnectUI] = useTonConnectUI();
  const [tab, setTab] = useState<"enter" | "activity">("enter");
  const [session, setSession] = useState<TelegramSession | null>(null);
  const [pools, setPools] = useState<Pool[]>([]);
  const [impact, setImpact] = useState<Impact>(emptyImpact);
  const [selected, setSelected] = useState("");
  const [amount, setAmount] = useState("25");
  const [baseWallet, setBaseWallet] = useState("");
  const [demoWallets, setDemoWallets] = useState(false);
  const [flowId, setFlowId] = useState("");
  const [flow, setFlow] = useState<FlowDetail | null>(null);
  const [launch, setLaunch] = useState<"loading" | "telegram" | "browser">(
    "loading",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [launchError, setLaunchError] = useState("");
  const [nativeButton, setNativeButton] = useState(false);
  const [proved, setProved] = useState<{ base: boolean; ton: boolean }>({
    base: false,
    ton: false,
  });
  const [tonNonce, setTonNonce] = useState("");
  const [trade, setTrade] = useState<Trade | null>(null);

  const tonWallet = connectedTon || (demoWallets ? demoTon : "");
  const activePool = useMemo(
    () => pools.find((pool) => pool.id === selected) ?? null,
    [pools, selected],
  );
  const flowPool = useMemo(
    () => pools.find((pool) => pool.id === flow?.flow.poolId) ?? null,
    [pools, flow],
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
      setFlowId(created.flow.id);
      localStorage.setItem("omnilp.flow", created.flow.id);
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
      localStorage.setItem("omnilp.flow", next.flow.id);
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
    await navigator.clipboard.writeText(flow.flow.id);
    tap("success");
  }

  async function proveBaseAction() {
    if (!flow || !baseWallet) return;
    setBusy(true);
    setError("");
    try {
      const challenge = await getChallenge(flow.flow.id, "base");
      const signature = await signBaseMessage(challenge.value);
      await submitBaseProof(flow.flow.id, challenge.value, signature);
      setProved((current) => ({ ...current, base: true }));
      tap("success");
    } catch (cause) {
      tap("error");
      setError(
        cause instanceof Error ? cause.message : "Base proof was not accepted.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function proveTonAction() {
    if (!flow) return;
    setBusy(true);
    setError("");
    try {
      const challenge = await getChallenge(flow.flow.id, "ton");
      tonConnectUI.setConnectRequestParameters({
        state: "ready",
        value: { tonProof: challenge.value },
      });
      setTonNonce(challenge.value);
      if (connectedWallet) await tonConnectUI.disconnect();
      await tonConnectUI.connectWallet();
    } catch (cause) {
      setTonNonce("");
      tap("error");
      setError(
        cause instanceof Error ? cause.message : "TON proof was not accepted.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function runAction(action: string) {
    if (!flow) return;
    setBusy(true);
    setError("");
    try {
      if (action === "request_quote") {
        const next = await requestQuote(flow.flow.id);
        setFlow(next);
      } else if (action === "review_source") {
        const orderData = await getOrderData(flow.flow.id);
        const typedData = orderData.typedData as {
          types: Record<string, unknown[]>;
          domain: Record<string, unknown>;
          message: Record<string, unknown>;
          primaryType: string;
        };
        const signature = await signBaseTypedData(JSON.stringify(typedData));
        const txResult = await sendBaseTransaction({
          to: String(typedData.domain.verifyingContract),
          value: "0x0",
          data: String(typedData.message.input_asset),
        });
        const result = await submitSourceOrder(
          flow.flow.id,
          signature,
          txResult,
        );
        setFlow((current) =>
          current ? { ...current, flow: result.flow } : current,
        );
      } else if (action === "build_deposit_plan") {
        const result = await buildDepositPlan(flow.flow.id);
        setFlow((current) =>
          current
            ? { ...current, flow: result.flow, plan: result.plan }
            : current,
        );
      } else if (action === "submit_deposit") {
        const preview = await getDepositTx(flow.flow.id);
        const { hash } = await sendTonTransaction(preview.transaction);
        const result = await submitDeposit(
          flow.flow.id,
          hash,
          1,
          flow.flow.version,
        );
        setFlow((current) =>
          current ? { ...current, flow: result.flow } : current,
        );
      } else if (action === "start_exit") {
        const result = await buildWithdrawalPlan(flow.flow.id);
        setFlow((current) =>
          current ? { ...current, flow: result.flow } : current,
        );
        setFlowId(result.flow.id);
        localStorage.setItem("omnilp.flow", result.flow.id);
      } else if (
        action === "build_withdrawal" ||
        action === "submit_withdrawal"
      ) {
        const preview = await getWithdrawTx(
          flow.flow.id,
          flow.flow.sourceUnits,
        );
        const { hash } = await sendTonTransaction(preview.transaction);
        const result = await submitWithdraw(
          flow.flow.id,
          hash,
          1,
          flow.flow.version,
        );
        setFlow((current) =>
          current ? { ...current, flow: result.flow } : current,
        );
      } else if (action === "request_exit_quote") {
        const next = await requestExitQuote(flow.flow.id);
        setFlow(next);
      } else if (action === "review_exit") {
        const orderData = await getOrderData(flow.flow.id);
        const typedData = orderData.typedData as {
          types: Record<string, unknown[]>;
          domain: Record<string, unknown>;
          message: Record<string, unknown>;
          primaryType: string;
        };
        const signature = await signBaseTypedData(JSON.stringify(typedData));
        const preview = await getWithdrawTx(
          flow.flow.id,
          flow.flow.sourceUnits,
        );
        const { hash: tonTxHash } = await sendTonTransaction(
          preview.transaction,
        );
        const result = await submitExit(
          flow.flow.id,
          signature,
          tonTxHash,
          1,
          flow.flow.version,
        );
        setFlow((current) =>
          current ? { ...current, flow: result.flow } : current,
        );
      } else if (action === "refresh_trade") {
        const t = await getTradeStatus(flow.flow.id);
        setTrade(t);
      } else if (action === "withdraw_source") {
        const withdrawData = await getSourceWithdrawData(flow.flow.id);
        const txParams = await buildSourceWithdrawTx({
          sourceProtocolAddress: withdrawData.sourceProtocolAddress,
          inputUnits: withdrawData.inputUnits,
        });
        const txHash = await sendBaseTransaction(txParams);
        const result = await submitSourceWithdraw(
          flow.flow.id,
          txHash,
          1,
          flow.flow.version,
        );
        setFlow((current) =>
          current ? { ...current, flow: result.flow } : current,
        );
      }
      tap("success");
    } catch (cause) {
      tap("error");
      setError(cause instanceof Error ? cause.message : "Action failed.");
    } finally {
      setBusy(false);
    }
  }

  async function acceptPlan() {
    if (!flow) return;
    setBusy(true);
    setError("");
    try {
      const result = await buildDepositPlan(flow.flow.id, true);
      setFlow((current) =>
        current
          ? { ...current, flow: result.flow, plan: result.plan }
          : current,
      );
      tap("success");
    } catch (cause) {
      tap("error");
      setError(
        cause instanceof Error ? cause.message : "Plan was not accepted.",
      );
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!flow) return;
    if (
      [
        "trade_pending",
        "trade_partial",
        "trade_failed",
        "trade_unknown",
      ].includes(flow.flow.state)
    ) {
      void getTradeStatus(flow.flow.id)
        .then(setTrade)
        .catch(() => {});
    }
  }, [flow]);

  useEffect(() => {
    if (!flow || !tonNonce || !connectedWallet) return;
    const reply = connectedWallet.connectItems?.tonProof;
    if (!reply || !("proof" in reply)) return;
    const account = connectedWallet.account;
    if (!account) return;
    setTonNonce("");
    setBusy(true);
    setError("");
    void (async () => {
      try {
        await submitTonProof(flow.flow.id, {
          address: account.address,
          network: "-239",
          publicKey: account.publicKey ?? "",
          walletStateInit: account.walletStateInit,
          proof: {
            timestamp: reply.proof.timestamp,
            domain: reply.proof.domain,
            signature: reply.proof.signature,
            payload: reply.proof.payload,
          },
        });
        setProved((current) => ({ ...current, ton: true }));
        tap("success");
      } catch (cause) {
        tap("error");
        setError(
          cause instanceof Error
            ? cause.message
            : "TON proof was not accepted.",
        );
      } finally {
        setBusy(false);
      }
    })();
  }, [connectedWallet, flow, tonNonce]);

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
                  <strong>{flowPool?.token0.symbol ?? "USDC"}</strong>
                  <ArrowRight size={15} />
                  <strong>{flowPool?.token1.symbol ?? flow.flow.poolId}</strong>
                </span>
                <b>{stateLabel(flow.flow.state)}</b>
              </div>
              <button
                className="flow-id"
                type="button"
                onClick={() => void copyFlow()}
              >
                <code>{short(flow.flow.id)}</code>
                <Copy size={15} />
              </button>

              <ol className="timeline">
                {(flow.flow.type === "exit"
                  ? exitTimeline(flow.flow.state)
                  : entryTimeline(flow.flow.state)
                ).map((item) => (
                  <li key={item.label} className={item.state}>
                    <span>
                      {item.state === "done" ? (
                        <Check size={13} />
                      ) : item.state === "current" ? (
                        <Clock3 size={13} />
                      ) : null}
                    </span>
                    <div>
                      <strong>{item.label}</strong>
                      <small>{item.note}</small>
                    </div>
                  </li>
                ))}
              </ol>

              {["draft", "quote_expired", "source_rejected"].includes(
                flow.flow.state,
              ) && (
                <section className="proof-card">
                  <div className="section-title">
                    <div>
                      <span>Ownership</span>
                      <h3>Wallet proof</h3>
                    </div>
                    <KeyRound size={19} />
                  </div>
                  <div className="proof-row">
                    <span>
                      <strong>Base wallet</strong>
                      <small>
                        {proved.base ? "Verified" : "Sign a one-time message"}
                      </small>
                    </span>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy || !baseWallet}
                      onClick={() => void proveBaseAction()}
                    >
                      {proved.base ? "Done" : "Prove"}
                    </button>
                  </div>
                  <div className="proof-row">
                    <span>
                      <strong>TON wallet</strong>
                      <small>
                        {proved.ton
                          ? "Verified"
                          : "Reconnect with a signed proof"}
                      </small>
                    </span>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy || !connectedTon}
                      onClick={() => void proveTonAction()}
                    >
                      {proved.ton ? "Done" : "Prove"}
                    </button>
                  </div>
                  {session?.demo && (
                    <p className="notice hint">
                      Test wallets cannot sign proofs; connect real wallets to
                      continue past this step.
                    </p>
                  )}
                </section>
              )}

              {flow.flow.nextActions.length > 0 && (
                <section className="action-card">
                  <div className="section-title">
                    <div>
                      <span>Next step</span>
                      <h3>Actions</h3>
                    </div>
                    <Sparkles size={19} />
                  </div>
                  {flow.flow.nextActions.map((action) => {
                    const executable = executableActions.has(action);
                    const needsProofs =
                      action === "request_quote" &&
                      (!proved.base || !proved.ton);
                    return (
                      <button
                        key={action}
                        type="button"
                        className={executable ? "primary" : "secondary"}
                        disabled={busy || needsProofs || !executable}
                        onClick={() =>
                          action === "review_deposit"
                            ? void acceptPlan()
                            : void runAction(action)
                        }
                      >
                        {actionLabels[action] ?? action}
                        {!executable && (
                          <span className="locked-tag">Locked</span>
                        )}
                      </button>
                    );
                  })}
                  <p className="notice hint">
                    Route execution stays locked until signed evidence passes.
                  </p>
                </section>
              )}

              {flow.quote && (
                <section className="quote-card">
                  <div className="section-title">
                    <div>
                      <span>Cross-chain</span>
                      <h3>Quote</h3>
                    </div>
                    <WalletCards size={19} />
                  </div>
                  <dl className="detail-list">
                    <div>
                      <dt>You send</dt>
                      <dd>{formatAmount(flow.quote.inputUnits, 6, 2)} USDC</dd>
                    </div>
                    <div>
                      <dt>Est. output</dt>
                      <dd>{formatAmount(flow.quote.outputUnits, 6, 2)} USDT</dd>
                    </div>
                    <div>
                      <dt>Protocol fee</dt>
                      <dd>
                        {formatAmount(flow.quote.protocolFeeUnits, 6, 4)} USDT
                      </dd>
                    </div>
                    <div>
                      <dt>Expires</dt>
                      <dd>
                        {new Date(flow.quote.expiresAt).toLocaleTimeString()}
                      </dd>
                    </div>
                    <div>
                      <dt>Resolver</dt>
                      <dd>{short(flow.quote.resolverId)}</dd>
                    </div>
                  </dl>
                </section>
              )}

              {flow.plan && (
                <section className="quote-card">
                  <div className="section-title">
                    <div>
                      <span>STON.fi V2</span>
                      <h3>
                        {flow.plan.indicative
                          ? "Indicative plan"
                          : "Deposit plan"}
                      </h3>
                    </div>
                    <BadgeCheck size={19} />
                  </div>
                  <dl className="detail-list">
                    <div>
                      <dt>Mode</dt>
                      <dd>{flow.plan.mode}</dd>
                    </div>
                    <div>
                      <dt>Input</dt>
                      <dd>{formatAmount(flow.plan.inputUnits, 6, 2)} USDT</dd>
                    </div>
                    <div>
                      <dt>Min LP</dt>
                      <dd>{flow.plan.minLpUnits}</dd>
                    </div>
                    <div>
                      <dt>Price impact</dt>
                      <dd>
                        {(flow.plan.priceImpactPips / 10_000).toFixed(2)}%
                      </dd>
                    </div>
                    <div>
                      <dt>Router</dt>
                      <dd>{short(flow.plan.routerAddress)}</dd>
                    </div>
                  </dl>
                  {flow.flow.state === "deposit_changed" && (
                    <button
                      className="primary"
                      type="button"
                      disabled={busy}
                      onClick={() => void acceptPlan()}
                    >
                      Accept changed plan
                      <Check size={16} />
                    </button>
                  )}
                </section>
              )}

              {[
                "trade_pending",
                "trade_partial",
                "trade_failed",
                "trade_unknown",
              ].includes(flow.flow.state) &&
                trade && (
                  <section className="quote-card">
                    <div className="section-title">
                      <div>
                        <span>Omniston</span>
                        <h3>Trade status</h3>
                      </div>
                      <Clock3 size={19} />
                    </div>
                    <dl className="detail-list">
                      <div>
                        <dt>Status</dt>
                        <dd>{trade.status}</dd>
                      </div>
                      <div>
                        <dt>Order</dt>
                        <dd>{short(trade.orderHash)}</dd>
                      </div>
                      {trade.receivedUnits && (
                        <div>
                          <dt>Received</dt>
                          <dd>
                            {formatAmount(trade.receivedUnits, 6, 2)} USDT
                          </dd>
                        </div>
                      )}
                      <div>
                        <dt>Checked</dt>
                        <dd>
                          {new Date(trade.checkedAt).toLocaleTimeString()}
                        </dd>
                      </div>
                    </dl>
                  </section>
                )}

              {flow.flow.state === "deposit_ready" && (
                <section className="action-card">
                  <div className="section-title">
                    <div>
                      <span>Ready</span>
                      <h3>Submit deposit</h3>
                    </div>
                    <WalletCards size={19} />
                  </div>
                  <p className="notice hint">
                    Use TON Connect to send a deposit transaction to the STON.fi
                    router.
                  </p>
                </section>
              )}

              {flow.flow.type === "exit" &&
                [
                  "exit_quoted",
                  "exit_pending",
                  "exit_complete",
                  "exit_failed",
                ].includes(flow.flow.state) &&
                flow.quote && (
                  <section className="quote-card">
                    <div className="section-title">
                      <div>
                        <span>Exit</span>
                        <h3>Exit quote</h3>
                      </div>
                      <WalletCards size={19} />
                    </div>
                    <dl className="detail-list">
                      <div>
                        <dt>Input</dt>
                        <dd>
                          {formatAmount(flow.quote.inputUnits, 6, 2)} USDT
                        </dd>
                      </div>
                      <div>
                        <dt>Est. output</dt>
                        <dd>
                          {formatAmount(flow.quote.outputUnits, 6, 2)} USDC
                        </dd>
                      </div>
                      <div>
                        <dt>Expires</dt>
                        <dd>
                          {new Date(flow.quote.expiresAt).toLocaleTimeString()}
                        </dd>
                      </div>
                    </dl>
                  </section>
                )}

              {flow.flow.state === "complete" && (
                <section className="quote-card">
                  <div className="section-title">
                    <div>
                      <span>Position</span>
                      <h3>LP position open</h3>
                    </div>
                    <BadgeCheck size={19} />
                  </div>
                  <p className="notice hint">
                    Your LP position is live. Use the Exit tab to close it.
                  </p>
                </section>
              )}

              {flow.flow.state === "exit_complete" && (
                <section className="quote-card">
                  <div className="section-title">
                    <div>
                      <span>Complete</span>
                      <h3>Funds returned</h3>
                    </div>
                    <Check size={19} />
                  </div>
                  <p className="notice hint">
                    USDC has been returned to your Base wallet.
                  </p>
                </section>
              )}
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
