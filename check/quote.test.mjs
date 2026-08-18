import assert from "node:assert/strict";
import test from "node:test";

import { eventFrom, quoteOnce, wireRequest } from "./quote.mjs";
import { makeQuoteRequest } from "./route.mjs";

class FakeSocket extends EventTarget {
  constructor() {
    super();
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }

  send(raw) {
    const request = JSON.parse(raw);
    const ack = new MessageEvent("message", {
      data: JSON.stringify({ result: { ack: { rfqId: "rfq-1" } } }),
    });
    const noQuote = new MessageEvent("message", {
      data: JSON.stringify({ params: { result: { noQuote: {} } } }),
    });
    assert.equal(request.method, "stonfi.omni.v1beta8.QuoteRpc.Quote");
    assert.equal(request.params.inputUnits, "10000000");
    queueMicrotask(() => {
      this.dispatchEvent(ack);
      this.dispatchEvent(noQuote);
    });
  }

  close() {}
}

function socketFor(messages) {
  return class extends EventTarget {
    constructor() {
      super();
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }

    send(raw) {
      const request = JSON.parse(raw);
      queueMicrotask(() => {
        for (const message of messages(request)) {
          this.dispatchEvent(
            new MessageEvent("message", { data: JSON.stringify(message) }),
          );
        }
      });
    }

    close() {}
  };
}

test("serializes the v1beta8 quote request with protobuf JSON names", () => {
  const request = wireRequest(makeQuoteRequest("entry", "10"));
  assert.equal(request.inputAsset.base.erc20.startsWith("0x"), true);
  assert.equal(request.outputAsset.ton.jetton.startsWith("EQ"), true);
  assert.deepEqual(request.settlementParams, [{ order: {} }]);
  assert.equal("input_asset" in request, false);
});

test("recognizes quote stream event envelopes", () => {
  assert.equal(eventFrom({ result: { ack: {} } }).type, "ack");
  assert.deepEqual(
    eventFrom({
      params: {
        result: {
          quote_updated: { rfq_id: "rfq-1", quote: { quote_id: "q" } },
        },
      },
    }),
    { type: "quote", rfqId: "rfq-1", value: { quote_id: "q" } },
  );
  assert.equal(eventFrom({ params: { noQuote: {} } }).type, "no_quote");
});

test("stops cleanly when an acknowledged request has no quote", async () => {
  const result = await quoteOnce(makeQuoteRequest("entry", "10"), {
    WebSocketClass: FakeSocket,
    apiUrl: "wss://example.test",
    method: "stonfi.omni.v1beta8.QuoteRpc.Quote",
    timeoutMs: 100,
  });
  assert.deepEqual(result, { rfqId: "rfq-1", quote: null });
});

test("ignores messages for another JSON-RPC request", async () => {
  const Socket = socketFor((request) => [
    { id: "different", error: { message: "not this request" } },
    { id: "different", result: { noQuote: {} } },
    { id: request.id, result: { ack: { rfqId: "rfq-1" } } },
    { id: request.id, result: { noQuote: { rfqId: "rfq-1" } } },
  ]);
  const result = await quoteOnce(makeQuoteRequest("entry", "10"), {
    WebSocketClass: Socket,
    apiUrl: "wss://example.test",
    timeoutMs: 100,
  });
  assert.deepEqual(result, { rfqId: "rfq-1", quote: null });
});

test("rejects a quote before acknowledgment and conflicting RFQ IDs", async () => {
  const earlyQuote = socketFor(() => [
    { result: { quoteUpdated: { rfqId: "rfq-1", quote: { rfqId: "rfq-1" } } } },
  ]);
  await assert.rejects(
    quoteOnce(makeQuoteRequest("entry", "10"), {
      WebSocketClass: earlyQuote,
      apiUrl: "wss://example.test",
      timeoutMs: 100,
    }),
    /before quote acknowledgment/,
  );

  const conflict = socketFor(() => [
    { result: { ack: { rfqId: "rfq-1" } } },
    { result: { ack: { rfqId: "rfq-2" } } },
  ]);
  await assert.rejects(
    quoteOnce(makeQuoteRequest("entry", "10"), {
      WebSocketClass: conflict,
      apiUrl: "wss://example.test",
      timeoutMs: 100,
    }),
    /conflicting RFQ IDs/,
  );
});

test("rejects ambiguous event envelopes", async () => {
  const Socket = socketFor(() => [
    { result: { ack: { rfqId: "rfq-1" }, noQuote: {} } },
  ]);
  await assert.rejects(
    quoteOnce(makeQuoteRequest("entry", "10"), {
      WebSocketClass: Socket,
      apiUrl: "wss://example.test",
      timeoutMs: 100,
    }),
    /ambiguous quote event/,
  );
});

test("rejects invalid stream configuration", () => {
  assert.throws(
    () =>
      quoteOnce(makeQuoteRequest("entry", "10"), {
        WebSocketClass: FakeSocket,
        apiUrl: "https://example.test",
      }),
    /must use secure WebSocket/,
  );
  assert.throws(
    () =>
      quoteOnce(makeQuoteRequest("entry", "10"), {
        WebSocketClass: FakeSocket,
        apiUrl: "wss://example.test",
        timeoutMs: 0,
      }),
    /timeout/,
  );
});
