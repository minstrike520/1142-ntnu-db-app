import { Hono } from 'hono';
import { authMiddleware } from '../middlewares/authMiddleware';
import { type AdminChecker, makeAdminMiddleware } from '../middlewares/adminMiddleware';

/**
 * The `/api/v1/admin` namespace, and the only supported way to mount the admin
 * gate.
 *
 * Both middlewares are bound here rather than exported for the composition root
 * to sequence, so a future admin route cannot be added behind a half-applied
 * guard: `httpApp` only ever writes `honoApp.route('/api/v1/admin', ...)`, the
 * same sub-app shape already used for rooms and sync.
 *
 * Handlers land under #280's follow-ups (#566-#570). `GET /health` exists so the
 * guard is reachable end to end today — Hono runs matched middleware before it
 * falls through to the not-found handler, so an empty sub-app would still
 * enforce 401/403, but nothing would prove the allowed path returns 200.
 */
export const makeAdminRoutes = (checker?: AdminChecker) => {
  const app = new Hono();

  app.use('*', authMiddleware);
  app.use('*', makeAdminMiddleware(checker));

  app.get('/health', (c) => c.json({ status: 'ok' }, 200));

  return app;
};
