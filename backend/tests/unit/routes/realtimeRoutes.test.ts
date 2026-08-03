import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import { makeRealtimeRoutes } from '../../../src/routes/realtimeRoutes';
import { errorHandler } from '../../../src/middlewares/errorHandler';
import { signToken } from '../../../src/utils/jwt';

const CALLER_ID = '11111111-1111-4111-8111-111111111111';
const NOTIFICATION_ID = 'e4c08495-e224-4a67-b6dd-5958952d3d42';
const mockSqlFn: any = mock().mockResolvedValue([{
  user_id: CALLER_ID,
  name: 'Caller',
  email: 'caller@test.com',
  password_hash: 'hash',
  lang_preference: 'zh-TW',
  app_theme: 'light',
  notify_desktop: true,
  notify_sound: true,
  warning_enabled: false,
  warning_days: 0,
  last_activity: new Date(),
  created_at: new Date(),
}]);

mock.module('../../../src/models/db', () => ({ default: mockSqlFn }));

describe('realtime notification routes', () => {
  let service: {
    listEmergencyNotifications: ReturnType<typeof mock>;
    acknowledgeEmergencyNotification: ReturnType<typeof mock>;
  };
  let token: string;

  const makeApp = () => {
    const app = new Hono();
    app.onError(errorHandler);
    app.route('/realtime', makeRealtimeRoutes({ issue: mock() } as any, service as any));
    return app;
  };

  beforeEach(async () => {
    token = await signToken({ userId: CALLER_ID, email: 'caller@test.com' } as any);
    service = {
      listEmergencyNotifications: mock().mockResolvedValue([]),
      acknowledgeEmergencyNotification: mock().mockResolvedValue(undefined),
    };
  });

  afterAll(() => {
    mock.restore();
  });

  it('acknowledges only a valid notification UUID for the authenticated user', async () => {
    const res = await makeApp().request(`/realtime/emergency-notifications/${NOTIFICATION_ID}/acknowledge`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(204);
    expect(service.acknowledgeEmergencyNotification).toHaveBeenCalledWith(CALLER_ID, NOTIFICATION_ID);
  });

  it('rejects malformed notification IDs before they reach the repository', async () => {
    const res = await makeApp().request('/realtime/emergency-notifications/not-a-uuid/acknowledge', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(400);
    expect(service.acknowledgeEmergencyNotification).not.toHaveBeenCalled();
  });
});
