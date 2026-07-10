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
}
