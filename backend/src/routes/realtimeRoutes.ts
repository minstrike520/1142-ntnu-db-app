import { Hono } from 'hono';
import { authMiddleware } from '../middlewares/authMiddleware';
import { AppError } from '../utils/AppError';
import type { WsTicketService } from '../realtime/wsTicket';
import type { RealtimeService } from '../services/realtimeService';

export const makeRealtimeRoutes = (
  tickets: WsTicketService,
  service: Pick<RealtimeService, 'listEmergencyNotifications'>,
) => {
  const app = new Hono();
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

  return app;
};
