import type { ServerToClientEvents } from '@shared/types';
import type { ChatServer } from '../realtime/authSocket';
import type { Repositories } from './repositories';
import { signToken, generateRefreshToken, hashToken } from '../utils/jwt';
import { makeUserService } from '../services/userService';
import { makeRoomService } from '../services/roomService';
import { makeMessageService } from '../services/messageService';
import { makeFolderService } from '../services/folderService';
import { makeAttachmentService } from '../services/attachmentService';
import { makeFriendService } from '../services/friendService';
import { makeEmergencyNotifier } from '../services/emergencyNotifier';

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
  /**
   * Resolves the Socket.IO server at emit time rather than at construction.
   *
   * The wiring is genuinely circular: services need to emit through `io`, `io`
   * is built on the HTTP server, the HTTP server serves the Hono app, and the
   * routes on that app need the services. Previously every one of these lived
   * in one module scope, so the emit callbacks simply closed over an `io` that
   * was assigned further down the file. Splitting the wiring across modules
   * removes that shared scope, and this accessor is what replaces it.
   *
   * Nothing here emits during construction, so by the time any of these
   * callbacks run — on an HTTP request, a socket event or the inactivity timer
   * — `io` exists.
   */
  getIo: () => ChatServer;
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
export const createServices = ({ repositories, getIo }: CreateServicesDeps): Services => {
  const userService = makeUserService(
    repositories.users,
    repositories.emergencyContacts,
    repositories.refreshTokens,
    { signToken, generateRefreshToken, hashToken },
    // The delivery rules live in `makeEmergencyNotifier`, not here — bootstrap
    // wires, it does not decide. Every service reference below is reached
    // through a closure so that `roomService` and `messageService`, declared
    // further down, are resolved when an alert fires rather than now.
    makeEmergencyNotifier({
      userRepo: repositories.users,
      socialRepo: repositories.friends,
      roomService: {
        createPrivate: (creatorId, targetUserId, bypassFriendCheck) =>
          roomService.createPrivate(creatorId, targetUserId, bypassFriendCheck),
      },
      messageService: {
        sendMessage: (userId, roomId, content) => messageService.sendMessage(userId, roomId, content),
      },
      emitNewMessage: (roomId, message) => {
        getIo().to(`room_${roomId}`).emit('new_message', message);
      },
      notifyRoomJoined: (userId, roomId) => {
        getIo().to(`user_${userId}`).emit('room_update', { type: 'ROOM_JOINED', roomId, data: {} });
      },
    }),
    repositories.friends,
    async (userId, data) => {
      try {
        const rooms = await repositories.rooms.findByMember(userId);
        for (const room of rooms) {
          getIo().to(`room_${room.roomId}`).emit('room_update', {
            type: 'USER_UPDATED',
            roomId: room.roomId,
            data: { userId, ...data },
          });
        }
      } catch (err) {
        console.error('Failed to broadcast user update:', err);
      }
    },
  );

  const roomService = makeRoomService(
    repositories.rooms,
    repositories.roomMembers,
    (roomId, eventName, payload) => {
      if (eventName === 'room_update') {
        const p = payload as { type: string; data: unknown };
        getIo().to(`room_${roomId}`).emit('room_update', { ...p, roomId });
      } else {
        getIo().to(`room_${roomId}`).emit(eventName as keyof ServerToClientEvents, payload as never);
      }
    },
    repositories.friends,
    repositories.users,
    repositories.messages,
    (userId, eventName, payload) => {
      getIo().to(`user_${userId}`).emit(eventName as keyof ServerToClientEvents, payload as never);
    },
  );

  const messageService = makeMessageService(
    repositories.messages,
    repositories.rooms,
    repositories.roomMembers,
  );

  const folderService = makeFolderService(repositories.folders, repositories.roomMembers);

  const attachmentService = makeAttachmentService(repositories.attachments);

  const friendService = makeFriendService(
    repositories.friends,
    (userId, eventName, payload) => {
      getIo().to(`user_${userId}`).emit(eventName as keyof ServerToClientEvents, payload as never);
    },
    {
      markPrivateReadOnly: roomService.markPrivateReadOnly,
      createPrivate: (userA: string, userB: string, bypassFriendCheck?: boolean) =>
        roomService.createPrivate(userA, userB, bypassFriendCheck),
      reopenPrivateRoom: roomService.reopenPrivateRoom,
    },
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
