"use client";

import { TonConnectUIProvider } from "@tonconnect/ui-react";
import type { ReactNode } from "react";

const manifestUrl =
  process.env.NEXT_PUBLIC_TONCONNECT_MANIFEST_URL ??
  `${process.env.NEXT_PUBLIC_APP_URL ?? "http://127.0.0.1:3000"}/tonconnect-manifest.json`;
const botUrl = process.env.NEXT_PUBLIC_TELEGRAM_BOT_URL as
  | `${string}://${string}`
  | undefined;

export function Providers({ children }: { children: ReactNode }) {
  return (
    <TonConnectUIProvider
      manifestUrl={manifestUrl}
      {...(botUrl ? { actionsConfiguration: { twaReturnUrl: botUrl } } : {})}
      uiPreferences={{ theme: "SYSTEM", borderRadius: "s" }}
    >
      {children}
    </TonConnectUIProvider>
  );
}
