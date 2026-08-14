import { expect, test } from "@playwright/test";

const now = new Date().toISOString();
const rawTon = (id: number) => `0:${id.toString(16).padStart(64, "0")}`;

test.beforeEach(async ({ page }) => {
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
            aprPips: null,
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
});

test("renders the pool workspace without horizontal overflow", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Approved pools" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /USDT \/ STON/ }),
  ).toBeVisible();
  await expect(page.getByText("$42,250.00")).toBeVisible();
  await expect(page.getByRole("button", { name: /USDT \/ STON/ })).toHaveClass(
    /selected/,
  );
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth + 1,
  );
  expect(overflows).toBe(false);
  await page.screenshot({
    path: `/tmp/omnilp-${testInfo.project.name}.png`,
    fullPage: true,
  });
});
