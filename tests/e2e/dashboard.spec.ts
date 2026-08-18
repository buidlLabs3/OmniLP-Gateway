import { expect, test } from "@playwright/test";

const now = new Date().toISOString();
const rawTon = (id: number) => `0:${id.toString(16).padStart(64, "0")}`;
const flowId = "10000000-0000-4000-8000-000000000001";

test.beforeEach(async ({ page }) => {
  await page.route(
    "https://telegram.org/js/telegram-web-app.js?63",
    async (route) => {
      await route.fulfill({
        contentType: "application/javascript",
        body: `(() => {
          let mainClick = () => {};
          let backClick = () => {};
          const MainButton = {
            setText() {}, show() {}, hide() {}, enable() {}, disable() {},
            showProgress() {}, hideProgress() {},
            onClick(callback) { mainClick = callback; },
            offClick(callback) { if (mainClick === callback) mainClick = () => {}; }
          };
          const BackButton = {
            show() {}, hide() {},
            onClick(callback) { backClick = callback; },
            offClick(callback) { if (backClick === callback) backClick = () => {}; }
          };
          window.__telegramTest = { main: () => mainClick(), back: () => backClick() };
          window.ethereum = { request: async ({ method }) =>
            method === 'eth_requestAccounts'
              ? ['0x2222222222222222222222222222222222222222']
              : null
          };
          window.Telegram = { WebApp: {
            initData: 'signed-test-launch', colorScheme: 'light',
            ready() {}, expand() {}, disableVerticalSwipes() {}, MainButton, BackButton
          }};
        })();`,
      });
    },
  );
  await page.route("http://127.0.0.1:3001/v1/pools", async (route) => {
    await route.fulfill({
      json: {
        pools: [
          {
            id: "usdt-ston",
            address: rawTon(1),
            routerAddress: rawTon(2),
            token0: {
              address: rawTon(3),
              symbol: "USDT",
              name: "Tether USD",
              decimals: 6,
            },
            token1: {
              address: rawTon(4),
              symbol: "STON",
              name: "STON",
              decimals: 9,
            },
            entryMode: "single",
            enabled: true,
            disabledReason: null,
            tvlUsdUnits: "1842050000000",
            volume24hUsdUnits: "82630000000",
            feePips: 3000,
            aprPips: 128400,
            checkedAt: now,
          },
        ],
      },
    });
  });
  await page.route("http://127.0.0.1:3001/v1/metrics", async (route) => {
    await route.fulfill({
      json: {
        impact: {
          checkedAt: now,
          routedUsdcUnits: "42250000000",
          depositedUsdUnits: "38100000000",
          retained7dUsdUnits: "31000000000",
          retained30dUsdUnits: "19000000000",
          completedEntries: 84,
          completedExits: 12,
          sourceWithdrawals: 2,
          completionPips: 810000,
          medianEntryUnits: "250000000",
          pools: [
            {
              poolId: "usdt-ston",
              depositUsdUnits: "38100000000",
              positions: 84,
            },
          ],
        },
      },
    });
  });
  await page.route(
    "http://127.0.0.1:3001/v1/telegram/session",
    async (route) => {
      await route.fulfill({
        json: {
          user: { id: "demo", firstName: "Builder", username: "omnilp_demo" },
          demo: true,
          token: "telegram-test-session",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      });
    },
  );
  await page.route("http://127.0.0.1:3001/v1/flows", async (route) => {
    await route.fulfill({
      status: 201,
      json: {
        flow: {
          id: flowId,
          type: "entry",
          state: "draft",
          poolId: "usdt-ston",
          sourceUnits: "25000000",
          createdAt: now,
          updatedAt: now,
          version: 0,
          nextActions: ["request_quote"],
        },
      },
    });
  });
});

test("runs inside a Telegram launch without layout overflow", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "STON.fi pool" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /USDT \/ STON/ }),
  ).toBeVisible();
  await expect(page.getByText("$42,250")).toBeVisible();
  await expect(
    page.locator("header").getByText("Test", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("0x1111...1111")).toBeVisible();
  await page.getByRole("button", { name: "Change" }).click();
  await expect(page.getByText("0x2222...2222")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create review" })).toHaveCount(
    0,
  );
  await page.evaluate(() =>
    (
      window as Window & { __telegramTest: { main(): void } }
    ).__telegramTest.main(),
  );
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
  await expect(page.getByText("Review created")).toBeVisible();
  await expect(page.getByText("draft", { exact: true })).toBeVisible();

  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth + 1,
  );
  expect(overflows).toBe(false);
  await page.screenshot({
    path: `/tmp/omnilp-${testInfo.project.name}.png`,
    fullPage: true,
  });
  await page.evaluate(() =>
    (
      window as Window & { __telegramTest: { back(): void } }
    ).__telegramTest.back(),
  );
  await expect(
    page.getByRole("heading", { name: "STON.fi pool" }),
  ).toBeVisible();
});

