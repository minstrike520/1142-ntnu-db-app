/**
 * Replacement for `next/navigation` (see vitest.config.ts alias).
 *
 * Provides a controllable pathname backed by useSyncExternalStore, so
 * `usePathname()` / `useParams()` consumers re-render exactly like they would
 * on a real App Router navigation. Tests change routes with `__setPathname`
 * (inside act) or by clicking UI that calls `router.push`.
 */
import { useSyncExternalStore } from "react";

let currentPathname = "/";
const listeners = new Set<() => void>();

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const getSnapshot = () => currentPathname;

export const __setPathname = (pathname: string): void => {
  if (pathname === currentPathname) return;
  currentPathname = pathname;
  for (const listener of [...listeners]) listener();
};

export const __getPathname = (): string => currentPathname;

export const __resetNavigation = (pathname = "/"): void => {
  currentPathname = pathname;
  listeners.clear();
};

export function usePathname(): string {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

const router = {
  push: (path: string) => __setPathname(path),
  replace: (path: string) => __setPathname(path),
  back: () => undefined,
  forward: () => undefined,
  refresh: () => undefined,
  prefetch: () => undefined,
};

export function useRouter(): typeof router {
  return router;
}

export function useParams(): Record<string, string> {
  const pathname = usePathname();
  const chatMatch = pathname.match(/^\/chat\/([^/]+)$/);
  if (chatMatch) return { chatId: chatMatch[1] };
  return {};
}

export function useSearchParams(): URLSearchParams {
  return new URLSearchParams();
}

export function redirect(path: string): never {
  throw new Error(`redirect(${path}) called in test`);
}

export function notFound(): never {
  throw new Error("notFound() called in test");
}
