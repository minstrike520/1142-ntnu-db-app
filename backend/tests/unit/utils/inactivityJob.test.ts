import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { startInactivityJob } from '../../../src/utils/inactivityJob';
import type { IUserRepository } from '../../../src/models/IUserRepository';

describe('inactivityJob', () => {
  let mockUserRepo: any;
  let mockUserService: any;
  let activeIntervals: any[] = [];

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
    for (const id of activeIntervals) {
      clearInterval(id);
    }
    activeIntervals = [];
  });

  it('should call checkInactivity for each user and prevent overlapping runs', async () => {
    const mockUsers = [
      { userId: 'u1' },
      { userId: 'u2' }
    ];
    mockUserRepo.findAllWarningEnabled.mockResolvedValue(mockUsers as any);
    
    let releaseFirstCheck!: () => void;
    mockUserService.checkInactivity
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseFirstCheck = resolve;
          })
      )
      .mockResolvedValue(undefined);

    const intervalId = startInactivityJob(mockUserRepo, mockUserService, 2);
    activeIntervals.push(intervalId);
    
    // Wait to trigger first execution
    await new Promise(resolve => setTimeout(resolve, 3));
    await Promise.resolve();
    
    expect(mockUserRepo.findAllWarningEnabled).toHaveBeenCalledTimes(1);
    
    // Wait to trigger second execution before the first one finishes
    await new Promise(resolve => setTimeout(resolve, 3));
    await Promise.resolve();
    
    // It should not call findAllWarningEnabled again because the lock is held
    expect(mockUserRepo.findAllWarningEnabled).toHaveBeenCalledTimes(1);

    clearInterval(intervalId);
    activeIntervals = activeIntervals.filter((id) => id !== intervalId);
    releaseFirstCheck();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockUserService.checkInactivity).toHaveBeenCalledTimes(2);
  });

  it('continues with remaining users when checkInactivity fails for one user', async () => {
    const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});
    mockUserRepo.findAllWarningEnabled.mockResolvedValue([
      { userId: 'u1' },
      { userId: 'u2' }
    ] as any);
    mockUserService.checkInactivity
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);

    const intervalId = startInactivityJob(mockUserRepo, mockUserService, 2);
    activeIntervals.push(intervalId);
    
    // Wait for execution to trigger and complete
    await new Promise(resolve => setTimeout(resolve, 3));
    await Promise.resolve();

    expect(mockUserService.checkInactivity).toHaveBeenCalledTimes(2);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Error checking inactivity for user u1'),
      expect.any(Error)
    );

    consoleSpy.mockRestore();
  });

  it('refreshes lastActivity instead of escalating when the user is online', async () => {
    mockUserRepo.findAllWarningEnabled.mockResolvedValue([{ userId: 'u1' }] as any);

    const intervalId = startInactivityJob(mockUserRepo, mockUserService, 2, async () => 'online');
    activeIntervals.push(intervalId);

    await new Promise((resolve) => setTimeout(resolve, 3));
    await Promise.resolve();

    expect(mockUserRepo.update).toHaveBeenCalledWith('u1', { lastActivity: expect.any(Date) });
    expect(mockUserService.checkInactivity).not.toHaveBeenCalled();
  });

  it('skips the user entirely when presence is unknown rather than escalating', async () => {
    // `unknown` is a Redis this instance could not reach, not a user who left.
    // Escalating on it reaches `checkInactivity`, which past the warning
    // threshold notifies the user's emergency contacts once and never retracts
    // it — so a Redis blip must not be able to trigger that.
    mockUserRepo.findAllWarningEnabled.mockResolvedValue([{ userId: 'u1' }] as any);

    const intervalId = startInactivityJob(mockUserRepo, mockUserService, 2, async () => 'unknown');
    activeIntervals.push(intervalId);

    await new Promise((resolve) => setTimeout(resolve, 3));
    await Promise.resolve();

    expect(mockUserService.checkInactivity).not.toHaveBeenCalled();
    expect(mockUserRepo.update).not.toHaveBeenCalled();
  });

  it('logs and releases the lock when findAllWarningEnabled fails', async () => {
    const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});
    mockUserRepo.findAllWarningEnabled
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValue([] as any);

    const intervalId = startInactivityJob(mockUserRepo, mockUserService, 2);
    activeIntervals.push(intervalId);
    
    // Wait for first tick
    await new Promise(resolve => setTimeout(resolve, 3));
    await Promise.resolve();

    expect(consoleSpy).toHaveBeenCalledWith('Error running inactivity job:', expect.any(Error));

    // The lock must be released so the next tick runs again
    await new Promise(resolve => setTimeout(resolve, 3));
    await Promise.resolve();
    expect(mockUserRepo.findAllWarningEnabled.mock.calls.length).toBeGreaterThanOrEqual(2);

    consoleSpy.mockRestore();
  });
});
