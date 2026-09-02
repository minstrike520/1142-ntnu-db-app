/** Formats a Redis connection string safely for logs without leaking credentials. */
export const describeRedisTarget = (connectionString: string | undefined): string => {
  if (!connectionString) return 'unconfigured';

  try {
    const url = new URL(connectionString);
    // Unix socket URLs don't have hostnames or credentials.
    if (!url.hostname) {
      return url.protocol.startsWith('redis+unix') || url.protocol.startsWith('redis+tls+unix')
        ? 'unix-socket'
        : 'unparsable-connection-string';
    }

    // Default to database 0 if omitted; ensure database component is numeric.
    const database = url.pathname.replace(/^\//, '') || '0';
    if (!/^\d+$/.test(database)) return 'unparsable-connection-string';

    const host = url.hostname;
    const port = url.port ? `:${url.port}` : ':6379';
    const tls =
      url.protocol.startsWith('rediss') ||
      url.protocol.startsWith('valkeys') ||
      url.protocol.includes('+tls')
        ? ' (tls)'
        : '';
    return `${host}${port}/${database}${tls}`;
  } catch {
    // Return placeholder rather than echoing malformed credentials.
    return 'unparsable-connection-string';
  }
};
