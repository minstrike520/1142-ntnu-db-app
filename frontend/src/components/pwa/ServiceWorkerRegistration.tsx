"use client";

import { useEffect } from "react";

const CACHE_PREFIX = "near-chat-";

const clearDevelopmentWorkerState = async () => {
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((registration) => registration.unregister()));

  if ("caches" in window) {
    const cacheNames = await caches.keys();
    await Promise.all(
      cacheNames
        .filter((cacheName) => cacheName.startsWith(CACHE_PREFIX))
        .map((cacheName) => caches.delete(cacheName)),
    );
  }
};

const getLoadedAppShellAssets = (): string[] => {
  const resourceUrls = [
    ...Array.from(document.querySelectorAll<HTMLScriptElement>("script[src]"), (element) =>
      element.src,
    ),
    ...Array.from(
      document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href]'),
      (element) => element.href,
    ),
  ];

  return [...new Set(resourceUrls)].filter((resourceUrl) => {
    const url = new URL(resourceUrl, window.location.href);
    return url.origin === window.location.origin && url.pathname.startsWith("/_next/static/");
  });
};

export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) {
      return;
    }

    if (process.env.NODE_ENV !== "production") {
      void clearDevelopmentWorkerState().catch((error: unknown) => {
        console.error("Failed to clear development service worker state:", error);
      });
      return;
    }

    const register = async () => {
      try {
        await navigator.serviceWorker.register("/sw.js", {
          scope: "/",
          updateViaCache: "none",
        });
        const readyRegistration = await navigator.serviceWorker.ready;
        readyRegistration.active?.postMessage({
          type: "CACHE_APP_SHELL",
          urls: getLoadedAppShellAssets(),
        });
      } catch (error: unknown) {
        console.error("Service worker registration failed:", error);
      }
    };

    if (document.readyState === "complete") {
      void register();
      return;
    }

    const handleLoad = () => void register();
    window.addEventListener("load", handleLoad);
    return () => window.removeEventListener("load", handleLoad);
  }, []);

  return null;
}
