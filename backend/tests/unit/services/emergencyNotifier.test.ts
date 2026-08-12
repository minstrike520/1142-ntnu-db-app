import { describe, it, expect, beforeEach, mock } from 'bun:test';

import { makeEmergencyNotifier } from '../../../src/services/emergencyNotifier';
import { ForbiddenError } from '../../../src/utils/AppError';

describe('emergencyNotifier', () => {
  let userRepo: any;
  let socialRepo: any;
  let roomService: any;
  let messageService: any;
  let emitNewMessage: any;
  let notifyRoomJoined: any;
  let notify: ReturnType<typeof makeEmergencyNotifier>;

  const payload = { userId: 'u1', message: 'Please check on me' };
  const persistedMessage = { messageId: 'm1', roomId: 'r1', senderId: 'u1' } as any;

  beforeEach(() => {
    userRepo = { findById: mock().mockResolvedValue({ userId: 'c1' }) };
    socialRepo = { isBlocked: mock().mockResolvedValue(false) };
    roomService = { createPrivate: mock().mockResolvedValue({ room: { roomId: 'r1' } }) };
    messageService = { sendMessage: mock().mockResolvedValue(persistedMessage) };
    emitNewMessage = mock();
    notifyRoomJoined = mock();

    notify = makeEmergencyNotifier({
      userRepo,
      socialRepo,
      roomService,
      messageService,
      emitNewMessage,
      notifyRoomJoined,
    });
  });

  it('persists the alert before emitting anything', async () => {
    const order: string[] = [];
    messageService.sendMessage.mockImplementation(async () => {
      order.push('persist');
      return persistedMessage;
    });
    emitNewMessage.mockImplementation(() => order.push('emit'));

    const outcome = await notify('c1', payload);

    expect(outcome).toEqual({ delivered: true });
    expect(order).toEqual(['persist', 'emit']);
    expect(messageService.sendMessage).toHaveBeenCalledWith('u1', 'r1', 'Please check on me');
    expect(emitNewMessage).toHaveBeenCalledWith('r1', persistedMessage);
  });

  it('emits no realtime signal at all when the durable write fails', async () => {
    messageService.sendMessage.mockRejectedValue(new Error('database is down'));

    const outcome = await notify('c1', payload);

    expect(outcome).toEqual({ delivered: false, retryable: true, code: 'PERSIST_FAILED' });
    expect(emitNewMessage).not.toHaveBeenCalled();
    expect(notifyRoomJoined).not.toHaveBeenCalled();
  });

  it('reports room creation failure instead of swallowing it', async () => {
    roomService.createPrivate.mockRejectedValue(new Error('connection reset'));

    const outcome = await notify('c1', payload);

    expect(outcome).toEqual({ delivered: false, retryable: true, code: 'ROOM_UNAVAILABLE' });
    expect(messageService.sendMessage).not.toHaveBeenCalled();
    expect(emitNewMessage).not.toHaveBeenCalled();
  });

  it('classifies a 4xx rejection as permanent so it is not retried forever', async () => {
    messageService.sendMessage.mockRejectedValue(new ForbiddenError('Muted members cannot send messages'));

    const outcome = await notify('c1', payload);

    expect(outcome).toEqual({ delivered: false, retryable: false, code: 'PERSIST_FAILED' });
  });

  it('refuses to deliver to a contact who blocked the sender, and never reopens the room', async () => {
    socialRepo.isBlocked.mockResolvedValue(true);

    const outcome = await notify('c1', payload);

    expect(outcome).toEqual({ delivered: false, retryable: false, code: 'CONTACT_BLOCKED' });
    expect(roomService.createPrivate).not.toHaveBeenCalled();
    expect(messageService.sendMessage).not.toHaveBeenCalled();
  });

  it('treats a soft-deleted contact as a permanent skip', async () => {
    userRepo.findById.mockResolvedValue(null);

    const outcome = await notify('c1', payload);

    expect(outcome).toEqual({ delivered: false, retryable: false, code: 'CONTACT_UNAVAILABLE' });
    expect(socialRepo.isBlocked).not.toHaveBeenCalled();
    expect(roomService.createPrivate).not.toHaveBeenCalled();
  });

  it('stays delivered when the realtime fan-out throws after a successful write', async () => {
    emitNewMessage.mockImplementation(() => {
      throw new Error('socket server not ready');
    });

    const outcome = await notify('c1', payload);

    // Reporting failure here would hand back the dedupe marker and the next run
    // would persist a second copy of an alert that was already stored.
    expect(outcome).toEqual({ delivered: true });
  });

  it('re-announces the room to the contact after the message exists', async () => {
    await notify('c1', payload);

    expect(notifyRoomJoined).toHaveBeenCalledWith('c1', 'r1');
    expect(roomService.createPrivate).toHaveBeenCalledWith('u1', 'c1', true);
  });
});
