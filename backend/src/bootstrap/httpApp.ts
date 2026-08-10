import { Hono } from 'hono';
import { cors } from 'hono/cors';
import path from 'path';
import type { AppConfig } from './config';
import type { Services } from './services';
import { errorHandler } from '../middlewares/errorHandler';
import { authMiddleware } from '../middlewares/authMiddleware';
import { makeAuthRateLimiter, makeGlobalRateLimiter, securityHeaders } from '../middlewares/securityMiddleware';
import { makeAuthRoutes } from '../routes/authRoutes';
import { makeUserRoutes } from '../routes/userRoutes';
import { makeRoomRoutes } from '../routes/roomRoutes';
import { makeMessageRoutes } from '../routes/messageRoutes';
import { makeFolderRoutes } from '../routes/folderRoutes';
import { makeAttachmentRoutes } from '../routes/attachmentRoutes';
import { makeFriendRoutes, makeBlockRoutes, makeFriendRequestRoutes } from '../routes/friendRoutes';
import { AVATARS_UPLOAD_DIR, ensureUploadDirectories } from '../utils/uploads';
import { avatarContentType } from '../utils/avatarUpload';

export interface CreateHttpAppDeps {
  services: Services;
  config: AppConfig;
}

/**
 * The Hono application: middleware, static uploads and every API route.
 *
 * Middleware order is load-bearing and preserved as it was — security headers
 * and CORS wrap everything, the global limiter covers `/api/*`, and the auth
 * limiter is mounted on `/api/v1/auth/*` ahead of the auth routes themselves.
 */
export const createHttpApp = ({ services, config }: CreateHttpAppDeps): Hono => {
  const honoApp = new Hono();

  honoApp.use('*', securityHeaders);
  honoApp.use(
    '*',
    cors({
      origin: (origin) => (config.corsOrigins.includes(origin) ? origin : null),
      credentials: true,
    }),
  );

  honoApp.use('/api/*', makeGlobalRateLimiter());

  // Fired and not awaited, as before: the directories are only needed by the
  // time an upload or a read of one arrives, not to serve the first request.
  void ensureUploadDirectories();

  honoApp.get('/uploads/avatars/*', async (c) => {
    const reqPath = c.req.path.replace('/uploads/avatars/', '');
    const fileName = path.basename(reqPath);
    const filePath = path.join(AVATARS_UPLOAD_DIR, fileName);
    const file = Bun.file(filePath);
    if (await file.exists()) {
      return new Response(file, {
        status: 200,
        headers: {
          'Content-Type': avatarContentType(fileName),
          'Cache-Control': 'public, max-age=604800, immutable',
          'Cross-Origin-Resource-Policy': 'cross-origin',
        },
      });
    }
    return c.notFound();
  });

  honoApp.use('/api/v1/auth/*', makeAuthRateLimiter());
  honoApp.route('/api/v1/auth', makeAuthRoutes(services.user));
  honoApp.route('/api/v1/users', makeUserRoutes(services.user));

  // Room and message routes share one auth-guarded sub-app so `authMiddleware`
  // is applied once for both.
  const roomApi = new Hono();
  roomApi.use('*', authMiddleware);
  roomApi.route('/', makeRoomRoutes(services.room));
  roomApi.route('/', makeMessageRoutes(services.message));
  honoApp.route('/api/v1/rooms', roomApi);

  honoApp.route('/api/v1/folders', makeFolderRoutes(services.folder));
  honoApp.route('/api/v1/attachments', makeAttachmentRoutes(services.attachment));
  honoApp.route('/api/v1/friends', makeFriendRoutes(services.friend));
  honoApp.route('/api/v1/friend-requests', makeFriendRequestRoutes(services.friend));
  honoApp.route('/api/v1/blocks', makeBlockRoutes(services.friend));

  honoApp.onError(errorHandler);

  return honoApp;
};
