import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';

/**
 * How many proxies we operate sit between the client and this process.
 *
 * `X-Forwarded-For` is append-only, and every hop adds the address it received
 * the request from, so the chain ends with the entries our own infrastructure
 * wrote and begins with whatever the client chose to send. The count is what
 * tells the two apart: with `n` trusted proxies, the client's real address is
 * the `n`-th entry from the right, and everything to its left is unverifiable.
 *
 * Configured via `TRUST_PROXY_HOPS`. The older boolean `TRUST_PROXY=true` still
 * works and means one hop — the common single-reverse-proxy deployment — so an
 * existing environment keeps working while no longer reading the spoofable end
 * of the chain.
 */
export const trustedProxyHops = (): number => {
  const configured = (process.env.TRUST_PROXY_HOPS ?? '').trim();

  if (configured) {
    const hops = Number(configured);
    // A malformed value must not silently grant trust.
    return Number.isInteger(hops) && hops >= 0 ? hops : 0;
  }

  return (process.env.TRUST_PROXY ?? '').trim().toLowerCase() === 'true' ? 1 : 0;
};

/**
 * Resolve the caller's IP, preferring the real TCP peer address.
 *
 * Returns `undefined` only when neither a trusted forwarded header nor socket
 * information is available (in practice: synthetic requests that never touched a
 * socket). Callers must decide how to handle that rather than collapsing every
 * such request onto one shared identity.
 */
export const getClientIp = (c: Context): string | undefined => {
  const hops = trustedProxyHops();

  if (hops > 0) {
    const forwarded = (c.req.header('x-forwarded-for') ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);

    // Counting from the right skips exactly the hops we vouch for. A client that
    // prepends entries of its own only pads the untrusted left side and cannot
    // move this index onto a value it controls. A chain shorter than `hops` means
    // the request did not arrive through the expected path, so fall through to
    // the peer address rather than accept the leftmost entry.
    const candidate = forwarded[forwarded.length - hops];
    if (candidate) return candidate;
  }

  try {
    const address = getConnInfo(c).remote?.address;
    return address || undefined;
  } catch {
    // No Node connection info attached to this context.
    return undefined;
  }
};