test("does not expose the product outside Telegram", async ({ page }) => {
  await page.unroute("https://telegram.org/js/telegram-web-app.js?63");
  await page.route(
    "https://telegram.org/js/telegram-web-app.js?63",
    async (route) => {
      await route.fulfill({
        contentType: "application/javascript",
        body: "window.Telegram={WebApp:{initData:'',colorScheme:'light'}};",
      });
    },
  );
  await page.goto("/");
  await expect(
    page.getByRole("strong").filter({ hasText: "Open in Telegram" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "STON.fi pool" })).toHaveCount(
    0,
  );
});

test("shows wallet proof cards in draft state", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "STON.fi pool" }),
  ).toBeVisible();
  await page.evaluate(() =>
    (
      window as Window & { __telegramTest: { main(): void } }
    ).__telegramTest.main(),
  );
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Wallet proof" })).toBeVisible();
  await expect(page.getByText("Base wallet")).toBeVisible();
  await expect(page.getByText("TON wallet")).toBeVisible();
  await expect(page.getByRole("button", { name: "Prove" }).first()).toBeVisible();
});

test("shows action card with next steps for draft flow", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "STON.fi pool" }),
  ).toBeVisible();
  await page.evaluate(() =>
    (
      window as Window & { __telegramTest: { main(): void } }
    ).__telegramTest.main(),
  );
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
  await expect(page.getByText("Actions")).toBeVisible();
  await expect(page.getByText("Request live quote")).toBeVisible();
});

test("displays timeline stages for draft flow", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "STON.fi pool" }),
  ).toBeVisible();
  await page.evaluate(() =>
    (
      window as Window & { __telegramTest: { main(): void } }
    ).__telegramTest.main(),
  );
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
  await expect(page.getByText("Review created")).toBeVisible();
  await expect(page.locator("ol.timeline").getByText("Wallet proof", { exact: true })).toBeVisible();
  await expect(page.getByText("Route quote")).toBeVisible();
  await expect(page.getByText("Cross-chain execution")).toBeVisible();
  await expect(page.getByText("LP position")).toBeVisible();
});

test("can resume a flow by entering a flow ID", async ({ page }) => {
  const quotedFlowId = "20000000-0000-4000-8000-000000000002";
  await page.route(
    `http://127.0.0.1:3001/v1/flows/${quotedFlowId}/status`,
    async (route) => {
      await route.fulfill({
        json: {
          flow: {
            id: quotedFlowId,
            type: "entry",
            state: "quoted",
            poolId: "usdt-ston",
            sourceUnits: "25000000",
            createdAt: now,
            updatedAt: now,
            version: 2,
            nextActions: ["review_source"],
          },
          quote: {
            id: "quote-resume-1",
            flowId: quotedFlowId,
            direction: "entry",
            resolverId: "resolver-1",
            inputUnits: "25000000",
            outputUnits: "24750000",
            protocolFeeUnits: "250000",
            integratorFeeUnits: "0",
            sourceProtocolAddress: "0x1111111111111111111111111111111111111111",
            destinationProtocolAddress: rawTon(4),
            quotedAt: now,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
          plan: null,
        },
      });
    },
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "STON.fi pool" }),
  ).toBeVisible();
  await page.evaluate(() =>
    (
      window as Window & { __telegramTest: { main(): void } }
    ).__telegramTest.main(),
  );
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
  await page.getByLabel("Flow ID").fill(quotedFlowId);
  await page.getByTitle("Load flow").click();
  await expect(page.getByText("quoted")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Quote" })).toBeVisible();
  await expect(page.getByText("You send")).toBeVisible();
  await expect(page.getByText(/25.*USDC/)).toBeVisible();
  await expect(page.getByText(/24\.75.*USDT/)).toBeVisible();
  await expect(page.getByText("review source order").or(page.getByText("Review source order"))).toBeVisible();
});

