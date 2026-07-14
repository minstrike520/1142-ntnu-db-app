import { describe, it, expect, mock, spyOn, beforeEach, afterEach, type Mock } from 'bun:test';
import { startInactivityJob } from '../../../src/cron/inactivityJob';
import type { IUserRepository } from '../../../src/repositories/IUserRepository';
import { waitFor } from '../../helpers/waitFor';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('inactivityJob', () => {
  let mockUserRepo: any;
  let mockUserService: any;

  beforeEach(() => {
    mockUserRepo = {
      findById: mock(),
      findByEmail: mock(),
      search: mock(),
      create: mock(),
      update: mock(),
      delete: mock(),
      findAllWarningEnabled: mock(),
    };
    mockUserService = {
      checkInactivity: mock(),
    };
  });

  afterEach(() => {
    mock.restore();
  });

  it('should call checkInactivity for each user and prevent overlapping runs', async () => {
    const mockUsers = [
      { userId: 'u1' },
      { userId: 'u2' }
    ];
    (mockUserRepo.findAllWarningEnabled as Mock).mockResolvedValue(mockUsers as any);
    
    // Simulate a slow checkInactivity to test lock
    let checkPromiseResolve: () => void;
    (mockUserService.checkInactivity as Mock).mockImplementation(() => {
      return new Promise<void>((resolve) => {
        checkPromiseResolve = resolve;
      });
    });

    const intervalId = startInactivityJob(mockUserRepo as unknown as IUserRepository, mockUserService, 1);
    
    await waitFor(() => {
      expect(mockUserRepo.findAllWarningEnabled).toHaveBeenCalledTimes(1);
    });
    
    // Fast forward to second execution before the first one finishes
    await sleep(2);
    
    // It should not call findAllWarningEnabled again because the lock is held
    expect(mockUserRepo.findAllWarningEnabled).toHaveBeenCalledTimes(1);

    clearInterval(intervalId);
    if (checkPromiseResolve!) {
      checkPromiseResolve();
    }
  });

  it('continues with remaining users when checkInactivity fails for one user', async () => {
    const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});
    (mockUserRepo.findAllWarningEnabled as Mock).mockResolvedValue([
      { userId: 'u1' },
      { userId: 'u2' }
    ] as any);
    (mockUserService.checkInactivity as Mock)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);

    const intervalId = startInactivityJob(mockUserRepo as unknown as IUserRepository, mockUserService, 1);
    
    await waitFor(() => {
      expect(mockUserService.checkInactivity.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    // Continuation must happen WITHIN the first run: u2 is processed right after u1 fails.
    // Guards against a regression that breaks the loop on error and only reaches u2 on a later tick.
    expect(mockUserService.checkInactivity.mock.calls[0][0]).toBe('u1');
    expect(mockUserService.checkInactivity.mock.calls[1][0]).toBe('u2');

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Error checking inactivity for user u1'),
      expect.any(Error)
    );

    clearInterval(intervalId);
    consoleSpy.mockRestore();
  });

  it('logs and releases the lock when findAllWarningEnabled fails', async () => {
    const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});
    (mockUserRepo.findAllWarningEnabled as Mock)
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValue([] as any);

    const intervalId = startInactivityJob(mockUserRepo as unknown as IUserRepository, mockUserService, 1);

    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith('Error running inactivity job:', expect.any(Error));
    });

    // The lock must be released so the next tick runs again
    await waitFor(() => {
      expect(mockUserRepo.findAllWarningEnabled.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    clearInterval(intervalId);
    consoleSpy.mockRestore();
  });
});
