import type { User } from '@shared/types';

export interface IUserRepository {
  findById(userId: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  search(query: string, mode?: 'name' | 'userId' | 'email'): Promise<User[]>;
  create(data: { name: string; email: string; passwordHash: string }): Promise<User>;
  update(
    userId: string,
    data: Partial<
      Pick<User, 'name' | 'bio' | 'avatarUrl' | 'language' | 'warningEnabled' | 'warningDays' | 'lastActivity' | 'deletedAt' | 'roomOrder'>
      & Pick<User, 'email' | 'passwordHash' | 'theme' | 'notifyDesktop' | 'notifySound'>
    >,
  ): Promise<User>;
  delete(userId: string): Promise<void>;
  findAllWarningEnabled(): Promise<{ userId: string; lastActivity: Date; warningDays: number }[]>;
  /**
   * Admin flag only. Deliberately not `findById`, which is `SELECT *` and would
   * pull `password_hash` and the `room_order` JSONB into a middleware that only
   * needs one boolean. A missing or soft-deleted user is `false`, never a throw:
   * the gate has to fail closed.
   *
   * There is no matching setter — `is_admin` is absent from `update`'s allow-list
   * above, so the flag cannot be changed over HTTP. Promoting an admin is a
   * deliberate DB operation; see docs/DEVELOPMENT.md.
   */
  isAdmin(userId: string): Promise<boolean>;
}
