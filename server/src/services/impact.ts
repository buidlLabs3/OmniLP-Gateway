import type { Flow, Impact } from "@omnilp/shared";

import type { PositionRecord, TransactionRecord } from "../store/types.js";

function median(values: bigint[]): string {
  if (values.length === 0) return "0";
  const sorted = [...values].sort((left, right) =>
    left === right ? 0 : left > right ? 1 : -1,
  );
  const middle = Math.floor(sorted.length / 2);
  const value = sorted[middle];
  if (value === undefined) return "0";
  if (sorted.length % 2 === 1) return value.toString();
  const prior = sorted[middle - 1] ?? value;
  return ((prior + value) / 2n).toString();
}

export function getImpact(
  flows: Flow[],
  transactions: TransactionRecord[],
  positions: PositionRecord[],
  now = Date.now(),
): Impact {
  const completed = flows.filter(
    (flow) => flow.state === "complete" || flow.state === "exit_complete",
  );
  const entryFlows = completed.filter((flow) => flow.type === "entry");
  const completedIds = new Set(entryFlows.map((flow) => flow.id));
  const confirmedSourceIds = new Set(
    transactions
      .filter((tx) => tx.kind === "source" && tx.status === "confirmed")
      .map((tx) => tx.flowId),
  );
  const routed = entryFlows
    .filter((flow) => confirmedSourceIds.has(flow.id))
    .reduce((total, flow) => total + BigInt(flow.sourceUnits), 0n);
  const open = positions.filter(
    (position) =>
      position.closedAt === null && completedIds.has(position.flowId),
  );
  const deposited = open.reduce(
    (total, position) => total + BigInt(position.entryValueUsdUnits),
    0n,
  );
  const retained = (days: number) =>
    open
      .filter(
        (position) => now - Date.parse(position.openedAt) >= days * 86_400_000,
      )
      .reduce(
        (total, position) => total + BigInt(position.entryValueUsdUnits),
        0n,
      );
  const started = flows.filter((flow) => flow.type === "entry").length;
  const poolMap = new Map<string, { value: bigint; positions: number }>();
  for (const position of open) {
    const item = poolMap.get(position.poolId) ?? { value: 0n, positions: 0 };
    item.value += BigInt(position.entryValueUsdUnits);
    item.positions += 1;
    poolMap.set(position.poolId, item);
  }

  return {
    checkedAt: new Date(now).toISOString(),
    routedUsdcUnits: routed.toString(),
    depositedUsdUnits: deposited.toString(),
    retained7dUsdUnits: retained(7).toString(),
    retained30dUsdUnits: retained(30).toString(),
    completedEntries: entryFlows.length,
    completedExits: completed.filter((flow) => flow.state === "exit_complete")
      .length,
    sourceWithdrawals: flows.filter((flow) => flow.state === "source_withdrawn")
      .length,
    completionPips:
      started === 0 ? 0 : Math.floor((entryFlows.length * 1_000_000) / started),
    medianEntryUnits: median(
      entryFlows.map((flow) => BigInt(flow.sourceUnits)),
    ),
    pools: [...poolMap.entries()].map(([poolId, item]) => ({
      poolId,
      depositUsdUnits: item.value.toString(),
      positions: item.positions,
    })),
  };
}
