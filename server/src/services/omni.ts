import { createHash, randomUUID } from "node:crypto";

import {
  AppError,
  BASE_USDC,
  TON_USDT,
  type Direction,
  type Quote,
  type Flow,
} from "@omnilp/shared";

import type { Config } from "../config.js";

interface QuoteMessage {
  rfqId?: string;
  rfq_id?: string;
  quoteId?: string;
  quote_id?: string;
  resolverId?: string;
  resolver_id?: string;
  inputAsset?: unknown;
  input_asset?: unknown;
  outputAsset?: unknown;
  output_asset?: unknown;
  inputUnits?: string;
  input_units?: string;
  outputUnits?: string;
  output_units?: string;
  integratorFeeUnits?: string;
  integrator_fee_units?: string;
  protocolFeeUnits?: string;
  protocol_fee_units?: string;
  quoteTimestamp?: number | string;
  quote_timestamp?: number | string;
  order?: unknown;
  settlementData?: unknown;
  settlement_data?: unknown;
}

interface EventValue {
  ack?: { rfqId?: string; rfq_id?: string };
  quoteUpdated?: {
    rfqId?: string;
    rfq_id?: string;
    quote?: QuoteMessage;
  } & QuoteMessage;
  quote_updated?: {
    rfqId?: string;
    rfq_id?: string;
    quote?: QuoteMessage;
  } & QuoteMessage;
  noQuote?: { rfqId?: string; rfq_id?: string };
  no_quote?: { rfqId?: string; rfq_id?: string };
  keepAlive?: unknown;
  keep_alive?: unknown;
}

interface RpcMessage extends EventValue {
  id?: string;
  result?: EventValue;
  params?: EventValue & { result?: EventValue };
  error?: { message?: string };
}

function value<T>(
  item: T,
  snake: keyof T,
  camel: keyof T,
): T[keyof T] | undefined {
  return item[snake] ?? item[camel];
}

function eventFrom(
  message: RpcMessage,
):
  | { type: "ack"; rfqId: string }
  | { type: "quote"; rfqId?: string; quote: QuoteMessage }
  | { type: "none"; rfqId?: string }
  | { type: "keep" }
  | null {
  const values = [
    message.result,
    message.params?.result,
    message.params,
    message,
  ];
  for (const item of values) {
    if (!item || typeof item !== "object") continue;
    const events = [
      item.ack,
      item.quoteUpdated ?? item.quote_updated,
      item.noQuote ?? item.no_quote,
      item.keepAlive ?? item.keep_alive,
    ].filter((entry) => entry !== undefined);
    if (events.length > 1)
      throw new AppError("QUOTE_INVALID", "Ambiguous quote stream event", 502);
    if (item.ack) {
      const rfqId = item.ack.rfqId ?? item.ack.rfq_id;
      if (!rfqId)
        throw new AppError(
          "QUOTE_INVALID",
          "Quote acknowledgment has no RFQ ID",
          502,
        );
      return { type: "ack", rfqId };
    }
    const updated = item.quoteUpdated ?? item.quote_updated;
    if (updated) {
      const eventRfqId = updated.rfqId ?? updated.rfq_id;
      return {
        type: "quote",
        ...(eventRfqId ? { rfqId: eventRfqId } : {}),
        quote: updated.quote ?? updated,
      };
    }
    const none = item.noQuote ?? item.no_quote;
    if (none) {
      const eventRfqId = none.rfqId ?? none.rfq_id;
      return { type: "none", ...(eventRfqId ? { rfqId: eventRfqId } : {}) };
    }
    if (item.keepAlive !== undefined || item.keep_alive !== undefined)
      return { type: "keep" };
  }
  return null;
}

