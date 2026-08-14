import {
  createBaseAccountSDK,
  type ProviderInterface,
} from "@base-org/account";

interface InjectedProvider {
  request(input: { method: string; params?: unknown[] }): Promise<unknown>;
}

let baseProvider: ProviderInterface | InjectedProvider | null = null;

function accounts(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new Error("Wallet did not return an account");
  }
  return value;
}

export async function connectBaseWallet(): Promise<string> {
  const injected = window.ethereum;
  if (injected) {
    baseProvider = injected;
    await injected.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x2105" }],
    });
  } else {
    baseProvider = createBaseAccountSDK({
      appName: "OmniLP Gateway",
      appLogoUrl: `${process.env.NEXT_PUBLIC_APP_URL ?? window.location.origin}/tonconnect-icon`,
      appChainIds: [8453],
      preference: { telemetry: false },
    }).getProvider();
  }
  const value = await baseProvider.request({ method: "eth_requestAccounts" });
  const [address] = accounts(value);
  if (!address) throw new Error("Wallet did not return an account");
  return address;
}

declare global {
  interface Window {
    ethereum?: InjectedProvider;
  }
}
