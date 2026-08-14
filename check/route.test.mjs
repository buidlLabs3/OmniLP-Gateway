import assert from "node:assert/strict";
import test from "node:test";

import {
  BASE_USDC,
  TON_USDT,
  makeEvmOrderRequest,
  makeQuoteRequest,
  orderState,
  units,
  validateEvmOrderRequest,
  validateEvmOrderPayload,
  validateQuote,
  validateQuoteRequest,
  validTonWallet,
} from "./route.mjs";

const now = 1_800_000_000;

function quoteFor(request, direction = "entry") {
  const entry = direction === "entry";
  return {
    rfq_id: "rfq-1",
    quote_id: "quote-1",
    resolver_id: "resolver-1",
    input_asset: request.input_asset,
    output_asset: request.output_asset,
    input_units: request.input_units,
    output_units: "9950000",
    integrator_fee_units: "0",
    protocol_fee_units: "10000",
    quote_timestamp: now,
    settlement_data: {
      order: {
        src_protocol_contract_address: entry
          ? { base: "0x1111111111111111111111111111111111111111" }
          : { ton: "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c" },
        dst_protocol_contract_address: entry
          ? { ton: "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c" }
          : { base: "0x1111111111111111111111111111111111111111" },
        src_htlc_security_deposit_asset: entry
          ? { base: { erc20: BASE_USDC } }
          : { ton: { jetton: TON_USDT } },
        src_htlc_security_deposit_units: "1",
        dst_security_deposit_asset: entry
          ? { ton: { jetton: TON_USDT } }
          : { base: { erc20: BASE_USDC } },
        dst_security_deposit_units: "1",
        resolver_sends_units: "9960000",
        trade_start_deadline: now + 60,
        exclusivity_timeout: 30,
        htlc_hashing_function: "HASHING_FUNCTION_SHA256",
        integrator_fee_pips: 0,
        protocol_fee_pips: 1000,
      },
    },
  };
}

test("converts stablecoin amounts and enforces the current cap", () => {
  assert.equal(units("10"), "10000000");
  assert.equal(units("1000"), "1000000000");
  assert.throws(() => units("1000.000001"), /\$1,000 cap/);
  assert.throws(() => units("1.0000001"), /more than 6 decimals/);
});

test("validates TON friendly checksums and raw address shape", () => {
  assert.equal(validTonWallet(TON_USDT), true);
  assert.equal(validTonWallet("0:".padEnd(66, "0")), true);
  assert.equal(validTonWallet(TON_USDT.slice(0, -1) + "A"), false);
  assert.equal(validTonWallet("1:".padEnd(66, "0")), false);
});

test("builds order-only entry and reverse quote requests", () => {
  const entry = makeQuoteRequest("entry", "250");
  assert.equal(entry.input_asset.base.erc20, BASE_USDC);
  assert.equal(entry.output_asset.ton.jetton, TON_USDT);
  assert.deepEqual(entry.settlement_params, [{ order: {} }]);
  assert.equal(validateQuoteRequest(entry, "entry"), true);

  const exit = makeQuoteRequest("exit", "10");
  assert.equal(exit.input_asset.ton.jetton, TON_USDT);
  assert.equal(exit.output_asset.base.erc20, BASE_USDC);
  assert.equal(validateQuoteRequest(exit, "exit"), true);
});

test("validates a live-shape v1beta8 order quote", () => {
  const request = makeQuoteRequest("entry", "10");
  assert.deepEqual(validateQuote(quoteFor(request), request, "entry", now), {
    quoteId: "quote-1",
    resolverId: "resolver-1",
    inputUnits: "10000000",
    outputUnits: "9950000",
    deadline: now + 60,
    sourceChain: "base",
    destinationChain: "ton",
  });
});

test("rejects wrong settlement, recipient chain, amount, and expiry", () => {
  const request = makeQuoteRequest("entry", "10");

  const swap = quoteFor(request);
  swap.settlement_data = { swap: {} };
  assert.throws(
    () => validateQuote(swap, request, "entry", now),
    /order settlement/,
  );

  const wrongChain = quoteFor(request);
  wrongChain.settlement_data.order.dst_protocol_contract_address = {
    base: "0x1111111111111111111111111111111111111111",
  };
  assert.throws(
    () => validateQuote(wrongChain, request, "entry", now),
    /destination protocol/,
  );

  const wrongAmount = quoteFor(request);
  wrongAmount.input_units = "9999999";
  assert.throws(
    () => validateQuote(wrongAmount, request, "entry", now),
    /amount does not match/,
  );

  const expired = quoteFor(request);
  expired.settlement_data.order.trade_start_deadline = now;
  assert.throws(
    () => validateQuote(expired, request, "entry", now),
    /deadline/,
  );

  const badFees = quoteFor(request);
  badFees.protocol_fee_units = "9999";
  assert.throws(
    () => validateQuote(badFees, request, "entry", now),
    /reconcile/,
  );

  const missingDeposit = quoteFor(request);
  delete missingDeposit.settlement_data.order.dst_security_deposit_asset;
  assert.throws(
    () => validateQuote(missingDeposit, request, "entry", now),
    /security deposit/,
  );

  const stale = quoteFor(request);
  stale.quote_timestamp = now - 121;
  assert.throws(() => validateQuote(stale, request, "entry", now), /timestamp/);

  const mixedChain = quoteFor(request);
  mixedChain.settlement_data.order.dst_protocol_contract_address.base =
    "0x1111111111111111111111111111111111111111";
  assert.throws(
    () => validateQuote(mixedChain, request, "entry", now),
    /exactly one known chain/,
  );

  const unknownHash = quoteFor(request);
  unknownHash.settlement_data.order.htlc_hashing_function =
    "HASHING_FUNCTION_UNKNOWN";
  assert.throws(
    () => validateQuote(unknownHash, request, "entry", now),
    /hashing function/,
  );

  const missingFeeRate = quoteFor(request);
  delete missingFeeRate.settlement_data.order.protocol_fee_pips;
  assert.throws(
    () => validateQuote(missingFeeRate, request, "entry", now),
    /fee units exist without a protocol fee rate/,
  );
});

