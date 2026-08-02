import { describe, expect, mock, test } from 'bun:test';
import type { RealtimeMessage } from '@shared/realtime';
import type { RealtimePublisher } from '../../../src/realtime/publisher';
import { makeRealtimeService } from '../../../src/services/realtimeService';

const message: RealtimeMessage = {
  messageId: 'message-1',
  roomId: 'room-1',
  senderId: 'alice',
  content: 'hello',
  isRecalled: false,
  sentAt: '2026-08-03T00:00:00.000Z',
  revision: '1',
  sender: { userId: 'alice', name: 'Alice' },
};

describe('RealtimeService durable-first publishing', () => {
  test('publishes a committed Message change and only publishes Read position advances', async () => {
    const publications: Array<{ type: string }> = [];
    const publisher: RealtimePublisher = {
      async publish(publication) {
        publications.push(publication);
        return { delivered: 1, dropped: 0 };
      },
    };
    let readAdvances = 0;
    const service = makeRealtimeService({
      repository: {
        hasAuthorizedMembership: async () => true,
        getRoomAccess: async () => ({ role: 'owner', isMuted: false, isArchived: false, isReadonly: false }),
        resolveMentionUserIds: async () => [],
        createMessage: async () => ({ message, replayed: false }),
        editMessage: async () => ({ message: { ...message, content: 'edited', revision: '2' }, replayed: false }),
        recallMessage: async () => ({ message: { ...message, content: '', isRecalled: true, revision: '3' }, replayed: false }),
        getMessageDelta: async () => ({ changes: [], cursor: 'cursor', highWaterRevision: '3', complete: true }),
        advanceReadPosition: async () => ({ messageId: message.messageId, advanced: readAdvances++ === 0 }),
        createEmergencyNotification: async () => ({ notificationId: 'notification-1', replayed: false, published: false }),
        markEmergencyNotificationPublished: async () => undefined,
        listEmergencyNotifications: async () => [],
      },
      publisher,
    });

    await service.sendMessage('alice', 'connection-1', 'command-1', {
      roomId: 'room-1', content: 'hello',
    });
    await service.advanceReadPosition('alice', 'connection-1', 'room-1', message.messageId);
    await service.advanceReadPosition('alice', 'connection-1', 'room-1', message.messageId);

    expect(publications.map((publication) => publication.type)).toEqual([
      'message.created',
      'read.advanced',
      'read.advanced',
    ]);
  });

  test('Emergency alert is never published when durable creation fails', async () => {
    let publishCount = 0;
    const service = makeRealtimeService({
      repository: {
        hasAuthorizedMembership: async () => true,
        getRoomAccess: async () => ({ role: 'owner', isMuted: false, isArchived: false, isReadonly: false }),
        resolveMentionUserIds: async () => [],
        createMessage: async () => ({ message, replayed: false }),
        editMessage: async () => ({ message, replayed: false }),
        recallMessage: async () => ({ message, replayed: false }),
        getMessageDelta: async () => ({ changes: [], cursor: 'cursor', highWaterRevision: '1', complete: true }),
        advanceReadPosition: async () => ({ messageId: message.messageId, advanced: false }),
        createEmergencyNotification: async () => { throw new Error('database unavailable'); },
        markEmergencyNotificationPublished: async () => undefined,
        listEmergencyNotifications: async () => [],
      },
      publisher: {
        async publish() {
          publishCount += 1;
          return { delivered: 0, dropped: 0 };
        },
      },
    });

    await expect(service.deliverEmergencyAlert({
      sourceUserId: 'alice', recipientId: 'bob', idempotencyKey: 'alert-1', message: 'check in',
    })).rejects.toThrow('database unavailable');
    expect(publishCount).toBe(0);
  });

  test('enforces room write state and resolves direct and everyone mentions', async () => {
    const createMessage = mock(async () => ({ message, replayed: false }));
    const getRoomAccess = mock(async () => ({
      role: 'member' as const,
      isMuted: false,
      isArchived: false,
      isReadonly: true,
    }));
    const resolveMentionUserIds = mock(async () => ['bob', 'carol']);
    const service = makeRealtimeService({
      repository: {
        hasAuthorizedMembership: async () => true,
        getRoomAccess,
        resolveMentionUserIds,
        createMessage,
        editMessage: async () => ({ message, replayed: false }),
        recallMessage: async () => ({ message, replayed: false }),
        getMessageDelta: async () => ({ changes: [], cursor: 'cursor', highWaterRevision: '1', complete: true }),
        advanceReadPosition: async () => ({ messageId: message.messageId, advanced: false }),
        createEmergencyNotification: async () => ({ notificationId: 'notification-1', replayed: false, published: false }),
        markEmergencyNotificationPublished: async () => undefined,
        listEmergencyNotifications: async () => [],
      },
      publisher: { publish: async () => ({ delivered: 0, dropped: 0 }) },
    });

    await expect(service.sendMessage('alice', 'connection-1', 'command-1', {
      roomId: 'room-1', content: 'hello',
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(createMessage).not.toHaveBeenCalled();

    getRoomAccess.mockResolvedValue({
      role: 'member', isMuted: false, isArchived: false, isReadonly: false,
    });
    await service.sendMessage('alice', 'connection-1', 'command-2', {
      roomId: 'room-1', content: 'hello @Bob @everyone',
    });
    expect(resolveMentionUserIds).toHaveBeenCalledWith(
      'room-1',
      ['Bob'],
      true,
      'alice',
    );
    expect(createMessage).toHaveBeenCalledWith(expect.objectContaining({
      mentionIds: ['bob', 'carol'],
    }));
  });
});
