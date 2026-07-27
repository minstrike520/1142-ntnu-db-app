/**
 * Only ever redirect to a same-origin relative path. Rejects protocol-relative
 * ("//evil.com") and backslash-normalized ("/\evil.com") open-redirect payloads,
 * plus the auth pages themselves so a redirect cannot loop back on them.
 */
export const sanitizeRedirect = (raw: string | null): string => {
  if (raw && /^\/(?![/\\])/.test(raw) && raw !== "/login" && raw !== "/register") {
    return raw;
  }
  return "/";
};

/** Read and sanitize the `redirect` query parameter of the current URL. */
export const readRedirectParam = (): string => {
  if (typeof window === "undefined") return "/";
  return sanitizeRedirect(new URLSearchParams(window.location.search).get("redirect"));
};

/** Build a link to `path` that carries the pending redirect target along. */
export const withRedirectParam = (path: string, redirectTo: string): string =>
  redirectTo && redirectTo !== "/"
    ? `${path}?redirect=${encodeURIComponent(redirectTo)}`
    : path;
