"use client";

import { useSyncExternalStore } from "react";
import { getActiveAccessToken } from "@/lib/api";

const subscribe = (onStoreChange: () => void): (() => void) => {
  window.addEventListener("auth:token-changed", onStoreChange);
  return () => window.removeEventListener("auth:token-changed", onStoreChange);
};

const getSnapshot = (): string | null => getActiveAccessToken();
const getServerSnapshot = (): string | null => null;

export function useActiveAccessToken(): string | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
