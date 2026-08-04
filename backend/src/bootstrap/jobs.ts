import type { Repositories } from './repositories';
import type { Services } from './services';
import { startInactivityJob } from '../utils/inactivityJob';

export interface StartJobsDeps {
  repositories: Repositories;
  services: Services;
}

/**
 * Background timers.
 *
 * Started only when this process is the entrypoint — importing the app (as the
 * E2E suite does) must not leave a live interval behind holding the runner open.
 */
export const startJobs = ({ repositories, services }: StartJobsDeps): void => {
  startInactivityJob(repositories.users, services.user);
};
