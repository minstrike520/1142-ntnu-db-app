import { describe, expect, test } from 'bun:test';
import { WsTicketService } from '../../../src/realtime/wsTicket';

describe('WebSocket tickets', () => {
  test('a short-lived ticket can be consumed once and cannot outlive the access token', async () => {
    let now = new Date('2026-08-03T00:00:00.000Z');
    const tickets = new WsTicketService({
      now: () => now,
      ttlSeconds: 45,
    });

    const issued = await tickets.issue({
      userId: 'user-1',
      name: 'Alice',
      exp: Math.floor(now.getTime() / 1000) + 30,
    });

    expect(issued.expiresAt).toBe('2026-08-03T00:00:30.000Z');
    expect(issued.leaseExpiresAt).toBe('2026-08-03T00:00:30.000Z');
    expect(issued).toMatchObject({ protocol: 'near-chat.v1', version: 1 });

    const claims = await tickets.consume(issued.ticket);
    expect(claims.userId).toBe('user-1');
    expect(claims.aud).toBe('near-chat-ws');
    await expect(tickets.consume(issued.ticket)).rejects.toThrow('WS_TICKET_REPLAYED');

    now = new Date('2026-08-03T00:01:00.000Z');
    const expired = await tickets.issue({
      userId: 'user-1',
      name: 'Alice',
      exp: Math.floor(now.getTime() / 1000) + 1,
    });
    now = new Date('2026-08-03T00:01:02.000Z');
    await expect(tickets.consume(expired.ticket)).rejects.toThrow('WS_TICKET_EXPIRED');
  });

  test('allows an ACK-lost auth renewal to replay only in the same command context', async () => {
    const now = new Date('2026-08-03T00:00:00.000Z');
    const tickets = new WsTicketService({ now: () => now, secret: 'test-secret' });
    const issued = await tickets.issue({
      userId: 'user-1',
      name: 'Alice',
      exp: Math.floor(now.getTime() / 1000) + 60,
    });

    await expect(tickets.consume(issued.ticket, 'user-1:renew-1')).resolves.toMatchObject({
      userId: 'user-1',
    });
    await expect(tickets.consume(issued.ticket, 'user-1:renew-1')).resolves.toMatchObject({
      userId: 'user-1',
    });
    await expect(tickets.consume(issued.ticket, 'user-1:renew-2'))
      .rejects.toThrow('WS_TICKET_REPLAYED');
  });
});
