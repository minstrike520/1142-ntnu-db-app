import { describe, it, expect } from 'bun:test';
import { describeDatabaseTarget } from '../../../src/utils/describeDatabaseTarget';

describe('describeDatabaseTarget', () => {
  it('reports host, port and database name', () => {
    expect(describeDatabaseTarget('postgresql://user:secret@db.internal:5432/chatdb'))
      .toBe('db.internal:5432/chatdb');
  });

  it('never leaks the username or password', () => {
    const result = describeDatabaseTarget('postgresql://chatuser:sup3r-s3cret@localhost:5432/chatdb');

    expect(result).not.toInclude('chatuser');
    expect(result).not.toInclude('sup3r-s3cret');
    expect(result).not.toInclude('@');
  });

  it('omits the port when the URL does not specify one', () => {
    expect(describeDatabaseTarget('postgresql://user:pw@db/chatdb')).toBe('db/chatdb');
  });

  it('handles a URL with no database path', () => {
    expect(describeDatabaseTarget('postgresql://user:pw@db:5432')).toBe('db:5432/unknown-db');
  });

  it('reports unconfigured for a missing value', () => {
    expect(describeDatabaseTarget(undefined)).toBe('unconfigured');
    expect(describeDatabaseTarget('')).toBe('unconfigured');
  });

  it('does not echo back an unparsable value', () => {
    const result = describeDatabaseTarget('user:secret@not-a-url');

    expect(result).toBe('unparsable-connection-string');
    expect(result).not.toInclude('secret');
  });
});
