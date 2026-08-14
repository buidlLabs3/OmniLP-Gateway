const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TON_USDT = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";
const MAX_UNITS = 1_000_000_000n;
const PIPS = 1_000_000n;
const BASE_CHAIN_ID = 8453n;
const MAX_QUOTE_AGE_SECONDS = 120;
const CHAINS = [
  "arbitrum",
  "avalanche",
  "base",
  "bnb",
  "ethereum",
  "polygon",
  "robinhood",
  "ton",
  "tron",
];

const routes = {
  entry: {
    input: { base: { erc20: BASE_USDC } },
    output: { ton: { jetton: TON_USDT } },
  },
  exit: {
    input: { ton: { jetton: TON_USDT } },
    output: { base: { erc20: BASE_USDC } },
  },
};

function field(value, snake, camel) {
  return value?.[snake] ?? value?.[camel];
}

function units(value, decimals = 6) {
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new Error(`Invalid stablecoin amount: ${value}`);
  }

  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) {
    throw new Error(`Stablecoin amount has more than ${decimals} decimals`);
  }

  const result = `${whole}${fraction.padEnd(decimals, "0")}`.replace(
    /^0+(?=\d)/,
    "",
  );
  const amount = BigInt(result);
  if (amount === 0n)
    throw new Error("Stablecoin amount must be greater than zero");
  if (amount > MAX_UNITS) throw new Error("Atomic swap exceeds the $1,000 cap");
  return amount.toString();
}

function assetKey(asset) {
  const chain = chainOf(asset);
  if (
    chain === "base" &&
    asset.base &&
    typeof asset.base === "object" &&
    Object.keys(asset.base).length === 1 &&
    validBaseWallet(asset.base.erc20)
  ) {
    return `base:${asset.base.erc20.toLowerCase()}`;
  }
  if (
    chain === "ton" &&
    asset.ton &&
    typeof asset.ton === "object" &&
    Object.keys(asset.ton).length === 1 &&
    validTonWallet(asset.ton.jetton)
  ) {
    return `ton:${asset.ton.jetton}`;
  }
  throw new Error("Unsupported asset identifier");
}

function sameAsset(left, right) {
  return assetKey(left) === assetKey(right);
}

function makeQuoteRequest(direction, amount) {
  const route = routes[direction];
  if (!route) throw new Error(`Unsupported direction: ${direction}`);

  return {
    input_asset: structuredClone(route.input),
    output_asset: structuredClone(route.output),
    input_units: units(amount),
    settlement_params: [{ order: {} }],
  };
}

function readUnits(value, name, allowZero = false) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error(`${name} must be an integer string`);
  }
  const amount = BigInt(value);
  if (!allowZero && amount === 0n) throw new Error(`${name} must be positive`);
  return amount;
}

function validateQuoteRequest(request, direction) {
  const route = routes[direction];
  if (!route) throw new Error(`Unsupported direction: ${direction}`);
  if (!sameAsset(field(request, "input_asset", "inputAsset"), route.input)) {
    throw new Error("Quote input asset does not match the route");
  }
  if (!sameAsset(field(request, "output_asset", "outputAsset"), route.output)) {
    throw new Error("Quote output asset does not match the route");
  }

  const input = readUnits(
    field(request, "input_units", "inputUnits"),
    "input_units",
  );
  if (input > MAX_UNITS) throw new Error("Atomic swap exceeds the $1,000 cap");

  const params = field(request, "settlement_params", "settlementParams");
  const isOrderOnly =
    Array.isArray(params) &&
    params.length === 1 &&
    params[0]?.order &&
    typeof params[0].order === "object" &&
    !Array.isArray(params[0].order) &&
    Object.keys(params[0]).length === 1 &&
    Object.keys(params[0].order).length === 0;
  if (!isOrderOnly)
    throw new Error("Cross-chain quote must request only order settlement");
  return true;
}

function chainOf(address) {
  if (!address || typeof address !== "object" || Array.isArray(address))
    return null;
  const found = CHAINS.filter(
    (chain) => address[chain] !== undefined && address[chain] !== null,
  );
  if (
    found.length > 1 ||
    (found.length === 1 && Object.keys(address).length !== 1)
  ) {
    throw new Error("Chain value must contain exactly one known chain");
  }
  return found[0] ?? null;
}

