import { Hono } from "hono";
import { cors } from "hono/cors";
import { getRequestListener } from "@hono/node-server";
import { createServer } from "node:http";
import path from "path";
import pool from "./models/db";
import { signToken, generateRefreshToken, hashToken } from "./utils/jwt";
import { RefreshTokenRepository } from "./models/refreshTokenRepository";
import { errorHandler } from "./middlewares/errorHandler";
import { authMiddleware } from "./middlewares/authMiddleware";
import { makeAuthRateLimiter, makeGlobalRateLimiter, securityHeaders } from "./middlewares/securityMiddleware";
import { UserRepository } from "./models/userRepository";
import { EmergencyContactRepository } from "./models/emergencyContactRepository";
import { RoomRepository } from "./models/roomRepository";
import { RoomMemberRepository } from "./models/roomMemberRepository";
import { MessageRepository } from "./models/messageRepository";
import { RealtimeRepository } from "./models/realtimeRepository";
import { FolderRepository } from "./models/folderRepository";
import { AttachmentRepository } from "./models/attachmentRepository";
import { makeAttachmentService } from "./services/attachmentService";
import { makeAttachmentRoutes } from "./routes/attachmentRoutes";
import { makeFriendRepository } from "./models/friendRepository";
import { makeUserService } from "./services/userService";
import { makeRoomService } from "./services/roomService";
import { makeMessageService } from "./services/messageService";
import { makeFolderService } from "./services/folderService";
import { makeFriendService } from "./services/friendService";
import { makeRealtimeService } from "./services/realtimeService";
import { startInactivityJob } from "./utils/inactivityJob";
import { makeAuthRoutes } from "./routes/authRoutes";
import { makeUserRoutes } from "./routes/userRoutes";
import { makeRoomRoutes } from "./routes/roomRoutes";
import { makeMessageRoutes } from "./routes/messageRoutes";
import { makeFolderRoutes } from "./routes/folderRoutes";
import { makeFriendRoutes, makeBlockRoutes, makeFriendRequestRoutes } from "./routes/friendRoutes";
import { makeRealtimeRoutes } from "./routes/realtimeRoutes";
import { RealtimeManager } from "./realtime/manager";
import { RealtimeCommandHandler } from "./realtime/commandHandler";
import { createRealtimeServer, type RealtimeServer } from "./realtime/server";
import { WsTicketService } from "./realtime/wsTicket";
import { AVATARS_UPLOAD_DIR, ensureUploadDirectories } from "./utils/uploads";
import { avatarContentType } from "./utils/avatarUpload";
import type { MessageWithSender } from "../../shared/types";
import type { RealtimeMessage } from "../../shared/realtime";

const honoApp = new Hono();

const DEFAULT_CORS_ORIGINS = ['http://localhost:3000', 'http://localhost:3005', 'http://localhost:5173'];
const allowedOrigins = (process.env.CORS_ORIGINS ?? DEFAULT_CORS_ORIGINS.join(','))
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

// Security Headers & CORS
honoApp.use('*', securityHeaders);
honoApp.use('*', cors({
  origin: (origin) => (allowedOrigins.includes(origin) ? origin : null),
  credentials: true,
}));

// Global Rate Limiter for API
honoApp.use('/api/*', makeGlobalRateLimiter());

// Static uploads serving
void ensureUploadDirectories();
honoApp.get('/uploads/avatars/*', async (c) => {
  const reqPath = c.req.path.replace('/uploads/avatars/', '');
  const fileName = path.basename(reqPath);
  const filePath = path.join(AVATARS_UPLOAD_DIR, fileName);
  const file = Bun.file(filePath);
  if (await file.exists()) {
    return new Response(file, {
      status: 200,
      headers: {
        'Content-Type': avatarContentType(fileName),
        'Cache-Control': 'public, max-age=604800, immutable',
        'Cross-Origin-Resource-Policy': 'cross-origin',
      },
    });
  }
  return c.notFound();
});

