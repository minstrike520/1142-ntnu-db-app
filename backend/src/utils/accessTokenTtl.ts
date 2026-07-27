export const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 60 * 60,
  d: 24 * 60 * 60,
};

/**
 * Parse a `JWT_EXPIRES_IN`-style duration (`15m`, `2h`, `7d`, or bare seconds)
 * into seconds, falling back when the value is missing or unusable.
 */
export const parseDurationSeconds = (
  value: string | undefined,
  fallbackSeconds: number,
): number => {
  if (!value) return fallbackSeconds;

  const match = value.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)(s|m|h|d)?$/);
  if (!match) return fallbackSeconds;

  // A long-enough digit string parses to Infinity, which would otherwise sail
  // past `> 0` and serialize the JWT's `exp` as null — a token with no usable
  // expiry rather than the documented fallback.
  const seconds = Math.floor(Number(match[1]) * UNIT_SECONDS[match[2] ?? 's']);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : fallbackSeconds;
};

export const getAccessTokenTtlSeconds = (): number =>
  parseDurationSeconds(process.env.JWT_EXPIRES_IN, DEFAULT_ACCESS_TOKEN_TTL_SECONDS);
