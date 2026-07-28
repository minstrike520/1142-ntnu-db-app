"use client";

import { useCallback } from "react";
import { useUiLanguage } from "@/context/ChatContext";
import { translate } from "@/lib/i18n";

export function useTranslation() {
  // Subscribes to the language-only context: translation consumers must not
  // re-render whenever unrelated chat state (messages, typing, …) changes.
  const uiLanguage = useUiLanguage();

  const t = useCallback(
    (key: string, replacements?: Record<string, string | number>): string =>
      translate(uiLanguage, key, replacements),
    [uiLanguage],
  );

  return { t, locale: uiLanguage };
}