function orderData(quote) {
  const settlement = field(quote, "settlement_data", "settlementData");
  if (
    settlement?.order &&
    typeof settlement.order === "object" &&
    Object.keys(settlement).length === 1
  ) {
    return settlement.order;
  }
  if (
    settlement?.$case === "order" &&
    settlement.value &&
    typeof settlement.value === "object" &&
    !Array.isArray(settlement.value) &&
    Object.keys(settlement).length === 2
  ) {
    return settlement.value;
  }
  throw new Error("Cross-chain quote must use order settlement");
}

function feePips(order, name) {
  const value = field(
    order,
    name,
    name.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()),
  );
  if (value === undefined) return 0n;
  if (
    !(
      (typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= 0) ||
      (typeof value === "string" && /^\d+$/.test(value))
    )
  ) {
    throw new Error(`${name} must be an unsigned integer`);
  }
  const fee = BigInt(value);
  if (fee < 0n || fee > PIPS)
    throw new Error(`${name} is outside the valid pips range`);
  return fee;
}

function validSecurityAsset(asset, chain) {
  if (chainOf(asset) !== chain) return false;
  const value = asset[chain];
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1) return false;
  if (keys[0] === "native") {
    return (
      value.native &&
      typeof value.native === "object" &&
      !Array.isArray(value.native) &&
      Object.keys(value.native).length === 0
    );
  }
  if (chain === "base" && keys[0] === "erc20")
    return validBaseWallet(value.erc20);
  if (chain === "ton" && keys[0] === "jetton")
    return validTonWallet(value.jetton);
  return false;
}

function securityDeposit(order, side, chain) {
  const assetName = `${side}_security_deposit_asset`;
  const unitsName = `${side}_security_deposit_units`;
  const asset = field(
    order,
    assetName,
    assetName.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()),
  );
  const amount = field(
    order,
    unitsName,
    unitsName.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()),
  );
  if (!asset || amount === undefined) {
    throw new Error(`${side} HTLC security deposit is missing`);
  }
  if (!validSecurityAsset(asset, chain)) {
    throw new Error(`${side} HTLC security deposit is on the wrong chain`);
  }
  readUnits(amount, `${side}_security_deposit_units`);
}

