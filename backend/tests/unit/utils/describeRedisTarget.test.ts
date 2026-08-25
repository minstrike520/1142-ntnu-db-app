import { describe, it, expect } from 'bun:test';
import { describeRedisTarget } from '../../../src/utils/describeRedisTarget';

describe('describeRedisTarget', () => {
  it('reduces a URL to host, port and database index', () => {
    expect(describeRedisTarget('redis://redis:6379/0')).toBe('redis:6379/0');
  });

  it('fills in Redis’s defaults when the URL omits them', () => {
    expect(describeRedisTarget('redis://redis')).toBe('redis:6379/0');
  });

  it('never echoes credentials', () => {
    const result = describeRedisTarget('rediss://default:sup3r-s3cret@cache.example:6380/2');

    expect(result).not.toInclude('sup3r-s3cret');
    expect(result).not.toInclude('default');
    expect(result).toBe('cache.example:6380/2 (tls)');
  });

  it('marks an encrypted link, which is the one difference worth logging', () => {
    expect(describeRedisTarget('rediss://cache.example:6379')).toInclude('(tls)');
    expect(describeRedisTarget('redis+tls://cache.example:6379')).toInclude('(tls)');
    expect(describeRedisTarget('redis://cache.example:6379')).not.toInclude('(tls)');
  });

  it('names the unix-socket forms without echoing the path', () => {
    expect(describeRedisTarget('redis+unix:///var/run/redis.sock')).toBe('unix-socket');
  });

  it('reports an unset value as unconfigured', () => {
    expect(describeRedisTarget(undefined)).toBe('unconfigured');
    expect(describeRedisTarget('')).toBe('unconfigured');
  });

  it('refuses to echo a malformed value, which may still hold a credential', () => {
    const result = describeRedisTarget('default:sup3r-s3cret@not-a-url');

    expect(result).toBe('unparsable-connection-string');
    expect(result).not.toInclude('sup3r-s3cret');
  });
});
