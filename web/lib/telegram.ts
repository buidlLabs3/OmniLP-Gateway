export interface TelegramWebApp {
  initData: string;
  colorScheme: "light" | "dark";
  ready(): void;
  expand(): void;
  disableVerticalSwipes?(): void;
  HapticFeedback?: {
    impactOccurred(style: "light" | "medium" | "heavy"): void;
    notificationOccurred(type: "error" | "success" | "warning"): void;
    selectionChanged(): void;
  };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

export function startTelegram(): TelegramWebApp | null {
  const app = window.Telegram?.WebApp ?? null;
  if (!app?.initData) return null;
  app.ready();
  app.expand();
  app.disableVerticalSwipes?.();
  document.documentElement.dataset.telegramTheme = app.colorScheme;
  return app;
}

export function tap(kind: "select" | "success" | "error" = "select"): void {
  const haptic = window.Telegram?.WebApp?.HapticFeedback;
  if (!haptic) return;
  if (kind === "select") haptic.selectionChanged();
  else haptic.notificationOccurred(kind);
}