function asset(direction: Direction): { input: unknown; output: unknown } {
  return direction === "entry"
    ? {
        input: { base: { erc20: BASE_USDC } },
        output: { ton: { jetton: TON_USDT } },
      }
    : {
        input: { ton: { jetton: TON_USDT } },
        output: { base: { erc20: BASE_USDC } },
      };
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function integer(item: unknown, name: string, allowZero = false): bigint {
  if (typeof item !== "string" || !/^\d+$/.test(item)) {
    throw new AppError(
      "QUOTE_INVALID",
      `${name} is not an integer string`,
      502,
    );
  }
  const amount = BigInt(item);
  if (!allowZero && amount === 0n) {
    throw new AppError("QUOTE_INVALID", `${name} must be positive`, 502);
  }
  return amount;
}

function orderFrom(message: QuoteMessage): Record<string, unknown> {
  const direct = message.order;
  if (
    direct &&
    typeof direct === "object" &&
    !Array.isArray(direct) &&
    Object.keys(direct).length > 0
  ) {
    return direct as Record<string, unknown>;
  }
  const settlement = value(message, "settlement_data", "settlementData");
  if (
    !settlement ||
    typeof settlement !== "object" ||
    Array.isArray(settlement)
  ) {
    throw new AppError("QUOTE_INVALID", "Quote has no order settlement", 502);
  }
  const data = settlement as Record<string, unknown>;
  if (
    Object.keys(data).length !== 1 ||
    !data.order ||
    typeof data.order !== "object"
  ) {
    throw new AppError(
      "QUOTE_INVALID",
      "Quote settlement is not order-only",
      502,
    );
  }
  return data.order as Record<string, unknown>;
}

function chainAddress(
  item: unknown,
  chain: "base" | "ton",
  name: string,
): string {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new AppError("QUOTE_INVALID", `${name} is missing`, 502);
  }
  const data = item as Record<string, unknown>;
  if (Object.keys(data).length !== 1 || typeof data[chain] !== "string") {
    throw new AppError("QUOTE_INVALID", `${name} is on the wrong chain`, 502);
  }
  return data[chain];
}

function quoteFrom(
  message: QuoteMessage,
  flow: Flow,
  direction: Direction,
  rfqId: string,
): Quote {
  const assets = asset(direction);
  if (
    !same(value(message, "input_asset", "inputAsset"), assets.input) ||
    !same(value(message, "output_asset", "outputAsset"), assets.output)
  ) {
    throw new AppError(
      "QUOTE_INVALID",
      "Quote assets do not match the approved route",
      502,
    );
  }
  const messageRfqId = value(message, "rfq_id", "rfqId");
  const quoteId = value(message, "quote_id", "quoteId");
  const resolverId = value(message, "resolver_id", "resolverId");
  if (
    messageRfqId !== rfqId ||
    typeof quoteId !== "string" ||
    typeof resolverId !== "string"
  ) {
    throw new AppError("QUOTE_INVALID", "Quote identity is invalid", 502);
  }
  const input = integer(
    value(message, "input_units", "inputUnits"),
    "Quote input",
  );
  if (input.toString() !== flow.sourceUnits) {
    throw new AppError("QUOTE_INVALID", "Quote amount changed", 502);
  }
  const output = integer(
    value(message, "output_units", "outputUnits"),
    "Quote output",
  );
  const integratorFee = integer(
    value(message, "integrator_fee_units", "integratorFeeUnits"),
    "Integrator fee",
    true,
  );
  const protocolFee = integer(
    value(message, "protocol_fee_units", "protocolFeeUnits"),
    "Protocol fee",
    true,
  );
  const timestamp = Number(value(message, "quote_timestamp", "quoteTimestamp"));
  const now = Math.floor(Date.now() / 1_000);
  if (
    !Number.isSafeInteger(timestamp) ||
    timestamp < now - 120 ||
    timestamp > now + 60
  ) {
    throw new AppError(
      "QUOTE_INVALID",
      "Quote timestamp is stale or invalid",
      502,
    );
  }
  const order = orderFrom(message);
  const sourceChain = direction === "entry" ? "base" : "ton";
  const destinationChain = direction === "entry" ? "ton" : "base";
  const sourceProtocolAddress = chainAddress(
    value(order, "src_protocol_contract_address", "srcProtocolContractAddress"),
    sourceChain,
    "Source protocol",
  );
  const destinationProtocolAddress = chainAddress(
    value(order, "dst_protocol_contract_address", "dstProtocolContractAddress"),
    destinationChain,
    "Destination protocol",
  );
  const resolverSends = integer(
    value(order, "resolver_sends_units", "resolverSendsUnits"),
    "Resolver send amount",
  );
  if (resolverSends !== output + integratorFee + protocolFee) {
    throw new AppError("QUOTE_INVALID", "Quote fees do not reconcile", 502);
  }
  const deadline = Number(
    value(order, "trade_start_deadline", "tradeStartDeadline"),
  );
  if (
    !Number.isSafeInteger(deadline) ||
    deadline <= now ||
    deadline <= timestamp
  ) {
    throw new AppError(
      "QUOTE_EXPIRED",
      "Quote trade deadline has expired",
      409,
    );
  }
  return {
    id: quoteId,
    flowId: flow.id,
    direction,
    resolverId,
    inputUnits: input.toString(),
    outputUnits: output.toString(),
    protocolFeeUnits: protocolFee.toString(),
    integratorFeeUnits: integratorFee.toString(),
    sourceProtocolAddress,
    destinationProtocolAddress,
    quotedAt: new Date(timestamp * 1_000).toISOString(),
    expiresAt: new Date(deadline * 1_000).toISOString(),
  };
}

