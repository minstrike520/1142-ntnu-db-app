/**
 * In-memory replacement for the `socket.io-client` package (see
 * vitest.config.ts alias). The real `src/lib/socket.ts` module runs unchanged
 * on top of this fake, so every socket handler registered by ChatContext is
 * exercised exactly as in production.
 *
 * Tests drive server pushes with `__getSocket().serverEmit(event, payload)`
 * and can inspect client emissions via `__getSocket().emitted`.
 */

type Handler = (...args: unknown[]) => void;

export class MockSocket {
  connected = false;
  auth: Record<string, unknown> = {};
  /** Every client → server emission, in order. */
  emitted: Array<{ event: string; payload: unknown }> = [];

  private handlers = new Map<string, Set<Handler>>();

  on(event: string, handler: Handler): this {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
    return this;
  }

  off(event: string, handler?: Handler): this {
    if (!handler) {
      this.handlers.delete(event);
      return this;
    }
    this.handlers.get(event)?.delete(handler);
    return this;
  }

  emit(event: string, payload?: unknown): this {
    this.emitted.push({ event, payload });
    return this;
  }

  connect(): this {
    this.connected = true;
    this.serverEmit("connect");
    return this;
  }

  disconnect(): this {
    this.connected = false;
    return this;
  }

  /** Simulate a server → client push. */
  serverEmit(event: string, ...args: unknown[]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of [...set]) {
      handler(...args);
    }
  }

  /** Number of client emissions for one event type. */
  countEmitted(event: string): number {
    return this.emitted.filter((e) => e.event === event).length;
  }
}

let latestSocket: MockSocket | null = null;

export const io = (..._args: unknown[]): MockSocket => {
  latestSocket = new MockSocket();
  return latestSocket;
};

export const __getSocket = (): MockSocket => {
  if (!latestSocket) {
    throw new Error("No socket created yet — did the app mount and authenticate?");
  }
  return latestSocket;
};

export const __resetSocket = (): void => {
  latestSocket = null;
};

// Type-only export so `import { type Socket } from "socket.io-client"` keeps
// compiling if a module under test uses it with this mock at runtime.
export type Socket = MockSocket;
