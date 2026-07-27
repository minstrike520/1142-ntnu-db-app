import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { Hono } from 'hono';
import { makeUserRoutes } from '../../../src/routes/userRoutes';
import { errorHandler } from '../../../src/middlewares/errorHandler';
import { signToken } from '../../../src/utils/jwt';

const mockSqlFn: any = mock().mockResolvedValue([{ user_id: 'caller-id' }]);
mockSqlFn.unsafe = mock().mockResolvedValue([{}]);
mock.module('../../../src/models/db', () => ({ default: mockSqlFn }));

const CALLER_ID = '11111111-1111-4111-8111-111111111111';
const CONTACT_ID = 'e4c08495-e224-4a67-b6dd-5958952d3d42';

describe('emergency contact routes', () => {
  let service: any;
  let token: string;

  const makeApp = () => {
    const app = new Hono();
    app.onError(errorHandler);
    app.route('/users', makeUserRoutes(service));
    return app;
  };

  beforeEach(async () => {
    token = await signToken({ userId: CALLER_ID, email: 'caller@test.com' } as any);
    service = {
      deleteEmergencyContact: mock().mockResolvedValue(undefined),
      checkInactivity: mock().mockResolvedValue({ alerted: false, recipients: [], reason: 'BELOW_THRESHOLD' }),
    };
  });

  afterAll(() => {
    mock.restore();
  });

  describe('DELETE /users/me/emergency-contacts/:contactId', () => {
    it('answers with the documented { success: true } shape', async () => {
      const res = await makeApp().request(`/users/me/emergency-contacts/${CONTACT_ID}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      // The frontend types this as Promise<{ success: boolean }>; a { message }
      // body left callers reading `success` with undefined.
      expect(await res.json()).toEqual({ success: true });
      expect(service.deleteEmergencyContact).toHaveBeenCalledWith(CALLER_ID, CONTACT_ID);
    });
  });

  describe('POST /users/me/emergency-alert/check-inactivity', () => {
    const post = (body: unknown) =>
      makeApp().request('/users/me/emergency-alert/check-inactivity', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    it('accepts an ISO 8601 now', async () => {
      const res = await post({ now: new Date().toISOString() });

      expect(res.status).toBe(200);
      expect(service.checkInactivity).toHaveBeenCalled();
    });

    it('accepts an omitted now', async () => {
      expect((await post({})).status).toBe(200);
    });

    it('rejects a non-ISO now before it can become an Invalid Date', async () => {
      const res = await post({ now: 'invalid' });

      expect(res.status).toBe(400);
      // Reaching the service would make inactiveMs NaN and could fire a real alert.
      expect(service.checkInactivity).not.toHaveBeenCalled();
    });
  });
});