export interface OrderData {
  typedData: Record<string, unknown>;
  orderExtension: string;
  owner: string;
  recipient: string;
  inputUnits: string;
  expiresAt: string;
}

export class OmniService {
  constructor(private readonly config: Config) {}

  async getQuote(
    flow: Flow,
    direction: Direction,
  ): Promise<{ quote: Quote; hash: string }> {
    const assets = asset(direction);
    const request = {
      inputAsset: assets.input,
      outputAsset: assets.output,
      inputUnits: flow.sourceUnits,
      settlementParams: [{ order: {} }],
    };
    const message = await this.quoteOnce(request);
    const quote = quoteFrom(message.quote, flow, direction, message.rfqId);
    const hash = createHash("sha256")
      .update(JSON.stringify(quote))
      .digest("hex");
    return { quote, hash };
  }

  buildOrderData(flow: Flow, quote: Quote): OrderData {
    const owner = flow.baseWallet;
    const recipient = flow.tonWallet;
    const sourceAssets = asset(quote.direction);
    const deadline = Math.floor(Date.parse(quote.expiresAt) / 1_000);
    const nonce = BigInt(quote.id) & ((1n << 96n) - 1n);
    const typedData = {
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        Order: [
          { name: "owner_src_address", type: "address" },
          { name: "trader_dst_address", type: "string" },
          { name: "input_asset", type: "bytes" },
          { name: "output_asset", type: "bytes" },
          { name: "input_amount", type: "uint256" },
          { name: "min_output_amount", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "nonce", type: "uint96" },
          { name: "fee", type: "uint256" },
          { name: "src_protocol_address", type: "address" },
          { name: "dst_protocol_address", type: "address" },
          { name: "resolver_id", type: "string" },
        ],
      },
      primaryType: "Order",
      domain: {
        name: "OmnistonCrosschainOrder",
        version: "1",
        chainId: 8453,
        verifyingContract: quote.sourceProtocolAddress,
      },
      message: {
        owner_src_address: owner,
        trader_dst_address: recipient,
        input_asset: JSON.stringify(sourceAssets.input),
        output_asset: JSON.stringify(sourceAssets.output),
        input_amount: quote.inputUnits,
        min_output_amount: quote.outputUnits,
        deadline,
        nonce: nonce.toString(),
        fee: (
          BigInt(quote.protocolFeeUnits) + BigInt(quote.integratorFeeUnits)
        ).toString(),
        src_protocol_address: quote.sourceProtocolAddress,
        dst_protocol_address: quote.destinationProtocolAddress,
        resolver_id: quote.resolverId,
      },
    };
    const orderExtension = JSON.stringify({
      owner_src_address: owner,
      trader_dst_address: recipient,
      input_asset: sourceAssets.input,
      output_asset: sourceAssets.output,
      input_amount: quote.inputUnits,
      min_output_amount: quote.outputUnits,
      deadline,
      nonce: nonce.toString(),
      fee: (
        BigInt(quote.protocolFeeUnits) + BigInt(quote.integratorFeeUnits)
      ).toString(),
      src_protocol_contract_address: quote.sourceProtocolAddress,
      dst_protocol_contract_address: quote.destinationProtocolAddress,
      resolver_id: quote.resolverId,
    });
    return {
      typedData,
      orderExtension,
      owner,
      recipient,
      inputUnits: quote.inputUnits,
      expiresAt: quote.expiresAt,
    };
  }

  async registerOrder(
    flow: Flow,
    quote: Quote,
    signature: string,
  ): Promise<{ tradeId: string; rfqId: string }> {
    const orderData = this.buildOrderData(flow, quote);
    const order = JSON.parse(orderData.orderExtension) as Record<
      string,
      unknown
    >;
    const params = {
      order,
      signature,
      ownerSrcAddress: flow.baseWallet,
      traderDstAddress: flow.tonWallet,
      inputAsset: asset(quote.direction).input,
      outputAsset: asset(quote.direction).output,
    };
    const response = await this.rpcOnce(
      "stonfi.omni.v1beta8.OrderRpc.Register",
      params,
    );
    const result = response.result ?? response;
    const data = result as Record<string, unknown> | undefined;
    const tradeId =
      (typeof data?.tradeId === "string" ? data.tradeId : undefined) ??
      (typeof data?.trade_id === "string" ? data.trade_id : undefined) ??
      (typeof data?.id === "string" ? data.id : undefined) ??
      "";
    if (!tradeId) {
      throw new AppError(
        "UPSTREAM_FAILED",
        "Order registration returned no trade ID",
        502,
      );
    }
    return { tradeId, rfqId: quote.id };
  }

  async trackTrade(
    tradeId: string,
  ): Promise<{ status: string; receivedUnits: string | null }> {
    const response = await this.rpcOnce("stonfi.omni.v1beta8.TradeRpc.Status", {
      tradeId,
    });
    const result = response.result ?? response;
    if (!result || typeof result !== "object") {
      throw new AppError(
        "UPSTREAM_FAILED",
        "Trade status returned invalid data",
        502,
      );
    }
    const status =
      (result as Record<string, unknown>).status ??
      (result as Record<string, unknown>).trade_status ??
      "";
    const receivedUnits =
      (result as Record<string, unknown>).received_units ??
      (result as Record<string, unknown>).receivedUnits ??
      null;
    return {
      status: String(status),
      receivedUnits: typeof receivedUnits === "string" ? receivedUnits : null,
    };
  }

  private rpcOnce(method: string, params: unknown): Promise<RpcMessage> {
    const WebSocketClass = globalThis.WebSocket;
    if (!WebSocketClass)
      throw new AppError(
        "INTERNAL_ERROR",
        "WebSocket support is unavailable",
        500,
      );
    const url = new URL(this.config.OMNISTON_WS_URL);
    if (
      url.protocol !== "wss:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new AppError("BAD_REQUEST", "Omniston URL is unsafe");
    }
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const socket = new WebSocketClass(url);
      let complete = false;
      const finish = (error?: Error, result?: RpcMessage) => {
        if (complete) return;
        complete = true;
        clearTimeout(timer);
        socket.close();
        if (error) reject(error);
        else if (result) resolve(result);
      };
      const timer = setTimeout(
        () =>
          finish(
            new AppError(
              "UPSTREAM_FAILED",
              "Omniston RPC timed out",
              502,
              true,
            ),
          ),
        this.config.UPSTREAM_TIMEOUT_MS,
      );
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      });
      socket.addEventListener("message", (input) => {
        try {
          const message = JSON.parse(String(input.data)) as RpcMessage;
          if (!message || typeof message !== "object" || Array.isArray(message))
            return;
          if (message.id !== undefined && message.id !== id) return;
          if (message.error) {
            finish(
              new AppError(
                "UPSTREAM_FAILED",
                message.error.message ?? "Omniston rejected the request",
                502,
              ),
            );
            return;
          }
          if (message.id === id) finish(undefined, message);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.addEventListener("error", () => {
        finish(
          new AppError(
            "UPSTREAM_FAILED",
            "Could not connect to Omniston",
            502,
            true,
          ),
        );
      });
      socket.addEventListener("close", () => {
        finish(
          new AppError(
            "UPSTREAM_FAILED",
            "Omniston closed before responding",
            502,
            true,
          ),
        );
      });
    });
  }

  private quoteOnce(
    params: unknown,
  ): Promise<{ rfqId: string; quote: QuoteMessage }> {
    const WebSocketClass = globalThis.WebSocket;
    if (!WebSocketClass)
      throw new AppError(
        "INTERNAL_ERROR",
        "WebSocket support is unavailable",
        500,
      );
    const url = new URL(this.config.OMNISTON_WS_URL);
    if (
      url.protocol !== "wss:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new AppError("BAD_REQUEST", "Omniston URL is unsafe");
    }
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const socket = new WebSocketClass(url);
      let rfqId: string | undefined;
      let complete = false;
      const finish = (
        error?: Error,
        result?: { rfqId: string; quote: QuoteMessage },
      ) => {
        if (complete) return;
        complete = true;
        clearTimeout(timer);
        socket.close();
        if (error) reject(error);
        else if (result) resolve(result);
      };
      const timer = setTimeout(
        () =>
          finish(
            new AppError(
              "UPSTREAM_FAILED",
              "Omniston quote timed out",
              502,
              true,
            ),
          ),
        this.config.UPSTREAM_TIMEOUT_MS,
      );
      socket.addEventListener("open", () => {
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "stonfi.omni.v1beta8.QuoteRpc.Quote",
            params,
          }),
        );
      });
      socket.addEventListener("message", (input) => {
        try {
          const message = JSON.parse(String(input.data)) as RpcMessage;
          if (
            !message ||
            typeof message !== "object" ||
            Array.isArray(message)
          ) {
            throw new AppError(
              "QUOTE_INVALID",
              "Omniston returned an invalid message",
              502,
            );
          }
          if (message.id !== undefined && message.id !== id) return;
          if (message.error) {
            throw new AppError(
              "UPSTREAM_FAILED",
              message.error.message ?? "Omniston rejected the quote request",
              502,
            );
          }
          const event = eventFrom(message);
          if (!event || event.type === "keep") return;
          if (event.type === "ack") {
            if (rfqId && rfqId !== event.rfqId) {
              throw new AppError(
                "QUOTE_INVALID",
                "Omniston changed the RFQ ID",
                502,
              );
            }
            rfqId = event.rfqId;
            return;
          }
          if (!rfqId)
            throw new AppError(
              "QUOTE_INVALID",
              "Quote arrived before acknowledgment",
              502,
            );
          if (event.rfqId && event.rfqId !== rfqId) {
            throw new AppError(
              "QUOTE_INVALID",
              "Quote RFQ ID does not match",
              502,
            );
          }
          if (event.type === "none") {
            throw new AppError(
              "ROUTE_UNAVAILABLE",
              "No resolver returned a quote",
              409,
              true,
            );
          }
          finish(undefined, { rfqId, quote: event.quote });
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.addEventListener("error", () => {
        finish(
          new AppError(
            "UPSTREAM_FAILED",
            "Could not connect to Omniston",
            502,
            true,
          ),
        );
      });
      socket.addEventListener("close", () => {
        finish(
          new AppError(
            "UPSTREAM_FAILED",
            "Omniston closed before returning a quote",
            502,
            true,
          ),
        );
      });
    });
  }
}
