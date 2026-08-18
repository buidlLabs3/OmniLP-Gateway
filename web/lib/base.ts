import {
  createBaseAccountSDK,
  type ProviderInterface,
} from "@base-org/account";

interface InjectedProvider {
  request(input: { method: string; params?: unknown[] }): Promise<unknown>;
}

type Provider = ProviderInterface | InjectedProvider;

let baseProvider: Provider | null = null;
let baseAddress = "";

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
  baseAddress = address;
  return address;
}

export async function signBaseMessage(message: string): Promise<string> {
  if (!baseProvider || !baseAddress) {
    throw new Error("Base wallet is not connected");
  }
  const value = await baseProvider.request({
    method: "personal_sign",
    params: [message, baseAddress],
  });
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(value)) {
    throw new Error("Wallet returned an invalid signature");
  }
  return value;
}

declare global {
  interface Window {
    ethereum?: InjectedProvider;
  }
}
