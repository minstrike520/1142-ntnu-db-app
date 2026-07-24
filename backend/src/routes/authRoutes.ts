import { Hono } from 'hono';
import { registerSchema, loginSchema } from '../validators/userSchemas';
import { validate } from '../middlewares/validator';
import { setRefreshCookie, clearRefreshCookie, REFRESH_COOKIE_NAME, readCookie } from '../auth/cookies';
import { ValidationError } from '../errors/AppError';

export interface AuthService {
  register(data: { email: string; name: string; password: string }): Promise<any>;
  login(data: { email: string; password: string }): Promise<any>;
  refresh(refreshToken: string): Promise<any>;
  revokeToken(refreshToken: string): Promise<void>;
}

export const makeAuthRoutes = (service: AuthService) => {
  const app = new Hono();

  app.post('/register', validate('json', registerSchema), async (c) => {
    const data = c.req.valid('json') as any;
    const result = await service.register(data);
    setRefreshCookie(c, result.refreshToken);
    return c.json({
      token: result.token,
      user: result.user,
    }, 201);
  });

  app.post('/login', validate('json', loginSchema), async (c) => {
    const data = c.req.valid('json') as any;
    const result = await service.login(data);
    setRefreshCookie(c, result.refreshToken);
    return c.json({
      token: result.token,
      user: result.user,
    }, 200);
  });

  app.post('/logout', async (c) => {
    const refreshToken = readCookie(c.req.header('cookie'), REFRESH_COOKIE_NAME);
    if (refreshToken) {
      await service.revokeToken(refreshToken);
    }
    clearRefreshCookie(c);
    return c.body(null, 204);
  });

  app.post('/refresh', async (c) => {
    const refreshToken = readCookie(c.req.header('cookie'), REFRESH_COOKIE_NAME);
    if (!refreshToken) {
      throw new ValidationError('Missing refresh token');
    }
    try {
      const result = await service.refresh(refreshToken);
      setRefreshCookie(c, result.refreshToken);
      return c.json({
        token: result.token,
        user: result.user,
      }, 200);
    } catch (err) {
      if (err instanceof ValidationError) {
        clearRefreshCookie(c);
      }
      throw err;
    }
  });

  return app;
};