const userRepo = new UserRepository(pool);
const emergencyContactRepo = new EmergencyContactRepository(pool);
const roomRepo = new RoomRepository(pool);
const roomMemberRepo = new RoomMemberRepository(pool);
const messageRepo = new MessageRepository(pool);
const folderRepo = new FolderRepository(pool);
const attachmentRepo = new AttachmentRepository(pool);
const friendRepo = makeFriendRepository(pool);
const refreshTokenRepo = new RefreshTokenRepository(pool);
const realtimeRepo = new RealtimeRepository(pool);
const wsTickets = new WsTicketService();
const realtimeManager = new RealtimeManager({
  presenceRecipients: async (userId) =>
    (await friendRepo.getFriends(userId)).map((friend) => friend.friend.userId),
});
const realtimeService = makeRealtimeService({
  repository: realtimeRepo,
  publisher: realtimeManager,
});

const toRealtimeMessage = (message: MessageWithSender): RealtimeMessage => ({
  messageId: message.messageId,
  roomId: message.roomId,
  senderId: message.senderId,
  content: message.content,
  ...(message.replyToId ? { replyToId: message.replyToId } : {}),
  isRecalled: message.isRecalled,
  sentAt: new Date(message.sentAt).toISOString(),
  revision: message.revision ?? '0',
  sender: message.sender,
  ...(message.mentions ? { mentions: message.mentions } : {}),
  ...(message.attachments ? {
    attachments: message.attachments.map((attachment) => ({
      attachmentId: attachment.attachmentId,
      uploadedBy: attachment.uploadedBy,
      fileUrl: attachment.fileUrl,
      fileType: attachment.fileType,
      originalName: attachment.originalName,
      uploadedAt: new Date(attachment.uploadedAt).toISOString(),
    })),
  } : {}),
});

const userService = makeUserService(
  userRepo,
  emergencyContactRepo,
  refreshTokenRepo,
  { signToken, generateRefreshToken, hashToken },
  async (contactId, payload) => {
    await realtimeService.deliverEmergencyAlert({
      sourceUserId: payload.userId,
      recipientId: contactId,
      idempotencyKey: payload.idempotencyKey,
      message: payload.message,
    });
  },
  friendRepo,
  async (userId, data) => {
    try {
      const rooms = await roomRepo.findByMember(userId);
      for (const room of rooms) {
        await realtimeManager.publish({
          target: { kind: 'room', roomId: room.roomId },
          type: 'room.updated',
          streamId: `room:${room.roomId}`,
          reliable: true,
          payload: { roomId: room.roomId, change: 'USER_UPDATED', data: { userId, ...data } },
        });
      }
    } catch (err) {
      console.error('Failed to broadcast user update:', err);
    }
  }
);

const roomService = makeRoomService(
  roomRepo,
  roomMemberRepo,
  {
    roomUpdated(roomId, change, data) {
      void realtimeManager.publish({
        target: { kind: 'room', roomId },
        type: 'room.updated',
        streamId: `room:${roomId}`,
        reliable: true,
        payload: { roomId, change, data },
      });
      const affectedUserId = typeof data === 'object' && data !== null && 'userId' in data
        ? String(data.userId)
        : undefined;
      const accessRevoked = change === 'MEMBER_KICKED'
        || change === 'MEMBER_LEFT'
        || (change === 'MEMBER_UPDATED'
          && typeof data === 'object'
          && data !== null
          && 'role' in data
          && data.role === 'pending');
      if (affectedUserId && accessRevoked) void realtimeManager.revokeRoom(affectedUserId, roomId);
    },
    messageCreated(roomId, value) {
      const message = toRealtimeMessage(value as MessageWithSender);
      void realtimeManager.publish({
        target: { kind: 'room', roomId },
        type: 'message.created',
        streamId: `room:${roomId}`,
        reliable: true,
        payload: { revision: message.revision, message },
      });
    },
    userRoomUpdated(userId, roomId, change, data) {
      void realtimeManager.publish({
        target: { kind: 'user', userId },
        type: 'room.updated',
        streamId: `user:${userId}`,
        reliable: true,
        payload: { roomId, change, data },
      });
    },
  },
  friendRepo,
  userRepo,
  messageRepo,
  (userId) => realtimeManager.isUserOnline(userId),
);

