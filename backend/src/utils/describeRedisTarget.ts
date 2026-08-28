/**
 * Render a Redis connection string as a non-sensitive, log-safe target description.
 *
 * The Redis counterpart of `describeDatabaseTarget`, kept separate rather than
 * folded into it because the path component means something different: for
 * PostgreSQL it is a database name, for Redis it is a numeric database index
 * that defaults to 0 when the URL omits it. Sharing one function would either
 * report a bare `redis://redis:6379` as `unknown-db` or teach the Postgres
 * helper a Redis default.
 *
 * The reason for existing is the same, and it is not hypothetical here: a
 * managed Redis URL is `rediss://default:<password>@host:6379`, the password
 * sits in the userinfo, and `utils/logger.ts` feeds every record into a
 * recent-log ring buffer that the admin `/logs` endpoint is about to serve over
 * HTTP. A connection string that reaches a log line becomes a credential an
 * endpoint hands out.
 */
export const describeRedisTarget = (connectionString: string | undefined): string => {
  if (!connectionString) return 'unconfigured';

  try {
    const url = new URL(connectionString);
    // `new URL` parses `user:secret@host` as scheme `user:` with the rest in the
    // path, which would echo the credentials straight back. A real connection
    // string always yields a hostname — except for the unix-socket forms, which
    // carry no host and no credentials at all.
    if (!url.hostname) {
      return url.protocol.startsWith('redis+unix') || url.protocol.startsWith('redis+tls+unix')
        ? 'unix-socket'
        : 'unparsable-connection-string';
    }

    // Redis numbers its databases and defaults to 0, so an omitted path is a
    // known target rather than an unknown one — and anything that is not a bare
    // number means the parse did not land where it looks like it did.
    //
    // That check is the credential guard, not a validation nicety. A password
    // containing an unescaped `/` derails WHATWG authority parsing: for
    // `rediss://default:12/ab@realhost:6379` the parser stops at the slash, so
    // `hostname` comes back as `default`, `port` as `12`, and `pathname` as
    // `/ab@realhost:6379` — the rest of the password. Formatting those fields
    // would print a credential fragment straight into the log this function
    // exists to keep clean.
    const database = url.pathname.replace(/^\//, '') || '0';
    if (!/^\d+$/.test(database)) return 'unparsable-connection-string';

    const host = url.hostname;
    const port = url.port ? `:${url.port}` : ':6379';
    // Kept because it is the one operationally meaningful difference between two
    // otherwise identical-looking targets: whether the link is encrypted.
    const tls =
      url.protocol.startsWith('rediss') ||
      url.protocol.startsWith('valkeys') ||
      url.protocol.includes('+tls')
        ? ' (tls)'
        : '';
    return `${host}${port}/${database}${tls}`;
  } catch {
    // A malformed value must not be echoed back either — it may still be a
    // credential-bearing string that simply failed to parse.
    return 'unparsable-connection-string';
  }
};
