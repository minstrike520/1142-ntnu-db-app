import type { makeUserService } from '../services/userService';
import type { IUserRepository } from '../repositories/IUserRepository';
import { isUserOnline } from '../realtime/presence';

export function startInactivityJob(
  userRepo: IUserRepository,
  userService: ReturnType<typeof makeUserService>,
  intervalMs = 60 * 60 * 1000 // default 1 hour
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
          if (isUserOnline(user.userId)) {
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



