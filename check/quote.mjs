import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { makeQuoteRequest, validateQuote } from "./route.mjs";

const apiUrl = process.env.OMNISTON_WS_URL ?? "wss://omni-ws-sandbox.ston.fi";
const method = process.env.OMNISTON_QUOTE_METHOD ?? "v1beta8.quote";
const timeoutMs = Number(process.env.OMNISTON_TIMEOUT_MS ?? "20000");
const amountList = process.env.USDC_AMOUNTS ?? "10,250,1000";

function wireRequest(request) {
  return {
    inputAsset: request.input_asset,
    outputAsset: request.output_asset,
    inputUnits: request.input_units,
    settlementParams: request.settlement_params,
  };
}

function eventFrom(message) {
  const values = [
    message?.result,
    message?.params?.result,
    message?.params,
    message,
  ];
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const eventCount = [
      value.ack,
      value.quoteUpdated ?? value.quote_updated,
      value.noQuote ?? value.no_quote,
      value.unsubscribed,
      value.keepAlive ?? value.keep_alive,
    ].filter((item) => item !== undefined).length;
    if (eventCount > 1) return { type: "invalid" };
    if (value.ack !== undefined) return { type: "ack", value: value.ack };
    if (value.quoteUpdated) {
      return {
        type: "quote",
        value: value.quoteUpdated.quote ?? value.quoteUpdated,
        rfqId: value.quoteUpdated.rfqId ?? value.quoteUpdated.rfq_id,
      };
    }
    if (value.quote_updated) {
      return {
        type: "quote",
        value: value.quote_updated.quote ?? value.quote_updated,
        rfqId: value.quote_updated.rfqId ?? value.quote_updated.rfq_id,
      };
    }
    if (value.noQuote !== undefined || value.no_quote !== undefined) {
      const noQuote = value.noQuote ?? value.no_quote;
      return {
        type: "no_quote",
        rfqId: noQuote?.rfqId ?? noQuote?.rfq_id ?? value.rfqId ?? value.rfq_id,
      };
    }
    if (value.unsubscribed !== undefined) {
      return {
        type: "unsubscribed",
        rfqId: value.unsubscribed.rfqId ?? value.unsubscribed.rfq_id,
      };
    }
    if (value.keepAlive !== undefined || value.keep_alive !== undefined) {
      return { type: "keep_alive" };
    }
  }
  return null;
}

function positiveTimeout(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 120_000) {
    throw new Error("Quote timeout must be an integer from 1 to 120000ms");
  }
  return value;
}

function requestUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("OMNISTON_WS_URL is invalid");
  }
  if (parsed.protocol !== "wss:") {
    throw new Error("OMNISTON_WS_URL must use secure WebSocket");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      "OMNISTON_WS_URL must not contain credentials, query, or fragment",
    );
  }
  return parsed.toString();
}

