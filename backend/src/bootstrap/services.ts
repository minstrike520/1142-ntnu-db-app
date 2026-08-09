import type { ServerToClientEvents } from '@shared/types';
import type { RealtimePublisher } from '../realtime/publisher';
import type { Repositories } from './repositories';
import { signToken, generateRefreshToken, hashToken } from '../utils/jwt';
import { makeUserService } from '../services/userService';
import { makeRoomService } from '../services/roomService';
import { makeMessageService } from '../services/messageService';
import { makeFolderService } from '../services/folderService';
import { makeAttachmentService } from '../services/attachmentService';
import { makeFriendService } from '../services/friendService';

export interface Services {
  user: ReturnType<typeof makeUserService>;
  room: ReturnType<typeof makeRoomService>;
  message: ReturnType<typeof makeMessageService>;
  folder: ReturnType<typeof makeFolderService>;
  attachment: ReturnType<typeof makeAttachmentService>;
  friend: ReturnType<typeof makeFriendService>;
}

export interface CreateServicesDeps {
  repositories: Repositories;
  publisher: RealtimePublisher;
}

/**
 * Every service, wired to its repositories and to the realtime server.
 *
 * Construction order matters: `userService`'s emergency callback calls
 * `roomService` and `messageService`, and `friendService` is handed three of
 * `roomService`'s methods. Those references resolve when the callbacks fire,
 * not while this function runs, which is what lets `userService` be built
 * first — exactly as it was when this lived in `index.ts`.
 */
export const createServices = ({ repositories, publisher }: CreateServicesDeps): Services => {
  const userService = makeUserService(
    repositories.users,
    repositories.emergencyContacts,
    repositories.refreshTokens,
    { signToken, generateRefreshToken, hashToken },
    async (contactId, payload) => {
      let room = await repositories.rooms.findPrivateRoomByMembers(payload.userId, contactId);
      if (!room || room.isReadonly) {
        // Emergency contacts do not need to be friends, but createPrivate
        // still enforces the block check when friendship validation is bypassed.
        const result = await roomService.createPrivate(payload.userId, contactId, true);
        room = result.room;
      }

      const message = await messageService.sendMessage(payload.userId, room.roomId, payload.message, {
        commandId: `emergency:${payload.userId}:${contactId}:${payload.incidentId}`,
      });
      if (!(message as typeof message & { __replayedCommand?: boolean }).__replayedCommand) {
        const { incidentId: _incidentId, ...publicPayload } = payload;
        publisher.publishUserEvent(contactId, 'emergency_alert', publicPayload);
      }
    },
    repositories.friends,
    async (userId, data) => {
      try {
        const rooms = await repositories.rooms.findByMember(userId);
        for (const room of rooms) {
          publisher.publishRoomEvent(room.roomId, 'room_update', {
            type: 'USER_UPDATED',
            roomId: room.roomId,
            data: { userId, ...data },
          });
        }
      } catch (err) {
        console.error('Failed to broadcast user update:', err);
      }
    },
    undefined,
    publisher.disconnectUser,
  );

  const roomService = makeRoomService(
    repositories.rooms,
    repositories.roomMembers,
    (roomId, eventName, payload) => {
      if (eventName === 'room_update') {
        const p = payload as { type: string; data: unknown };
        publisher.publishRoomEvent(roomId, 'room_update', { ...p, roomId });
      } else {
        publisher.publishRoomEvent(roomId, eventName as keyof ServerToClientEvents, payload);
      }
    },
    repositories.friends,
    repositories.users,
    repositories.messages,
    (userId, eventName, payload) => {
      publisher.publishUserEvent(userId, eventName as keyof ServerToClientEvents, payload);
    },
    undefined,
    (userId, roomId) => {
      return publisher.removeUserFromRoom(userId, roomId);
    },
    (userId, roomId) => {
      return publisher.addUserToRoom(userId, roomId);
    },
  );

  const messageService = makeMessageService(
    repositories.messages,
    repositories.rooms,
    repositories.roomMembers,
    (roomId, eventName, payload) => {
      publisher.publishRoomEvent(roomId, eventName, payload);
    },
  );

  const folderService = makeFolderService(repositories.folders, repositories.roomMembers);

  const attachmentService = makeAttachmentService(repositories.attachments);

  const friendService = makeFriendService(
    repositories.friends,
    (userId, eventName, payload) => {
      publisher.publishUserEvent(userId, eventName as keyof ServerToClientEvents, payload);
    },
    {
      markPrivateReadOnly: roomService.markPrivateReadOnly,
      createPrivate: (userA: string, userB: string, bypassFriendCheck?: boolean) =>
        roomService.createPrivate(userA, userB, bypassFriendCheck),
      reopenPrivateRoom: roomService.reopenPrivateRoom,
    },
    publisher.removeUserFromRoom,
  );

  return {
    user: userService,
    room: roomService,
    message: messageService,
    folder: folderService,
    attachment: attachmentService,
    friend: friendService,
  };
};