function validateQuote(
  quote,
  request,
  direction,
  now = Math.floor(Date.now() / 1000),
  maxAge = MAX_QUOTE_AGE_SECONDS,
) {
  validateQuoteRequest(request, direction);
  if (!quote || typeof quote !== "object" || Array.isArray(quote)) {
    throw new Error("Quote must be an object");
  }
  if (
    !Number.isSafeInteger(now) ||
    now <= 0 ||
    !Number.isSafeInteger(maxAge) ||
    maxAge < 0
  ) {
    throw new Error("Quote validation clock is invalid");
  }
  const route = routes[direction];
  const quoteId = field(quote, "quote_id", "quoteId");
  const rfqId = field(quote, "rfq_id", "rfqId");
  const resolverId = field(quote, "resolver_id", "resolverId");
  if (typeof quoteId !== "string" || quoteId.length === 0) {
    throw new Error("Quote ID is missing");
  }
  if (typeof resolverId !== "string" || resolverId.length === 0) {
    throw new Error("Resolver ID is missing");
  }
  if (typeof rfqId !== "string" || rfqId.length === 0) {
    throw new Error("RFQ ID is missing");
  }
  if (!sameAsset(field(quote, "input_asset", "inputAsset"), route.input)) {
    throw new Error("Quoted input asset does not match the route");
  }
  if (!sameAsset(field(quote, "output_asset", "outputAsset"), route.output)) {
    throw new Error("Quoted output asset does not match the route");
  }

  const quotedInput = readUnits(
    field(quote, "input_units", "inputUnits"),
    "quote input_units",
  );
  const requestedInput = BigInt(field(request, "input_units", "inputUnits"));
  if (quotedInput !== requestedInput)
    throw new Error("Quote amount does not match the request");
  const output = readUnits(
    field(quote, "output_units", "outputUnits"),
    "quote output_units",
  );
  const integratorFee = readUnits(
    field(quote, "integrator_fee_units", "integratorFeeUnits"),
    "integrator_fee_units",
    true,
  );
  const protocolFee = readUnits(
    field(quote, "protocol_fee_units", "protocolFeeUnits"),
    "protocol_fee_units",
    true,
  );

  const timestamp = Number(field(quote, "quote_timestamp", "quoteTimestamp"));
  if (
    !Number.isSafeInteger(timestamp) ||
    timestamp <= 0 ||
    timestamp > now + 60 ||
    timestamp < now - maxAge
  ) {
    throw new Error("Quote timestamp is invalid");
  }

  const order = orderData(quote);
  const source = field(
    order,
    "src_protocol_contract_address",
    "srcProtocolContractAddress",
  );
  const destination = field(
    order,
    "dst_protocol_contract_address",
    "dstProtocolContractAddress",
  );
  if (chainOf(source) !== chainOf(route.input)) {
    throw new Error("Order source protocol is on the wrong chain");
  }
  if (chainOf(destination) !== chainOf(route.output)) {
    throw new Error("Order destination protocol is on the wrong chain");
  }
  const sourceAddress = source?.[chainOf(source)];
  const destinationAddress = destination?.[chainOf(destination)];
  if (
    (chainOf(source) === "base" && !validBaseWallet(sourceAddress)) ||
    (chainOf(source) === "ton" && !validTonWallet(sourceAddress))
  ) {
    throw new Error("Order source protocol address is invalid");
  }
  if (
    (chainOf(destination) === "base" && !validBaseWallet(destinationAddress)) ||
    (chainOf(destination) === "ton" && !validTonWallet(destinationAddress))
  ) {
    throw new Error("Order destination protocol address is invalid");
  }
  securityDeposit(order, "src_htlc", chainOf(route.input));
  securityDeposit(order, "dst", chainOf(route.output));

  const sent = readUnits(
    field(order, "resolver_sends_units", "resolverSendsUnits"),
    "resolver_sends_units",
  );
  if (sent !== output + integratorFee + protocolFee) {
    throw new Error("Resolver send amount does not reconcile with output fees");
  }

  const deadline = Number(
    field(order, "trade_start_deadline", "tradeStartDeadline"),
  );
  if (
    !Number.isSafeInteger(deadline) ||
    deadline <= now ||
    deadline <= timestamp
  ) {
    throw new Error("Trade-start deadline has expired or is invalid");
  }
  const timeout = Number(
    field(order, "exclusivity_timeout", "exclusivityTimeout"),
  );
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new Error("Order exclusivity timeout is invalid");
  }
  const hash = field(order, "htlc_hashing_function", "htlcHashingFunction");
  if (
    ![
      0,
      1,
      "0",
      "1",
      "HASHING_FUNCTION_KECCAK256",
      "HASHING_FUNCTION_SHA256",
    ].includes(hash)
  ) {
    throw new Error("Order HTLC hashing function is invalid");
  }

  const integratorPips = feePips(order, "integrator_fee_pips");
  const protocolPips = feePips(order, "protocol_fee_pips");
  if (integratorPips === 0n && integratorFee !== 0n) {
    throw new Error(
      "Integrator fee units exist without an integrator fee rate",
    );
  }
  if (protocolPips === 0n && protocolFee !== 0n) {
    throw new Error("Protocol fee units exist without a protocol fee rate");
  }

  return {
    quoteId,
    resolverId,
    inputUnits: quotedInput.toString(),
    outputUnits: output.toString(),
    deadline,
    sourceChain: chainOf(source),
    destinationChain: chainOf(destination),
  };
}

