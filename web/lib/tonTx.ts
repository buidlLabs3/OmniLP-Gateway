import type { WalletTransaction } from "./api";

declare global {
  interface Window {
    TonConnectUI?: {
      sendTransaction: (tx: WalletTransaction) => Promise<{ boc?: string }>;
    };
  }
}

function getTonConnectUI() {
  const ui = window.TonConnectUI;
  if (!ui) throw new Error("TON Connect is not available");
  return ui;
}

export async function sendTonTransaction(
  transaction: WalletTransaction,
): Promise<{ hash: string }> {
  const ui = getTonConnectUI();
  const result = await ui.sendTransaction(transaction);
  if (!result.boc) throw new Error("Transaction was not sent");
  return { hash: result.boc };
}
