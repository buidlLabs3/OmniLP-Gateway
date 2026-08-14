import { TON_USDT, poolSchema, type Pool } from "@omnilp/shared";

const rawTon = (id: number) => `0:${id.toString(16).padStart(64, "0")}`;

export const demoPools: Pool[] = [
  poolSchema.parse({
    id: "usdt-ston",
    address: rawTon(101),
    routerAddress: rawTon(102),
    token0: {
      address: TON_USDT,
      symbol: "USDT",
      name: "Tether USD",
      decimals: 6,
    },
    token1: {
      address: rawTon(103),
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
    aprPips: 128_400,
    checkedAt: new Date().toISOString(),
  }),
];
