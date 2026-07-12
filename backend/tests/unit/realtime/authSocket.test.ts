import { describe, it, expect, mock, type Mock } from 'bun:test';
import { signToken } from '../../../src/auth/jwt';
import { attachSocketAuth, type ChatServer } from '../../../src/realtime/authSocket';
import pool from '../../../src/db';

mock.module('../../../src/db', () => ({
  default: { query: mock().mockResolvedValue({ rows: [{}] }) },
}));

describe('attachSocketAuth', () => {
  it('rejects connections without a token', () => {
    let middleware: any;
    const io = { use: mock((fn) => { middleware = fn; }) } as unknown as ChatServer;
    attachSocketAuth(io);

    const next = mock();
    middleware({ handshake: { auth: {} } }, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  it('rejects connections with an empty string token', () => {
    let middleware: any;
    const io = { use: mock((fn) => { middleware = fn; }) } as unknown as ChatServer;
    attachSocketAuth(io);
    const next = mock();
    middleware({ handshake: { auth: { token: '' } } }, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  it('rejects when user is not found in the database', async () => {
    ((pool.query as any) as Mock<any>).mockResolvedValueOnce({ rows: [] } as any);
    let middleware: any;
    const io = { use: mock((fn) => { middleware = fn; }) } as unknown as ChatServer;
    attachSocketAuth(io);
    const socket = { handshake: { auth: { token: signToken({ userId: 'ghost', name: 'Ghost' }) } }, data: {} };
    const next = mock();
    await middleware(socket, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  it('rejects when verifyToken throws due to a malformed token', async () => {
    let middleware: any;
    const io = { use: mock((fn) => { middleware = fn; }) } as unknown as ChatServer;
    attachSocketAuth(io);
    const next = mock();
    await middleware({ handshake: { auth: { token: 'not.a.valid.token' } } }, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  it('verifies tokens with the shared JWT helper and stores socket data user', async () => {
    let middleware: any;
    const io = { use: mock((fn) => { middleware = fn; }) } as unknown as ChatServer;
    const socket = {
      handshake: { auth: { token: signToken({ userId: 'user-1', name: 'Alice' }) } },
      data: {},
    };
    attachSocketAuth(io);

    const next = mock();
    await middleware(socket, next);

    expect(next).toHaveBeenCalledWith();
    expect(socket.data).toMatchObject({
      user: { userId: 'user-1', name: 'Alice' },
    });
  });
});
