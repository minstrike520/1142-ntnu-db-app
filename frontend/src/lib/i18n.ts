import zhTW from "@/locales/zh-TW.json";
import en from "@/locales/en.json";

const translations = {
  "zh-TW": zhTW,
  en: en,
} as const;

export type Locale = keyof typeof translations;

export const isLocale = (value: unknown): value is Locale => value === "zh-TW" || value === "en";

/**
 * Resolve a dot-separated translation key against a locale, falling back to
 * English and then Traditional Chinese. Pure lookup with no React dependency so
 * pre-auth pages (which render outside `ChatProvider`) can localize too.
 */
export const translate = (
  locale: string,
  key: string,
  replacements?: Record<string, string | number>,
): string => {
  const keys = key.split(".");
  const localesToTry: Locale[] = [isLocale(locale) ? locale : "zh-TW", "en", "zh-TW"];

  let current: unknown = null;
  for (const candidateLocale of localesToTry) {
    let candidate: unknown = translations[candidateLocale];
    let found = true;

    for (const k of keys) {
      if (candidate && typeof candidate === "object" && k in candidate) {
        candidate = (candidate as Record<string, unknown>)[k];
      } else {
        found = false;
        break;
      }
    }

    if (found) {
      current = candidate;
      break;
    }
  }

  if (current === null) {
    console.warn(`Translation key not found: ${key} for locale: ${locale}`);
    return key;
  }

  if (typeof current !== "string") {
    return key;
  }

  let text = current;
  if (replacements) {
    Object.entries(replacements).forEach(([k, v]) => {
      text = text.replace(new RegExp(`{${k}}`, "g"), String(v));
    });
  }

  return text;
};

/** Locale assumed during server rendering, matching ChatContext's initial state. */
export const DEFAULT_LOCALE: Locale = "zh-TW";

/**
 * Read the persisted UI language without React context. Mirrors the
 * `localStorage` key written by `setUiLanguage` in ChatContext.
 */
export const getStoredLocale = (): Locale => {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  try {
    const saved = localStorage.getItem("language");
    return isLocale(saved) ? saved : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
};

/** Server snapshot for `useSyncExternalStore`; always the SSR-stable default. */
export const getServerLocale = (): Locale => DEFAULT_LOCALE;

const localeListeners = new Set<() => void>();

/**
 * Persist the UI language and notify subscribers. The `storage` event only fires
 * in *other* tabs, so same-tab writes have to notify explicitly.
 */
export const setStoredLocale = (locale: Locale): void => {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem("language", locale);
  } catch {
    // Ignore quota/privacy-mode failures; the in-memory notification still runs.
  }
  localeListeners.forEach((listener) => listener());
};

/**
 * Subscribe to language changes. Paired with `getStoredLocale` in
 * `useSyncExternalStore` so server and client agree during hydration and React
 * re-renders once the stored preference is readable.
 */
export const subscribeToLocale = (onStoreChange: () => void): (() => void) => {
  if (typeof window === "undefined") return () => {};
  localeListeners.add(onStoreChange);
  window.addEventListener("storage", onStoreChange);
  return () => {
    localeListeners.delete(onStoreChange);
    window.removeEventListener("storage", onStoreChange);
  };
};
