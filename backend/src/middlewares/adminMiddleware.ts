import type { MiddlewareHandler } from 'hono';
import { AppError, ForbiddenError } from '../utils/AppError';
import pool from '../models/db';
import { UserRepository } from '../models/userRepository';

/**
 * The single question this middleware asks the database.
 *
 * Injected rather than imported so tests can pass a stub: `mock.module()` is
 * process-global within a tier and cannot be undone, which is what made
 * `avatarUpload.test.ts` order-dependent (issue #467). Same
 * implementation/default-parameter split as `AvatarStore` / `defaultAvatarStore`.
 */
export interface AdminChecker {
  isAdmin(userId: string): Promise<boolean>;
}

const defaultAdminChecker = (): AdminChecker => new UserRepository(pool);

/**
 * Gate for `/api/v1/admin/*`, the authorization base for the admin monitoring
 * backend (#280).
 *
 * Authority is `users.is_admin`, read fresh from the database on every request.
 * The JWT is deliberately not involved: `JwtPayload` carries only `{ userId,
 * name }`, and putting the flag in the token would mean a revoked admin keeps
 * their access until the token expires.
 *
 * There is intentionally no `SYSTEM_ADMIN_EMAILS` env allow-list, which #565
 * originally proposed. `PATCH /api/v1/users/me` lets any authenticated user
 * change their own email with only a uniqueness check — no current-password
 * confirmation, unlike a password change — and `users.email` is a plain
 * case-sensitive UNIQUE column, so `Ops@company.com` inserts happily next to
 * `ops@company.com`. An email allow-list would therefore be self-service
 * privilege escalation. Bootstrapping is a DB operation instead; see
 * docs/DEVELOPMENT.md.
 */
export const makeAdminMiddleware = (
  checker: AdminChecker = defaultAdminChecker(),
): MiddlewareHandler => async (c, next) => {
  // Defence in depth against a mis-mount. `ContextVariableMap.user` is declared
  // non-optional, so TypeScript believes this is always set; if `authMiddleware`
  // did not actually run, the unchecked read would surface as a 500 rather than
  // the 401 the caller deserves.
  const authUser = c.get('user');
  if (!authUser?.userId) {
    throw new AppError(401, 'Unauthorized: Missing authentication token');
  }

  if (!(await checker.isAdmin(authUser.userId))) {
    // The denial itself is a signal #280's monitoring backend will want. userId
    // and path only — never the email or the token.
    console.warn(`ADMIN DENIED: userId=${authUser.userId} path=${c.req.path}`);
    throw new ForbiddenError();
  }

  await next();
};
