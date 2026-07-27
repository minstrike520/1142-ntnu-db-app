/** Pages that must never be a post-auth destination, or the user loops back to them. */
const AUTH_PATHNAMES = new Set(["/login", "/register"]);

// Reserved TLD (RFC 2606), so it can never collide with a real deployment origin.
const RESOLVE_BASE = "http://redirect.invalid";

/**
 * Only ever redirect to a same-origin relative path.
 *
 * Pattern-matching the raw string is not sufficient: the URL parser strips tab
 * and newline characters before resolving, so a payload like "/\t/evil.example"
 * (delivered percent-encoded as `%09`, which `URLSearchParams` decodes) looks
 * like a rooted path to a regex yet resolves to "//evil.example". Everything is
 * therefore resolved against a sentinel origin first, and only inputs that stay
 * on that origin are accepted. The parser's normalized output is returned rather
 * than the caller's string so no smuggled control characters survive.
 */
export const sanitizeRedirect = (raw: string | null): string => {
  if (!raw || !raw.startsWith("/")) return "/";

  let url: URL;
  try {
    url = new URL(raw, RESOLVE_BASE);
  } catch {
    return "/";
  }
  if (url.origin !== RESOLVE_BASE) return "/";

  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  if (AUTH_PATHNAMES.has(pathname)) return "/";

  // Matching the parsed origin is not on its own enough: naming the sentinel host
  // in a protocol-relative input ("//redirect.invalid//evil.example") keeps the
  // origin intact while leaving a protocol-relative *pathname* behind. Validate
  // the string actually handed to the router, which is what gets navigated to.
  const target = `${url.pathname}${url.search}${url.hash}`;
  return /^\/(?![/\\])/.test(target) ? target : "/";
};

/** Read and sanitize the `redirect` query parameter of the current URL. */
export const readRedirectParam = (): string => {
  if (typeof window === "undefined") return "/";
  return sanitizeRedirect(new URLSearchParams(window.location.search).get("redirect"));
};

/**
 * Server snapshot for `useSyncExternalStore`. The server cannot see the query
 * string during pre-render, so it must report the same value every time and let
 * React re-render with the real target after hydration; reading
 * `window.location` in a `useState` initializer would instead bake a mismatched
 * value into attributes such as `<Link href>`, which React does not repair.
 */
export const getServerRedirect = (): string => "/";

/** The URL cannot change without a navigation, so there is nothing to observe. */
export const subscribeToRedirect = (): (() => void) => () => {};

/** Build a link to `path` that carries the pending redirect target along. */
export const withRedirectParam = (path: string, redirectTo: string): string =>
  redirectTo && redirectTo !== "/"
    ? `${path}?redirect=${encodeURIComponent(redirectTo)}`
    : path;