function validBaseWallet(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function validTonWallet(value) {
  if (typeof value !== "string") return false;
  if (/^(?:-1|0):[0-9a-fA-F]{64}$/.test(value)) return true;
  if (!/^[A-Za-z0-9_-]{48}$/.test(value)) return false;

  let decoded;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    return false;
  }
  if (decoded.length !== 36 || ![0x11, 0x51].includes(decoded[0])) return false;
  if (![0x00, 0xff].includes(decoded[1])) return false;

  let crc = 0;
  for (const byte of decoded.subarray(0, 34)) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return decoded.readUInt16BE(34) === crc;
}

function makeEvmOrderRequest(quoteId, baseWallet, tonWallet) {
  if (
    typeof quoteId !== "string" ||
    quoteId.length === 0 ||
    quoteId.length > 256 ||
    quoteId.trim() !== quoteId
  ) {
    throw new Error("Quote ID is required");
  }
  if (!validBaseWallet(baseWallet))
    throw new Error("Invalid Base owner address");
  if (!validTonWallet(tonWallet))
    throw new Error("Invalid TON recipient address");

  return {
    quote_id: quoteId,
    owner_src_address: { base: baseWallet },
    trader_dst_address: { ton: tonWallet },
  };
}

function validateEvmOrderRequest(request, baseWallet, tonWallet) {
  if (!validBaseWallet(baseWallet))
    throw new Error("Invalid connected Base wallet");
  if (!validTonWallet(tonWallet))
    throw new Error("Invalid connected TON wallet");
  const quoteId = field(request, "quote_id", "quoteId");
  if (
    typeof quoteId !== "string" ||
    quoteId.length === 0 ||
    quoteId.length > 256 ||
    quoteId.trim() !== quoteId
  ) {
    throw new Error("EVM order request has no quote ID");
  }
  const owner = field(request, "owner_src_address", "ownerSrcAddress")?.base;
  const recipient = field(
    request,
    "trader_dst_address",
    "traderDstAddress",
  )?.ton;
  if (
    chainOf(field(request, "owner_src_address", "ownerSrcAddress")) !== "base"
  ) {
    throw new Error("EVM order owner must contain only Base");
  }
  if (
    chainOf(field(request, "trader_dst_address", "traderDstAddress")) !== "ton"
  ) {
    throw new Error("Order recipient must contain only TON");
  }
  if (owner?.toLowerCase() !== baseWallet.toLowerCase()) {
    throw new Error("EVM order owner does not match the connected Base wallet");
  }
  if (recipient !== tonWallet) {
    throw new Error("Order recipient does not match the connected TON wallet");
  }
  const permit = field(request, "encoded_permit_data", "encodedPermitData");
  const signature = field(request, "permit_signature", "permitSignature");
  if ((permit === undefined) !== (signature === undefined)) {
    throw new Error(
      "Permit data and permit signature must be provided together",
    );
  }
  if (permit !== undefined) {
    base64(permit, "Permit data");
    base64(signature, "Permit signature");
  }
  const usePermit2 = field(request, "use_permit2", "usePermit2");
  if (usePermit2 !== undefined && typeof usePermit2 !== "boolean") {
    throw new Error("use_permit2 must be boolean");
  }
  return true;
}

