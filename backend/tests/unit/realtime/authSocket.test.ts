import { describe, it, expect, mock, type Mock } from 'bun:test';
import { signToken } from '../../../src/utils/jwt';
import { attachSocketAuth, type ChatServer } from '../../../src/realtime/authSocket';
import pool from '../../../src/models/db';

const mockSqlFn: any = mock().mockResolvedValue([{}]);
mockSqlFn.unsafe = mock().mockResolvedValue([{}]);

mock.module('../../../src/models/db', () => ({
  default: mockSqlFn,
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
    mockSqlFn.mockResolvedValueOnce([]);
    if (mockSqlFn.unsafe) mockSqlFn.unsafe.mockResolvedValueOnce([]);
    let middleware: any;
    const io = { use: mock((fn) => { middleware = fn; }) } as unknown as ChatServer;
    attachSocketAuth(io);
    const socket = { handshake: { auth: { token: await signToken({ userId: 'ghost', name: 'Ghost' }) } }, data: {} };
    const next = mock();
    await middleware(socket, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  it('accepts connections with a valid token and attaches user data', async () => {
    mockSqlFn.mockResolvedValueOnce([{ user_id: '1', name: 'Test User' }]);
    if (mockSqlFn.unsafe) mockSqlFn.unsafe.mockResolvedValueOnce([{ user_id: '1', name: 'Test User' }]);
    let middleware: any;
    const io = { use: mock((fn) => { middleware = fn; }) } as unknown as ChatServer;
    attachSocketAuth(io);

    const token = await signToken({ userId: '1', name: 'Test User' });
    const socket = { handshake: { auth: { token } }, data: {} as any };
    const next = mock();

    await middleware(socket, next);

    expect(socket.data.user).toBeDefined();
    expect(socket.data.user.userId).toBe('1');
    expect(next).toHaveBeenCalledWith();
  });
});
