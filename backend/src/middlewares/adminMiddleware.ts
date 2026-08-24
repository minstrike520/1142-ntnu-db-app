import type { MiddlewareHandler } from 'hono';
import { AppError, ForbiddenError } from '../utils/AppError';
import { logger } from '../utils/logger';

/**
 * The service-layer authorization check this gate consumes.
 *
 * Structurally satisfied by `userService`, which is what the composition root
 * injects. Declared as a one-method interface rather than importing the service
 * type so the middleware depends on the capability it needs, and so a unit test
 * can pass a plain object — `mock.module()` is process-global within a tier and
 * cannot be undone, which is what made `avatarUpload.test.ts` order-dependent
 * (issue #467).
 */
export interface AdminChecker {
  isAdmin(userId: string): Promise<boolean>;
}

/**
 * Gate for `/api/v1/admin/*`, the authorization base for the admin monitoring
 * backend (#280).
 *
 * A pure HTTP adapter: it resolves the caller, asks the service layer one
 * question, and maps the answer onto a status code. It holds no repository and
 * opens no database handle of its own — the decision, and the freshness
 * guarantee behind it, belong to `userService.isAdmin`.
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
export const makeAdminMiddleware = (checker: AdminChecker): MiddlewareHandler => async (c, next) => {
  // Defence in depth against a mis-mount. `ContextVariableMap.user` is declared
  // non-optional, so TypeScript believes this is always set; if `authMiddleware`
  // did not actually run, the unchecked read would surface as a 500 rather than
  // the 401 the caller deserves.
  const authUser = c.get('user');
  if (!authUser?.userId) {
    throw new AppError(401, 'Unauthorized: Missing authentication token');
  }

  if (!(await checker.isAdmin(authUser.userId))) {
    // The denial itself is a signal #280's monitoring backend will want, and it
    // reaches the recent-log buffer #566 added. userId and path only — never the
    // email or the token.
    logger.warn({ userId: authUser.userId, path: c.req.path }, 'admin access denied');
    throw new ForbiddenError();
  }

  await next();
};
