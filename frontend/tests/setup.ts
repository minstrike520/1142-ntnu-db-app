import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// React requires this flag for act() support outside of react-dom/test-utils.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom lacks matchMedia (ChatContext reads prefers-color-scheme on bootstrap).
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

// jsdom lacks scrollIntoView (Chatroom auto-scrolls the message list).
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {
    /* no-op in tests */
  };
}

// Safety net: some jsdom setups omit rAF when not pretending to be visual.
if (typeof window !== "undefined" && !window.requestAnimationFrame) {
  window.requestAnimationFrame = (cb: FrameRequestCallback): number =>
    setTimeout(() => cb(performance.now()), 16) as unknown as number;
  window.cancelAnimationFrame = (handle: number) => clearTimeout(handle);
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});