function base64(value, name) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1_000_000 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new Error(`${name} is not valid base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== value) {
    throw new Error(`${name} is not valid base64`);
  }
}

function validateEvmOrderPayload(payload, expectedContract) {
  const raw = field(payload, "typed_data", "typedData");
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 1_000_000) {
    throw new Error("EIP-712 typed data is missing");
  }

  let typed;
  try {
    typed = JSON.parse(raw);
  } catch {
    throw new Error("EIP-712 typed data is not valid JSON");
  }
  if (!typed || typeof typed !== "object" || Array.isArray(typed)) {
    throw new Error("EIP-712 typed data must be an object");
  }
  if (
    !typed.domain ||
    typeof typed.domain !== "object" ||
    Array.isArray(typed.domain)
  ) {
    throw new Error("EIP-712 domain is missing");
  }
  if (
    !typed.message ||
    typeof typed.message !== "object" ||
    Array.isArray(typed.message)
  ) {
    throw new Error("EIP-712 message is missing");
  }
  if (
    typeof typed.primaryType !== "string" ||
    !Array.isArray(typed.types?.[typed.primaryType]) ||
    typed.types[typed.primaryType].length === 0
  ) {
    throw new Error("EIP-712 primary type is missing from types");
  }
  const fields = typed.types[typed.primaryType];
  if (
    fields.some(
      (item) =>
        !item ||
        typeof item !== "object" ||
        typeof item.name !== "string" ||
        item.name.length === 0 ||
        typeof item.type !== "string" ||
        item.type.length === 0,
    ) ||
    new Set(fields.map((item) => item.name)).size !== fields.length
  ) {
    throw new Error("EIP-712 primary type fields are invalid");
  }
  if (fields.some((item) => !(item.name in typed.message))) {
    throw new Error("EIP-712 message is missing a primary type field");
  }
  let chainId;
  try {
    chainId = BigInt(typed.domain.chainId);
  } catch {
    throw new Error("EIP-712 domain chain ID is invalid");
  }
  if (chainId !== BASE_CHAIN_ID) {
    throw new Error("EIP-712 domain is not bound to Base");
  }
  if (!validBaseWallet(typed.domain.verifyingContract)) {
    throw new Error("EIP-712 verifying contract is invalid");
  }
  if (!validBaseWallet(expectedContract)) {
    throw new Error("Expected Base protocol contract is invalid");
  }
  if (
    typed.domain.verifyingContract.toLowerCase() !==
    expectedContract.toLowerCase()
  ) {
    throw new Error(
      "EIP-712 verifying contract does not match the accepted quote",
    );
  }

  const extension = field(payload, "order_extension", "orderExtension");
  const details = field(
    payload,
    "serialized_order_details",
    "serializedOrderDetails",
  );
  base64(extension, "Order extension");
  base64(details, "Serialized HTLC order details");
  return typed;
}

function orderState(status, hasDestinationReceipt = false) {
  const value = typeof status === "string" ? status.toUpperCase() : status;
  const states = new Map([
    [0, { state: "trade_pending", isFinal: false, canDeposit: false }],
    [2, { state: "trade_partial", isFinal: true, canDeposit: false }],
    [3, { state: "cancelled", isFinal: true, canDeposit: false }],
    [4, { state: "trade_failed", isFinal: true, canDeposit: false }],
    [
      "IN_PROGRESS",
      { state: "trade_pending", isFinal: false, canDeposit: false },
    ],
    [
      "TRADE_STATUS_IN_PROGRESS",
      { state: "trade_pending", isFinal: false, canDeposit: false },
    ],
    [
      "PARTIALLY_FILLED",
      { state: "trade_partial", isFinal: true, canDeposit: false },
    ],
    [
      "TRADE_STATUS_PARTIALLY_FILLED",
      { state: "trade_partial", isFinal: true, canDeposit: false },
    ],
    ["CANCELLED", { state: "cancelled", isFinal: true, canDeposit: false }],
    [
      "TRADE_STATUS_CANCELLED",
      { state: "cancelled", isFinal: true, canDeposit: false },
    ],
    ["FAILED", { state: "trade_failed", isFinal: true, canDeposit: false }],
    [
      "TRADE_STATUS_FAILED",
      { state: "trade_failed", isFinal: true, canDeposit: false },
    ],
  ]);
  const isFilled =
    value === 1 ||
    value === "FULLY_FILLED" ||
    value === "TRADE_STATUS_FULLY_FILLED";
  if (isFilled) {
    return hasDestinationReceipt
      ? { state: "funds_received", isFinal: true, canDeposit: true }
      : { state: "trade_filled", isFinal: false, canDeposit: false };
  }
  return (
    states.get(value) ?? {
      state: "trade_unknown",
      isFinal: false,
      canDeposit: false,
    }
  );
}

export {
  BASE_USDC,
  MAX_QUOTE_AGE_SECONDS,
  MAX_UNITS,
  TON_USDT,
  assetKey,
  makeEvmOrderRequest,
  makeQuoteRequest,
  orderState,
  units,
  validTonWallet,
  validateEvmOrderRequest,
  validateEvmOrderPayload,
  validateQuote,
  validateQuoteRequest,
};
