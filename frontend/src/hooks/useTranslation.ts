"use client";

import { useCallback } from "react";
import { useChat } from "@/context/ChatContext";
import { translate } from "@/lib/i18n";

export function useTranslation() {
  const { uiLanguage } = useChat();

  const t = useCallback(
    (key: string, replacements?: Record<string, string | number>): string =>
      translate(uiLanguage, key, replacements),
    [uiLanguage],
  );

  return { t, locale: uiLanguage };
}
