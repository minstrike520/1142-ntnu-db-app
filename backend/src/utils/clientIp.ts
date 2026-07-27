import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { isIP } from 'node:net';

/**
 * `X-Forwarded-For` is client-controlled unless a proxy we trust rewrites it, so
 * it is only consulted when the deployment opts in via `TRUST_PROXY=true`.
 *
 * This is the blunt "every peer is a proxy" switch. Prefer `TRUSTED_PROXY_IPS`,
 * which only trusts the addresses the deployment actually puts in front of this
 * service.
 */
export const trustProxyEnabled = (): boolean =>
  (process.env.TRUST_PROXY ?? '').trim().toLowerCase() === 'true';

/**
 * Normalise an address so peer addresses and header values compare as equals.
 *
 * Returns `undefined` for anything that is not a valid IP, so a malformed hop
 * can never become a rate-limit bucket of its own.
 */
export const normalizeIp = (value: string): string | undefined => {
  let candidate = value.trim();
  if (!candidate) return undefined;

  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(candidate);
  if (bracketed) {
    // `[2001:db8::1]:443`
    candidate = bracketed[1]!;
  } else if ((candidate.match(/:/g) ?? []).length === 1) {
    // `203.0.113.1:443`. Only a single colon can be a port separator — a bare
    // IPv6 address always has more, so it survives intact.
    candidate = candidate.split(':')[0]!;
  }

  // Dual-stack sockets report IPv4 peers as `::ffff:203.0.113.1`.
  const mapped = /^::ffff:(.+)$/i.exec(candidate);
  if (mapped && isIP(mapped[1]!) === 4) {
    candidate = mapped[1]!;
  }

  return isIP(candidate) === 0 ? undefined : candidate.toLowerCase();
};

/**
 * Addresses allowed to speak for someone else, as an exact-match list.
 *
 * Deliberately not CIDR ranges: the obvious range to write here would be the
 * container network, but the bridge gateway sits inside it and is the peer
 * address every host-local caller arrives as — trusting the range would hand
 * those callers the ability to pick their own bucket by header.
 */
export const trustedProxyIps = (): string[] =>
  (process.env.TRUSTED_PROXY_IPS ?? '')
    .split(',')
    .map((entry) => normalizeIp(entry))
    .filter((entry): entry is string => entry !== undefined);

const peerAddress = (c: Context): string | undefined => {
  let address: string | undefined;
  try {
    address = getConnInfo(c).remote?.address;
  } catch {
    // No Node connection info attached to this context.
    return undefined;
  }
  // Fall back to the raw address rather than dropping attribution entirely if
  // it arrives in a shape `normalizeIp` does not recognise.
  const raw = address?.trim();
  if (!raw) return undefined;
  return normalizeIp(raw) ?? raw;
};

const UNTRUSTED_FORWARD_WARNING_INTERVAL_MS = 5 * 60 * 1000;
let lastUntrustedForwardWarningAt = 0;

/** Exported so tests can exercise the throttle without waiting out the window. */
export const resetUntrustedForwardWarning = (): void => {
  lastUntrustedForwardWarningAt = 0;
};

/**
 * A forwarded header from an untrusted peer is usually harmless spoofing, but it
 * is also the only symptom of a misrouted deployment — e.g. a tunnel whose
 * origin points at the published host port instead of at the service, which
 * silently puts every external user back into the gateway's single bucket.
 * Silence there is indistinguishable from working correctly, so say something
 * (rarely).
 */
const warnUntrustedForwardedHeader = (peer: string | undefined): void => {
  if (process.env.NODE_ENV === 'test') return;

  const now = Date.now();
  if (now - lastUntrustedForwardWarningAt < UNTRUSTED_FORWARD_WARNING_INTERVAL_MS) return;
  lastUntrustedForwardWarningAt = now;

  console.warn(
    `[clientIp] Ignoring forwarded client-IP header from untrusted peer ${peer ?? 'unknown'}. ` +
      'If this service sits behind a proxy, add that peer address to TRUSTED_PROXY_IPS; ' +
      'otherwise every caller through it shares one rate-limit bucket.',
  );
};

/**
 * Resolve the caller's IP, preferring the real TCP peer address.
 *
 * Forwarded headers are only read when the peer is a proxy we trust. Within
 * `X-Forwarded-For` the hops are walked right to left: a proxy appends the
 * address it actually received the connection from, so everything to its left
 * is whatever the caller chose to send. Cloudflare documents exactly this
 * append behaviour, which is why the leftmost hop must not be used.
 *
 * Returns `undefined` only when neither a trusted forwarded header nor socket
 * information is available (in practice: synthetic requests that never touched a
 * socket). Callers must decide how to handle that rather than collapsing every
 * such request onto one shared identity.
 */
export const getClientIp = (c: Context): string | undefined => {
  const peer = peerAddress(c);
  const trusted = trustedProxyIps();
  const peerIsTrusted = trustProxyEnabled() || (peer !== undefined && trusted.includes(peer));

  const forwarded = c.req.header('x-forwarded-for');
  const cfConnectingIp = c.req.header('cf-connecting-ip');

  if (!peerIsTrusted) {
    if (forwarded !== undefined || cfConnectingIp !== undefined) warnUntrustedForwardedHeader(peer);
    return peer;
  }

  // Single-valued and set by the edge itself, so it needs no hop selection.
  // Cloudflare recommends it over `X-Forwarded-For` for exactly that reason.
  const cfClient = cfConnectingIp === undefined ? undefined : normalizeIp(cfConnectingIp);
  if (cfClient) return cfClient;

  if (forwarded !== undefined) {
    const hops = forwarded
      .split(',')
      .map((hop) => normalizeIp(hop))
      .filter((hop): hop is string => hop !== undefined);

    for (let i = hops.length - 1; i >= 0; i -= 1) {
      if (!trusted.includes(hops[i]!)) return hops[i];
    }
  }

  return peer;
};
