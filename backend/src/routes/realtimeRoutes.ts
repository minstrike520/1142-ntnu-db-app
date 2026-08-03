import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middlewares/authMiddleware';
import { AppError } from '../utils/AppError';
import type { WsTicketService } from '../realtime/wsTicket';
import type { RealtimeService } from '../services/realtimeService';

export const makeRealtimeRoutes = (
  tickets: WsTicketService,
  service: Pick<RealtimeService, 'listEmergencyNotifications' | 'acknowledgeEmergencyNotification'>,
) => {
  const app = new Hono();
  const uuidSchema = z.uuid();
  app.use('*', authMiddleware);

  app.post('/ticket', async (c) => {
    const identity = c.get('user');
    if (!identity.exp) throw new AppError(401, 'Access token has no expiry', 'AUTH_EXPIRED');
    const issued = await tickets.issue({
      userId: identity.userId,
      name: identity.name,
      exp: identity.exp,
    });
    return c.json(issued, 201);
  });

  app.get('/emergency-notifications', async (c) => {
    const notifications = await service.listEmergencyNotifications(c.get('user').userId);
    return c.json(notifications, 200);
  });

  app.post('/emergency-notifications/:notificationId/acknowledge', async (c) => {
    const notificationId = c.req.param('notificationId');
    if (!uuidSchema.safeParse(notificationId).success) {
      throw new AppError(400, 'Invalid notification ID', 'INVALID_PAYLOAD');
    }
    await service.acknowledgeEmergencyNotification(
      c.get('user').userId,
      notificationId,
    );
    return c.body(null, 204);
  });

  return app;
};
