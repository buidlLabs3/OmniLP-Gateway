import {
  AppError,
  type DepositPlan,
  type Flow,
  type Pool,
} from "@omnilp/shared";
import { Address, beginCell, toNano } from "@ton/ton";

import type { Config } from "../config.js";

const DEPOSIT_METHOD_ID = 0xfcf9e58f;
const JETTON_BURN_OPCODE = 0x595f3b01;

function parseAddress(value: string): Address {
  try {
    return Address.parse(value);
  } catch {
    throw new AppError("BAD_REQUEST", `Invalid TON address: ${value}`, 400);
  }
}

function buildProvideLiquidityPayload(
  poolAddress: Address,
  minLpUnits: bigint,
): string {
  const payload = beginCell()
    .storeUint(DEPOSIT_METHOD_ID, 32)
    .storeUint(0, 1) // query_id
    .storeAddress(poolAddress)
    .storeCoins(0) // token_amount (set by jetton transfer amount)
    .storeCoins(minLpUnits)
    .storeUint(0, 1) // forward_payload (maybe)
    .storeUint(Math.floor(Date.now() / 1_000) + 600, 64) // deadline
    .endCell();

  return payload.toBoc().toString("base64");
}

function buildJettonBurnPayload(
  lpUnits: bigint,
  jettonMaster: Address,
): string {
  const payload = beginCell()
    .storeUint(JETTON_BURN_OPCODE, 32)
    .storeUint(0, 64) // query_id
    .storeCoins(lpUnits)
    .storeAddress(jettonMaster) // destination (burn to master)
    .storeAddress(null) // response_destination
    .storeUint(0, 1) // custom_payload
    .storeUint(0, 64) // forward_ton_amount
    .storeUint(0, 1) // forward_payload
    .endCell();

  return payload.toBoc().toString("base64");
}

export interface WalletTransaction {
  validUntil: number;
  messages: Array<{
    address: string;
    amount: string;
    payload?: string;
    stateInit?: string;
  }>;
}

export interface DepositPreview {
  transaction: WalletTransaction;
  plan: DepositPlan;
  gasUnits: string;
}

export interface WithdrawPreview {
  transaction: WalletTransaction;
  lpUnits: string;
  poolAddress: string;
  gasUnits: string;
}

export class TonTxService {
  constructor(private readonly config: Config) {}

  buildDepositTx(flow: Flow, pool: Pool, plan: DepositPlan): DepositPreview {
    const routerAddress = parseAddress(plan.routerAddress);
    const poolAddress = parseAddress(pool.address);

    const minLpUnits = BigInt(plan.minLpUnits);
    const payload = buildProvideLiquidityPayload(poolAddress, minLpUnits);

    const validUntil = Math.floor(Date.now() / 1_000) + 600;

    const transaction: WalletTransaction = {
      validUntil,
      messages: [
        {
          address: routerAddress.toString(),
          amount: this.config.TON_DEPOSIT_GAS_UNITS,
          payload,
        },
      ],
    };

    return {
      transaction,
      plan,
      gasUnits: this.config.TON_DEPOSIT_GAS_UNITS,
    };
  }

  buildWithdrawTx(flow: Flow, pool: Pool, lpUnits: string): WithdrawPreview {
    const lpAddress = parseAddress(pool.address);
    const validUntil = Math.floor(Date.now() / 1_000) + 600;

    const payload = buildJettonBurnPayload(BigInt(lpUnits), lpAddress);

    const transaction: WalletTransaction = {
      validUntil,
      messages: [
        {
          address: lpAddress.toString(),
          amount: toNano("0.05").toString(),
          payload,
        },
      ],
    };

    return {
      transaction,
      lpUnits,
      poolAddress: pool.address,
      gasUnits: toNano("0.05").toString(),
    };
  }
}
