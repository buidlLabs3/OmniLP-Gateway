import { z } from "zod";

export const flowStates = [
  "draft",
  "quoted",
  "source_pending",
  "trade_pending",
  "trade_filled",
  "funds_received",
  "deposit_ready",
  "deposit_pending",
  "complete",
  "quote_expired",
  "source_rejected",
  "trade_partial",
  "trade_failed",
  "trade_unknown",
  "source_withdrawal_available",
  "source_withdrawn",
  "deposit_changed",
  "deposit_failed",
  "cancelled",
  "exit_draft",
  "withdraw_ready",
  "withdraw_pending",
  "withdraw_failed",
  "assets_received",
  "exit_quoted",
  "exit_pending",
  "exit_failed",
  "exit_quote_expired",
  "exit_complete",
] as const;

export const flowStateSchema = z.enum(flowStates);
export type FlowState = z.infer<typeof flowStateSchema>;

const transitions: Readonly<Record<FlowState, readonly FlowState[]>> = {
  draft: ["quoted", "cancelled"],
  quoted: ["source_pending", "quote_expired", "cancelled"],
  source_pending: ["trade_pending", "source_rejected", "trade_unknown"],
  trade_pending: [
    "trade_filled",
    "trade_partial",
    "trade_failed",
    "trade_unknown",
    "source_withdrawal_available",
  ],
  trade_filled: ["funds_received", "trade_unknown"],
  funds_received: ["deposit_ready", "deposit_changed"],
  deposit_ready: ["deposit_pending", "deposit_changed", "cancelled"],
  deposit_pending: ["complete", "deposit_failed"],
  complete: ["exit_draft"],
  quote_expired: ["quoted", "cancelled"],
  source_rejected: ["quoted", "cancelled"],
  trade_partial: ["source_withdrawal_available", "cancelled"],
  trade_failed: ["source_withdrawal_available", "cancelled"],
  trade_unknown: [
    "trade_pending",
    "trade_filled",
    "trade_partial",
    "trade_failed",
    "source_withdrawal_available",
  ],
  source_withdrawal_available: ["source_withdrawn"],
  source_withdrawn: [],
  deposit_changed: ["deposit_ready", "cancelled"],
  deposit_failed: ["deposit_ready", "deposit_changed", "cancelled"],
  cancelled: [],
  exit_draft: ["withdraw_ready", "cancelled"],
  withdraw_ready: ["withdraw_pending", "cancelled"],
  withdraw_pending: ["assets_received", "withdraw_failed"],
  withdraw_failed: ["withdraw_ready", "cancelled"],
  assets_received: ["exit_quoted", "cancelled"],
  exit_quoted: ["exit_pending", "exit_quote_expired", "cancelled"],
  exit_quote_expired: ["exit_quoted", "cancelled"],
  exit_pending: ["exit_complete", "exit_failed", "trade_unknown"],
  exit_failed: ["exit_quoted", "cancelled"],
  exit_complete: [],
};

export function canSetState(current: FlowState, next: FlowState): boolean {
  return transitions[current].includes(next);
}

export function assertState(current: FlowState, next: FlowState): void {
  if (!canSetState(current, next))
    throw new Error(`Cannot change flow from ${current} to ${next}`);
}

export function getNextActions(state: FlowState): readonly string[] {
  const actions: Partial<Record<FlowState, readonly string[]>> = {
    draft: ["request_quote"],
    quoted: ["review_source"],
    source_rejected: ["request_quote"],
    quote_expired: ["request_quote"],
    trade_unknown: ["refresh_trade"],
    source_withdrawal_available: ["withdraw_source"],
    funds_received: ["build_deposit_plan"],
    deposit_changed: ["review_deposit"],
    deposit_ready: ["submit_deposit"],
    deposit_failed: ["build_deposit_plan"],
    complete: ["view_position", "start_exit"],
    exit_draft: ["build_withdrawal"],
    withdraw_ready: ["submit_withdrawal"],
    withdraw_failed: ["build_withdrawal"],
    assets_received: ["request_exit_quote"],
    exit_quoted: ["review_exit"],
    exit_quote_expired: ["request_exit_quote"],
    exit_failed: ["request_exit_quote"],
  };
  return actions[state] ?? [];
}
