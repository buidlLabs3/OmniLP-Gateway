import {
  AppError,
  sameBaseAddress,
  type Flow,
  type Quote,
} from "@omnilp/shared";
import { createPublicClient, http, type Hash } from "viem";
import { base } from "viem/chains";

import type { Config } from "../config.js";

export class BaseService {
  private readonly client;

  constructor(config: Config) {
    this.client = createPublicClient({
      chain: base,
      transport: http(config.BASE_RPC_URL),
    });
  }

  async verifySource(hash: string, flow: Flow, quote: Quote) {
    const [transaction, receipt, block] = await Promise.all([
      this.client.getTransaction({ hash: hash as Hash }),
      this.client.getTransactionReceipt({ hash: hash as Hash }),
      this.client.getBlockNumber(),
    ]);
    if (receipt.status === "reverted") return "failed" as const;
    if (
      !sameBaseAddress(transaction.from, flow.baseWallet) ||
      !transaction.to ||
      !sameBaseAddress(transaction.to, quote.sourceProtocolAddress)
    ) {
      throw new AppError(
        "PROOF_REQUIRED",
        "Base transaction does not match the source order",
        409,
      );
    }
    return block - receipt.blockNumber >= 2n
      ? ("confirmed" as const)
      : ("pending" as const);
  }

  async verifyExit(hash: string, flow: Flow, quote: Quote, usdc: string) {
    const [receipt, block] = await Promise.all([
      this.client.getTransactionReceipt({ hash: hash as Hash }),
      this.client.getBlockNumber(),
    ]);
    if (receipt.status === "reverted") return "failed" as const;
    const transferTopic =
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    const walletTopic = `0x${flow.baseWallet.slice(2).toLowerCase().padStart(64, "0")}`;
    const received = receipt.logs.some(
      (log) =>
        sameBaseAddress(log.address, usdc) &&
        log.topics[0]?.toLowerCase() === transferTopic &&
        log.topics[2]?.toLowerCase() === walletTopic &&
        BigInt(log.data) >= BigInt(quote.outputUnits),
    );
    if (!received) {
      throw new AppError(
        "PROOF_REQUIRED",
        "Base receipt has no matching USDC transfer",
        409,
      );
    }
    return block - receipt.blockNumber >= 2n
      ? ("confirmed" as const)
      : ("pending" as const);
  }
}
