export type NotificationEnvironment =
  | "ssr"
  | "web"
  | "pwa"
  | "tauri"
  | "capacitor"
  | "unsupported";

export type BridgeNotificationPermission = NotificationPermission | "unsupported";

export interface BridgeNotificationOptions {
  title: string;
  body: string;
  icon?: string;
  tag?: string;
  url?: string;
}

type NotificationRuntimeWindow = Window & {
  Notification?: typeof Notification;
  __TAURI__?: unknown;
  __TAURI_INTERNALS__?: unknown;
  Capacitor?: {
    getPlatform?: () => string;
    isNativePlatform?: () => boolean;
  };
};

type StandaloneNavigator = Navigator & {
  standalone?: boolean;
};

const getRuntimeWindow = (): NotificationRuntimeWindow | null =>
  typeof window === "undefined" ? null : (window as NotificationRuntimeWindow);

const getNotificationApi = (
  runtimeWindow: NotificationRuntimeWindow,
): typeof Notification | null =>
  typeof runtimeWindow.Notification === "function" ? runtimeWindow.Notification : null;

const isCapacitorRuntime = (runtimeWindow: NotificationRuntimeWindow): boolean => {
  const capacitor = runtimeWindow.Capacitor;
  if (!capacitor) return false;

  try {
    if (capacitor.isNativePlatform?.()) return true;
    const platform = capacitor.getPlatform?.();
    return Boolean(platform && platform !== "web");
  } catch {
    return false;
  }
};

const isPwaRuntime = (runtimeWindow: Window): boolean => {
  const isStandalone = runtimeWindow.matchMedia?.("(display-mode: standalone)").matches ?? false;
  const isIosStandalone = (runtimeWindow.navigator as StandaloneNavigator).standalone === true;
  return isStandalone || isIosStandalone;
};

const getServiceWorkerRegistration = async (): Promise<ServiceWorkerRegistration | undefined> => {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return undefined;
  }

  return navigator.serviceWorker.getRegistration();
};

const toWebNotificationOptions = ({
  body,
  icon,
  tag,
  url,
}: BridgeNotificationOptions): NotificationOptions => ({
  body,
  ...(icon ? { icon } : {}),
  ...(tag ? { tag } : {}),
  ...(url ? { data: { url } } : {}),
});

export const NotificationBridge = {
  detectEnvironment(): NotificationEnvironment {
    const runtimeWindow = getRuntimeWindow();
    if (!runtimeWindow) return "ssr";

    if (runtimeWindow.__TAURI_INTERNALS__ || runtimeWindow.__TAURI__) return "tauri";
    if (isCapacitorRuntime(runtimeWindow)) return "capacitor";
    if (isPwaRuntime(runtimeWindow)) return "pwa";
    if (getNotificationApi(runtimeWindow) || "serviceWorker" in runtimeWindow.navigator) {
      return "web";
    }
    return "unsupported";
  },

  getPermission(): BridgeNotificationPermission {
    const runtimeWindow = getRuntimeWindow();
    if (!runtimeWindow) return "unsupported";
    return getNotificationApi(runtimeWindow)?.permission ?? "unsupported";
  },

  async requestPermission(): Promise<BridgeNotificationPermission> {
    const runtimeWindow = getRuntimeWindow();
    if (!runtimeWindow) return "unsupported";
    const notificationApi = getNotificationApi(runtimeWindow);
    if (!notificationApi) return "unsupported";

    if (notificationApi.permission !== "default") {
      return notificationApi.permission;
    }

    try {
      return await notificationApi.requestPermission();
    } catch {
      return notificationApi.permission;
    }
  },

  async send(options: BridgeNotificationOptions): Promise<boolean> {
    const runtimeWindow = getRuntimeWindow();
    if (!runtimeWindow || this.getPermission() !== "granted") return false;
    const notificationApi = getNotificationApi(runtimeWindow);

    const notificationOptions = toWebNotificationOptions(options);
    const registration = await getServiceWorkerRegistration().catch(() => undefined);
    if (registration) {
      try {
        await registration.showNotification(options.title, notificationOptions);
        return true;
      } catch {
        // Some embedded runtimes expose Service Worker APIs without supporting
        // persistent notifications. Fall through to the standard Web API.
      }
    }

    try {
      if (!notificationApi) return false;
      const notification = new notificationApi(options.title, notificationOptions);
      if (options.url) {
        notification.onclick = () => {
          runtimeWindow.focus();
          runtimeWindow.location.assign(options.url!);
          notification.close();
        };
      }
      return true;
    } catch {
      return false;
    }
  },
};