test("shows deposit plan section for funded flow", async ({ page }) => {
  const fundedFlowId = "30000000-0000-4000-8000-000000000003";
  await page.route(
    `http://127.0.0.1:3001/v1/flows/${fundedFlowId}/status`,
    async (route) => {
      await route.fulfill({
        json: {
          flow: {
            id: fundedFlowId,
            type: "entry",
            state: "deposit_ready",
            poolId: "usdt-ston",
            sourceUnits: "25000000",
            createdAt: now,
            updatedAt: now,
            version: 6,
            nextActions: ["submit_deposit"],
          },
          quote: {
            id: "quote-funded-1",
            flowId: fundedFlowId,
            direction: "entry",
            resolverId: "resolver-1",
            inputUnits: "25000000",
            outputUnits: "24750000",
            protocolFeeUnits: "250000",
            integratorFeeUnits: "0",
            sourceProtocolAddress: "0x1111111111111111111111111111111111111111",
            destinationProtocolAddress: rawTon(4),
            quotedAt: now,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
          plan: {
            id: "a0000001-0000-4000-8000-000000000003",
            flowId: fundedFlowId,
            poolId: "usdt-ston",
            mode: "single",
            inputUnits: "24750000",
            token0Units: "24750000",
            token1Units: "0",
            minLpUnits: "24000000",
            lpUnitsBefore: "0",
            gasUnits: "300000000",
            priceImpactPips: 1200,
            indicative: false,
            routerAddress: rawTon(2),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        },
      });
    },
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "STON.fi pool" }),
  ).toBeVisible();
  await page.evaluate(() =>
    (
      window as Window & { __telegramTest: { main(): void } }
    ).__telegramTest.main(),
  );
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
  await page.getByLabel("Flow ID").fill(fundedFlowId);
  await page.getByTitle("Load flow").click();
  await expect(page.getByRole("heading", { name: "Deposit plan" })).toBeVisible();
  await expect(page.getByText(/submit deposit/i)).toBeVisible();
  await expect(page.getByText(/24\.75.*USDT/)).toBeVisible();
  await expect(page.getByText(/single/)).toBeVisible();
});

test("shows exit timeline for completed entry flow", async ({ page }) => {
  const exitFlowId = "40000000-0000-4000-8000-000000000004";
  await page.route(
    `http://127.0.0.1:3001/v1/flows/${exitFlowId}/status`,
    async (route) => {
      await route.fulfill({
        json: {
          flow: {
            id: exitFlowId,
            type: "exit",
            state: "exit_quoted",
            poolId: "usdt-ston",
            sourceUnits: "25000000",
            createdAt: now,
            updatedAt: now,
            version: 4,
            nextActions: ["review_exit"],
          },
          quote: {
            id: "quote-exit-1",
            flowId: exitFlowId,
            direction: "exit",
            resolverId: "resolver-exit",
            inputUnits: "24000000",
            outputUnits: "23500000",
            protocolFeeUnits: "240000",
            integratorFeeUnits: "0",
            sourceProtocolAddress: rawTon(4),
            destinationProtocolAddress: "0x1111111111111111111111111111111111111111",
            quotedAt: now,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
          plan: null,
        },
      });
    },
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "STON.fi pool" }),
  ).toBeVisible();
  await page.evaluate(() =>
    (
      window as Window & { __telegramTest: { main(): void } }
    ).__telegramTest.main(),
  );
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
  await page.getByLabel("Flow ID").fill(exitFlowId);
  await page.getByTitle("Load flow").click();
  await expect(page.getByText(/exit quoted/)).toBeVisible();
  await expect(page.locator("ol.timeline").getByText("Build withdrawal")).toBeVisible();
  await expect(page.locator("ol.timeline").getByText("Submit withdrawal")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Exit quote" })).toBeVisible();
  await expect(page.getByText(/24.*USDT/)).toBeVisible();
  await expect(page.getByText(/23\.5.*USDC/)).toBeVisible();
});

