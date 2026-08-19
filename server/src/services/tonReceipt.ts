import { AppError, sameTonAddress, type Flow } from "@omnilp/shared";
import { Address, beginCell, TonClient } from "@ton/ton";

import type { Config } from "../config.js";

const JETTON_WALLET_OPCODE = 0x7362d09c;

async function jettonBalance(
  client: TonClient,
  walletAddress: Address,
  jettonMaster: Address,
): Promise<bigint> {
  const result = await client.runMethod(walletAddress, "get_wallet_data");
  const slice = result.stack.readCell().beginParse();
  const balance = slice.loadCoins();
  const owner = slice.loadAddress();
  const master = slice.loadAddress();
  if (!master.equals(jettonMaster)) {
    throw new AppError(
      "UPSTREAM_FAILED",
      "Jetton wallet master does not match expected token",
      502,
    );
  }
  return balance;
}

function jettonWalletAddress(
  ownerAddress: Address,
  jettonMaster: Address,
): Address {
  const data = beginCell()
    .storeUint(0, 2)
    .storeAddress(ownerAddress)
    .storeAddress(jettonMaster)
    .endCell();
  const hash = data.hash();
  return new Address(0, hash);
}

export class TonReceiptService {
  private readonly client: TonClient;

  constructor(config: Config) {
    this.client = new TonClient({ endpoint: config.TON_RPC_URL });
  }

  /**
   * Check that a TON wallet received USDT by querying the jetton wallet
   * balance on-chain. Returns the current balance in base units.
   */
  async getUsdtBalance(walletAddress: string): Promise<string> {
    const owner = Address.parse(walletAddress);
    const master = Address.parse(
      "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs",
    );
    const wallet = jettonWalletAddress(owner, master);
    try {
      const balance = await jettonBalance(this.client, wallet, master);
      return balance.toString();
    } catch (error) {
      if (error instanceof AppError) throw error;
      // Wallet may not exist yet (zero balance)
      return "0";
    }
  }

  /**
   * Verify that a wallet received at least `minUnits` USDT after a baseline.
   * Returns "confirmed" if the balance increased by at least minUnits,
   * "pending" if not yet detected, or "failed" if the balance decreased.
   */
  async verifyReceipt(
    walletAddress: string,
    baselineUnits: string,
    minUnits: string,
  ): Promise<"confirmed" | "pending" | "failed"> {
    const current = await this.getUsdtBalance(walletAddress);
    const currentBig = BigInt(current);
    const baselineBig = BigInt(baselineUnits);
    const minBig = BigInt(minUnits);

    const delta = currentBig - baselineBig;
    if (delta >= minBig) return "confirmed";
    if (delta < 0n) return "failed";
    return "pending";
  }

  /**
   * Record the baseline USDT balance before a cross-chain trade,
   * then verify receipt after.
   */
  async recordBaseline(walletAddress: string): Promise<string> {
    return this.getUsdtBalance(walletAddress);
  }
}