test("rejects mixed settlement requests and responses", () => {
  const request = makeQuoteRequest("entry", "10");
  request.settlement_params.push({ swap: {} });
  assert.throws(
    () => validateQuoteRequest(request, "entry"),
    /only order settlement/,
  );

  const cleanRequest = makeQuoteRequest("entry", "10");
  const quote = quoteFor(cleanRequest);
  quote.settlement_data.swap = {};
  assert.throws(
    () => validateQuote(quote, cleanRequest, "entry", now),
    /order settlement/,
  );
});

test("binds source ownership and destination receipt to user wallets", () => {
  const baseWallet = "0x2222222222222222222222222222222222222222";
  const tonWallet = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";
  const request = makeEvmOrderRequest("quote-1", baseWallet, tonWallet);
  assert.equal(validateEvmOrderRequest(request, baseWallet, tonWallet), true);

  const changed = structuredClone(request);
  changed.trader_dst_address.ton =
    "UQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJKZ";
  assert.throws(
    () => validateEvmOrderRequest(changed, baseWallet, tonWallet),
    /recipient does not match/,
  );

  const incompletePermit = structuredClone(request);
  incompletePermit.encoded_permit_data = "AQ==";
  assert.throws(
    () => validateEvmOrderRequest(incompletePermit, baseWallet, tonWallet),
    /provided together/,
  );
});

test("validates the unsigned EIP-712 order response before wallet display", () => {
  const typed = {
    types: { Order: [{ name: "salt", type: "uint256" }] },
    primaryType: "Order",
    domain: {
      name: "Omniston",
      chainId: 8453,
      verifyingContract: "0x1111111111111111111111111111111111111111",
    },
    message: { salt: "1" },
  };
  assert.deepEqual(
    validateEvmOrderPayload(
      {
        typed_data: JSON.stringify(typed),
        order_extension: "AQ==",
        serialized_order_details: "Ag==",
      },
      "0x1111111111111111111111111111111111111111",
    ),
    typed,
  );
  assert.throws(
    () =>
      validateEvmOrderPayload(
        { typed_data: "{}" },
        "0x1111111111111111111111111111111111111111",
      ),
    /domain is missing/,
  );

  const wrongChain = structuredClone(typed);
  wrongChain.domain.chainId = 1;
  assert.throws(
    () =>
      validateEvmOrderPayload(
        {
          typed_data: JSON.stringify(wrongChain),
          order_extension: "AQ==",
          serialized_order_details: "Ag==",
        },
        "0x1111111111111111111111111111111111111111",
      ),
    /not bound to Base/,
  );

  assert.throws(
    () =>
      validateEvmOrderPayload(
        {
          typed_data: JSON.stringify(typed),
          order_extension: "not-base64",
          serialized_order_details: "Ag==",
        },
        "0x1111111111111111111111111111111111111111",
      ),
    /valid base64/,
  );

  assert.throws(
    () =>
      validateEvmOrderPayload(
        {
          typed_data: JSON.stringify(typed),
          order_extension: "AQ==",
          serialized_order_details: "Ag==",
        },
        "0x2222222222222222222222222222222222222222",
      ),
    /does not match the accepted quote/,
  );
});

test("a fully filled order still needs independent TON receipt", () => {
  assert.equal(orderState("FULLY_FILLED").state, "trade_filled");
  assert.equal(orderState("FULLY_FILLED").canDeposit, false);
  assert.equal(orderState("TRADE_STATUS_FULLY_FILLED", true).canDeposit, true);
  assert.equal(orderState("PARTIALLY_FILLED").canDeposit, false);
  assert.equal(orderState("CANCELLED").canDeposit, false);
  assert.equal(orderState("FAILED").canDeposit, false);
  assert.equal(orderState("unexpected").state, "trade_unknown");
});