test("shows trade status card for active trade", async ({ page }) => {
  const tradeFlowId = "50000000-0000-4000-8000-000000000005";
  await page.route(
    `http://127.0.0.1:3001/v1/flows/${tradeFlowId}/status`,
    async (route) => {
      await route.fulfill({
        json: {
          flow: {
            id: tradeFlowId,
            type: "entry",
            state: "trade_pending",
            poolId: "usdt-ston",
            sourceUnits: "25000000",
            createdAt: now,
            updatedAt: now,
            version: 3,
            nextActions: ["refresh_trade"],
          },
          quote: {
            id: "quote-trade-1",
            flowId: tradeFlowId,
            direction: "entry",
            resolverId: "resolver-1",
            inputUnits: "25000000",
            outputUnits: "24750000",
            protocolFeeUnits: "250000",
            integratorFeeUnits: "0",
            sourceProtocolAddress: "0x1111111111111111111111111111111111111111",
            destinationProtocolAddress: rawTon(4),
            quotedAt: now,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
          plan: null,
        },
      });
    },
  );
  await page.route(
    `http://127.0.0.1:3001/v1/flows/${tradeFlowId}/trade`,
    async (route) => {
      await route.fulfill({
        json: {
          trade: {
            id: "trade-001",
            flowId: tradeFlowId,
            quoteId: "quote-trade-1",
            orderHash: "trade-omni-001",
            status: "registered",
            receivedUnits: null,
            reference: null,
            checkedAt: now,
          },
        },
      });
    },
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "STON.fi pool" }),
  ).toBeVisible();
  await page.evaluate(() =>
    (
      window as Window & { __telegramTest: { main(): void } }
    ).__telegramTest.main(),
  );
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
  await page.getByLabel("Flow ID").fill(tradeFlowId);
  await page.getByTitle("Load flow").click();
  await expect(page.getByText("Trade status")).toBeVisible();
  await expect(page.getByText("registered")).toBeVisible();
  await expect(page.getByText("Refresh trade state").or(page.getByText("refresh trade state"))).toBeVisible();
});

test("shows completed position card for finished entry", async ({ page }) => {
  const completeFlowId = "60000000-0000-4000-8000-000000000006";
  await page.route(
    `http://127.0.0.1:3001/v1/flows/${completeFlowId}/status`,
    async (route) => {
      await route.fulfill({
        json: {
          flow: {
            id: completeFlowId,
            type: "entry",
            state: "complete",
            poolId: "usdt-ston",
            sourceUnits: "25000000",
            createdAt: now,
            updatedAt: now,
            version: 8,
            nextActions: ["view_position", "start_exit"],
          },
          quote: null,
          plan: null,
        },
      });
    },
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "STON.fi pool" }),
  ).toBeVisible();
  await page.evaluate(() =>
    (
      window as Window & { __telegramTest: { main(): void } }
    ).__telegramTest.main(),
  );
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
  await page.getByLabel("Flow ID").fill(completeFlowId);
  await page.getByTitle("Load flow").click();
  await expect(page.getByRole("heading", { name: "LP position open" })).toBeVisible();
  await expect(page.getByText(/position is live/)).toBeVisible();
});

test("shows exit complete card for finished exit", async ({ page }) => {
  const exitCompleteId = "70000000-0000-4000-8000-000000000007";
  await page.route(
    `http://127.0.0.1:3001/v1/flows/${exitCompleteId}/status`,
    async (route) => {
      await route.fulfill({
        json: {
          flow: {
            id: exitCompleteId,
            type: "exit",
            state: "exit_complete",
            poolId: "usdt-ston",
            sourceUnits: "25000000",
            createdAt: now,
            updatedAt: now,
            version: 6,
            nextActions: [],
          },
          quote: null,
          plan: null,
        },
      });
    },
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "STON.fi pool" }),
  ).toBeVisible();
  await page.evaluate(() =>
    (
      window as Window & { __telegramTest: { main(): void } }
    ).__telegramTest.main(),
  );
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
  await page.getByLabel("Flow ID").fill(exitCompleteId);
  await page.getByTitle("Load flow").click();
  await expect(page.getByRole("heading", { name: "Funds returned" })).toBeVisible();
  await expect(page.getByText(/USDC has been returned/)).toBeVisible();
});