function quoteOnce(request, options = {}) {
  const WebSocketClass = options.WebSocketClass ?? globalThis.WebSocket;
  const url = requestUrl(options.apiUrl ?? apiUrl);
  const quoteMethod = options.method ?? method;
  const wait = positiveTimeout(options.timeoutMs ?? timeoutMs);

  if (!WebSocketClass)
    throw new Error("This Node runtime has no WebSocket support");
  if (quoteMethod !== "v1beta8.quote") {
    throw new Error("Omniston quote method must be v1beta8.quote");
  }

  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const socket = new WebSocketClass(url);
    let rfqId;
    let done = false;

    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {}
      if (error) reject(error);
      else resolve(value);
    };

    const timer = setTimeout(
      () => finish(new Error(`Quote timed out after ${wait}ms`)),
      wait,
    );

    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: quoteMethod,
          params: wireRequest(request),
        }),
      );
    });

    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        finish(new Error("Omniston returned invalid JSON"));
        return;
      }

      if (!message || typeof message !== "object" || Array.isArray(message)) {
        finish(new Error("Omniston returned an invalid message"));
        return;
      }
      if (message.id !== undefined && message.id !== id) return;

      if (message.error) {
        const detail = message.error.message ?? JSON.stringify(message.error);
        finish(new Error(`Omniston error: ${detail}`));
        return;
      }

      const quoteEvent = eventFrom(message);
      if (!quoteEvent || quoteEvent.type === "keep_alive") return;
      if (quoteEvent.type === "invalid") {
        finish(new Error("Omniston returned an ambiguous quote event"));
        return;
      }
      if (quoteEvent.type === "ack") {
        const nextRfqId = quoteEvent.value.rfqId ?? quoteEvent.value.rfq_id;
        if (typeof nextRfqId !== "string" || nextRfqId.length === 0) {
          finish(new Error("Quote acknowledgment has no RFQ ID"));
          return;
        }
        if (rfqId && rfqId !== nextRfqId) {
          finish(new Error("Quote stream returned conflicting RFQ IDs"));
          return;
        }
        rfqId = nextRfqId;
        return;
      }
      if (!rfqId) {
        finish(
          new Error(`Received ${quoteEvent.type} before quote acknowledgment`),
        );
        return;
      }
      if (quoteEvent.type === "no_quote") {
        if (quoteEvent.rfqId && quoteEvent.rfqId !== rfqId) {
          finish(
            new Error("No-quote RFQ ID does not match its acknowledgment"),
          );
          return;
        }
        finish(null, { rfqId, quote: null });
        return;
      }
      if (quoteEvent.type === "unsubscribed") {
        finish(new Error("Omniston unsubscribed before returning a result"));
        return;
      }

      const quote = quoteEvent.value;
      if (!quote || typeof quote !== "object" || Array.isArray(quote)) {
        finish(new Error("Omniston quote event has no quote"));
        return;
      }
      const quoteRfqId = quoteEvent.rfqId ?? quote.rfqId ?? quote.rfq_id;
      if (quoteRfqId !== rfqId) {
        finish(new Error("Quote RFQ ID does not match its acknowledgment"));
        return;
      }
      finish(null, { rfqId, quote });
    });

    socket.addEventListener("error", (event) => {
      const detail = event?.error?.message ?? event?.message;
      finish(
        new Error(`Could not connect to ${url}${detail ? `: ${detail}` : ""}`),
      );
    });
    socket.addEventListener("close", () => {
      finish(new Error("Omniston closed the quote stream before a result"));
    });
  });
}

function amounts() {
  const values = amountList
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0 || values.length > 20) {
    throw new Error("USDC_AMOUNTS must contain 1 to 20 amounts");
  }
  return [...new Set(values)];
}

async function mapLimit(values, limit, run) {
  const results = new Array(values.length);
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await run(values[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, () => worker()),
  );
  return results;
}

async function main() {
  const requests = ["entry", "exit"].flatMap((direction) =>
    amounts().map((amount) => ({ direction, amount })),
  );
  const results = await mapLimit(requests, 3, async ({ direction, amount }) => {
    try {
      const request = makeQuoteRequest(direction, amount);
      const response = await quoteOnce(request);
      if (!response.quote) {
        return {
          direction,
          amount,
          status: "no_quote",
          rfqId: response.rfqId,
        };
      }
      return {
        direction,
        amount,
        status: "valid_quote",
        ...validateQuote(response.quote, request, direction),
      };
    } catch (error) {
      return {
        direction,
        amount,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  const output = {
    checkedAt: new Date().toISOString(),
    apiUrl,
    method,
    results,
    passed: results.every((result) => result.status === "valid_quote"),
  };
  console.log(JSON.stringify(output, null, 2));
  if (!output.passed) process.exitCode = 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(
      JSON.stringify(
        {
          checkedAt: new Date().toISOString(),
          apiUrl,
          method,
          error: error instanceof Error ? error.message : String(error),
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  });
}

export { eventFrom, quoteOnce, wireRequest };
