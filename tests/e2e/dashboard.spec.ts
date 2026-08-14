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
