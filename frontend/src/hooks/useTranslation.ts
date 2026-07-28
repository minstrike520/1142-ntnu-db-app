"use client";

import { useCallback } from "react";
import { useUiLanguage } from "@/context/ChatContext";
import zhTW from "@/locales/zh-TW.json";
import en from "@/locales/en.json";

const translations = {
  "zh-TW": zhTW,
  en: en,
} as const;

export function useTranslation() {
  // Subscribes to the language-only context: translation consumers must not
  // re-render whenever unrelated chat state (messages, typing, …) changes.
  const uiLanguage = useUiLanguage();

  const t = useCallback((key: string, replacements?: Record<string, string | number>): string => {
    const keys = key.split(".");
    const localesToTry = [uiLanguage, "en", "zh-TW"] as const;

    let current: unknown = null;
    for (const locale of localesToTry) {
      let candidate: unknown = translations[locale] || translations["zh-TW"];
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
      console.warn(`Translation key not found: ${key} for locale: ${uiLanguage}`);
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
  }, [uiLanguage]);

  return { t, locale: uiLanguage };
}
