/**
 * Render a connection string as a non-sensitive, log-safe target description.
 *
 * Connection strings normally carry credentials (`postgresql://user:pass@host/db`),
 * so the raw value must never reach container or CI logs. Only the host, port and
 * database name survive.
 */
export const describeDatabaseTarget = (connectionString: string | undefined): string => {
  if (!connectionString) return 'unconfigured';

  try {
    const url = new URL(connectionString);
    // `new URL` happily parses `user:secret@host` as scheme `user:` with the rest
    // in the path, which would echo the credentials straight back. A real
    // connection string always yields a hostname.
    if (!url.hostname) return 'unparsable-connection-string';

    const host = url.hostname;
    const port = url.port ? `:${url.port}` : '';
    const database = decodeURIComponent(url.pathname.replace(/^\//, '')) || 'unknown-db';
    return `${host}${port}/${database}`;
  } catch {
    // A malformed value must not be echoed back either — it may still be a
    // credential-bearing string that simply failed to parse.
    return 'unparsable-connection-string';
  }
};