const messageService = makeMessageService(messageRepo, roomRepo, roomMemberRepo);
const folderService = makeFolderService(folderRepo, roomMemberRepo);
const attachmentService = makeAttachmentService(attachmentRepo);

const friendService = makeFriendService(friendRepo, (userId, payload) => {
  void realtimeManager.publish({
    target: { kind: 'user', userId },
    type: 'friend.requested',
    streamId: `user:${userId}`,
    reliable: true,
    payload: { data: payload },
  });
}, {
  markPrivateReadOnly: roomService.markPrivateReadOnly,
  createPrivate: (userA: string, userB: string, bypassFriendCheck?: boolean) => roomService.createPrivate(userA, userB, bypassFriendCheck),
  reopenPrivateRoom: roomService.reopenPrivateRoom,
}, (userId) => realtimeManager.isUserOnline(userId));

const realtimeCommands = new RealtimeCommandHandler({
  manager: realtimeManager,
  tickets: wsTickets,
  listAuthorizedRoomIds: (userId) => realtimeRepo.listAuthorizedRoomIds(userId),
  service: realtimeService,
});

// Attach Hono API Routes
honoApp.use('/api/v1/auth/*', makeAuthRateLimiter());
honoApp.route('/api/v1/auth', makeAuthRoutes(userService));
honoApp.route('/api/v1/users', makeUserRoutes(userService));

const roomApi = new Hono();
roomApi.use('*', authMiddleware);
roomApi.route('/', makeRoomRoutes(roomService));
roomApi.route('/', makeMessageRoutes(messageService));
honoApp.route('/api/v1/rooms', roomApi);

honoApp.route('/api/v1/folders', makeFolderRoutes(folderService));
honoApp.route('/api/v1/attachments', makeAttachmentRoutes(attachmentService));
honoApp.route('/api/v1/friends', makeFriendRoutes(friendService));
honoApp.route('/api/v1/friend-requests', makeFriendRequestRoutes(friendService));
honoApp.route('/api/v1/blocks', makeBlockRoutes(friendService));
honoApp.route('/api/v1/realtime', makeRealtimeRoutes(wsTickets, realtimeService));

honoApp.onError(errorHandler);

const requestListener = getRequestListener(honoApp.fetch);
const server = createServer(requestListener);
const app = server;
const PORT = Number(process.env.PORT ?? 4000);
let productionServer: RealtimeServer | undefined;

if (require.main === module) {
  startInactivityJob(userRepo, userService, undefined, (userId) => realtimeManager.isUserOnline(userId));

  (async () => {
    let version = "1.0.0";
    try {
      const rootPkg = await Bun.file(path.join(process.cwd(), "../package.json")).json();
      version = rootPkg.version;
    } catch {
      try {
        const localPkg = await Bun.file(path.join(process.cwd(), "package.json")).json();
        version = localPkg.version;
      } catch {}
    }

    productionServer = createRealtimeServer({
      app: honoApp,
      tickets: wsTickets,
      manager: realtimeManager,
      allowedOrigins,
      handleCommand: (connectionId, frame) => realtimeCommands.handle(connectionId, frame),
      port: PORT,
    });
    console.log(`Backend server (v${version}) successfully listening on port ${productionServer.port} (0.0.0.0)`);

    const shutdown = async () => {
      await productionServer?.stop(false);
      process.exit(0);
    };
    process.once('SIGTERM', () => void shutdown());
    process.once('SIGINT', () => void shutdown());
  })();
}

export { app, honoApp, server, realtimeManager, realtimeCommands };
