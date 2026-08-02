import type { makeUserService } from '../services/userService';
import type { IUserRepository } from '../models/IUserRepository';

export function startInactivityJob(
  userRepo: IUserRepository,
  userService: ReturnType<typeof makeUserService>,
  intervalMs = 60 * 60 * 1000, // default 1 hour
  isOnline: (userId: string) => boolean = () => false,
) {
  let isRunning = false;
  return setInterval(async () => {
    if (isRunning) return;
    isRunning = true;
    try {
      const users = await userRepo.findAllWarningEnabled();
      const now = new Date();
      for (const user of users) {
        try {
          if (isOnline(user.userId)) {
            await userRepo.update(user.userId, { lastActivity: now });
            continue;
          }
          await userService.checkInactivity(user.userId, now);
        } catch (err) {
          console.error(`Error checking inactivity for user ${user.userId}:`, err);
        }
      }
    } catch (err) {
      console.error('Error running inactivity job:', err);
    } finally {
      isRunning = false;
    }
  }, intervalMs);
}


