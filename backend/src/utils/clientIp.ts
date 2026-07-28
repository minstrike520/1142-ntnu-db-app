import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';

/**
 * `X-Forwarded-For` is client-controlled unless a proxy we trust rewrites it, so
 * it is only consulted when the deployment opts in via `TRUST_PROXY=true`.
 */
export const trustProxyEnabled = (): boolean =>
  (process.env.TRUST_PROXY ?? '').trim().toLowerCase() === 'true';

/**
 * Resolve the caller's IP, preferring the real TCP peer address.
 *
 * Returns `undefined` only when neither a trusted forwarded header nor socket
 * information is available (in practice: synthetic requests that never touched a
 * socket). Callers must decide how to handle that rather than collapsing every
 * such request onto one shared identity.
 */
export const getClientIp = (c: Context): string | undefined => {
  if (trustProxyEnabled()) {
    const forwarded = c.req.header('x-forwarded-for');
    const first = forwarded?.split(',')[0]?.trim();
    if (first) return first;
  }

  try {
    const address = getConnInfo(c).remote?.address;
    return address || undefined;
  } catch {
    // No Node connection info attached to this context.
    return undefined;
  }
};
