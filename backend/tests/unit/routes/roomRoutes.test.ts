import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { Hono } from 'hono';
import { makeRoomRoutes } from '../../../src/routes/roomRoutes';
import { authMiddleware } from '../../../src/middlewares/authMiddleware';
import { errorHandler } from '../../../src/middlewares/errorHandler';
import { signToken } from '../../../src/utils/jwt';

// authMiddleware looks the caller up through the shared SQL client; a non-empty
// row is all it needs to accept the signed token.
const mockSqlFn: any = mock().mockResolvedValue([{ user_id: 'caller-id' }]);
mockSqlFn.unsafe = mock().mockResolvedValue([{}]);
mock.module('../../../src/models/db', () => ({ default: mockSqlFn }));

const CALLER_ID = '11111111-1111-4111-8111-111111111111';
const NEW_OWNER_ID = 'e4c08495-e224-4a67-b6dd-5958952d3d42';
const ROOM_ID = '22222222-2222-4222-8222-222222222222';

describe('PATCH /rooms/:id', () => {
  let service: any;
  let token: string;

  const makeApp = () => {
    const app = new Hono();
    app.onError(errorHandler);
    app.use('/rooms/*', authMiddleware);
    app.route('/rooms', makeRoomRoutes(service));
    return app;
  };

  const patchRoom = (body: unknown) =>
    makeApp().request(`/rooms/${ROOM_ID}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    token = await signToken({ userId: CALLER_ID, email: 'caller@test.com' } as any);
    service = {
      transferOwnership: mock().mockResolvedValue(undefined),
      update: mock().mockResolvedValue({ roomId: ROOM_ID, name: 'Updated' }),
    };
  });

  afterAll(() => {
    mock.restore();
  });

  it('transfers ownership when ownerId is supplied', async () => {
    const res = await patchRoom({ ownerId: NEW_OWNER_ID });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: 'Ownership transferred' });
    expect(service.transferOwnership).toHaveBeenCalledWith(ROOM_ID, CALLER_ID, NEW_OWNER_ID);
    expect(service.update).not.toHaveBeenCalled();
  });

  it('accepts the snake_case owner_id alias', async () => {
    const res = await patchRoom({ owner_id: NEW_OWNER_ID });

    expect(res.status).toBe(200);
    expect(service.transferOwnership).toHaveBeenCalledWith(ROOM_ID, CALLER_ID, NEW_OWNER_ID);
  });

  it('rejects a malformed ownerId instead of silently dropping it', async () => {
    const res = await patchRoom({ ownerId: 'not-a-uuid' });

    expect(res.status).toBe(400);
    expect(service.transferOwnership).not.toHaveBeenCalled();
    expect(service.update).not.toHaveBeenCalled();
  });

  it('updates settings and returns the room when no ownerId is supplied', async () => {
    const res = await patchRoom({ name: 'Updated' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ roomId: ROOM_ID, name: 'Updated' });
    expect(service.update).toHaveBeenCalledWith(ROOM_ID, CALLER_ID, { name: 'Updated' });
    expect(service.transferOwnership).not.toHaveBeenCalled();
  });

  it('rejects ownerId combined with settings instead of dropping them', async () => {
    const res = await patchRoom({ ownerId: NEW_OWNER_ID, name: 'Updated' });

    // The transfer branch returns immediately, so accepting this would answer 200
    // while silently discarding `name`.
    expect(res.status).toBe(400);
    expect(service.transferOwnership).not.toHaveBeenCalled();
    expect(service.update).not.toHaveBeenCalled();
  });

  it('still rejects an empty body', async () => {
    const res = await patchRoom({});

    expect(res.status).toBe(400);
    expect(service.update).not.toHaveBeenCalled();
    expect(service.transferOwnership).not.toHaveBeenCalled();
  });
});

describe('PATCH /rooms/:id/members/:targetUserId', () => {
  let service: any;
  let token: string;

  const makeApp = () => {
    const app = new Hono();
    app.onError(errorHandler);
    app.use('/rooms/*', authMiddleware);
    app.route('/rooms', makeRoomRoutes(service));
    return app;
  };

  const patchMember = (body: unknown) =>
    makeApp().request(`/rooms/${ROOM_ID}/members/${NEW_OWNER_ID}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    token = await signToken({ userId: CALLER_ID, email: 'caller@test.com' } as any);
    service = {
      approveMember: mock().mockResolvedValue(undefined),
      updateMember: mock().mockResolvedValue(undefined),
      transferOwnership: mock().mockResolvedValue(undefined),
    };
  });

  it('returns the documented message when approving', async () => {
    const res = await patchMember({ status: 'approved' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: 'Member approved' });
    expect(service.approveMember).toHaveBeenCalledWith(ROOM_ID, CALLER_ID, NEW_OWNER_ID);
  });

  it('returns the documented message when updating', async () => {
    const res = await patchMember({ role: 'admin' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: 'Member updated' });
  });

  it('forwards isMuted through to the service', async () => {
    const res = await patchMember({ isMuted: true });

    expect(res.status).toBe(200);
    // The old schema declared `muted`, so this arrived as an empty object and the
    // mute change was silently dropped.
    expect(service.updateMember).toHaveBeenCalledWith(ROOM_ID, CALLER_ID, NEW_OWNER_ID, { isMuted: true });
  });

  it('does not treat ownerId here as an ownership transfer', async () => {
    const res = await patchMember({ ownerId: NEW_OWNER_ID, role: 'admin' });

    expect(res.status).toBe(200);
    expect(service.transferOwnership).not.toHaveBeenCalled();
    expect(service.updateMember).toHaveBeenCalledWith(ROOM_ID, CALLER_ID, NEW_OWNER_ID, { role: 'admin' });
  });
});
