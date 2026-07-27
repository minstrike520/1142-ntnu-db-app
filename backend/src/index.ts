import { Hono } from "hono";
import { cors } from "hono/cors";
import { getRequestListener } from "@hono/node-server";
import { createServer } from "node:http";
import path from "path";
import { Server } from "socket.io";
import pool from "./models/db";
import { signToken, generateRefreshToken, hashToken } from "./utils/jwt";
import { RefreshTokenRepository } from "./models/refreshTokenRepository";
import { errorHandler } from "./middlewares/errorHandler";
import { makeAuthRateLimiter, makeGlobalRateLimiter, securityHeaders } from "./middlewares/securityMiddleware";
import { UserRepository } from "./models/userRepository";
import { EmergencyContactRepository } from "./models/emergencyContactRepository";
import { RoomRepository } from "./models/roomRepository";
import { RoomMemberRepository } from "./models/roomMemberRepository";
import { MessageRepository } from "./models/messageRepository";
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
import { startInactivityJob } from "./utils/inactivityJob";
import { makeAuthRoutes } from "./routes/authRoutes";
import { makeUserRoutes } from "./routes/userRoutes";
import { makeRoomRoutes } from "./routes/roomRoutes";
import { makeMessageRoutes } from "./routes/messageRoutes";
import { makeFolderRoutes } from "./routes/folderRoutes";
import { makeFriendRoutes, makeBlockRoutes, makeFriendRequestRoutes } from "./routes/friendRoutes";
import { attachSocketAuth } from "./realtime/authSocket";
import { attachSockets } from "./realtime/socketServer";
import { AVATARS_UPLOAD_DIR, ensureUploadDirectories } from "./utils/uploads";
import { avatarContentType } from "./utils/avatarUpload";
import type { ClientToServerEvents, ServerToClientEvents } from "../../shared/types";

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

const userService = makeUserService(
  userRepo,
  emergencyContactRepo,
  refreshTokenRepo,
  { signToken, generateRefreshToken, hashToken },
  async (contactId, payload) => {
    let room = await roomRepo.findPrivateRoomByMembers(payload.userId, contactId);
    if (!room) {
      try {
        const result = await roomService.createPrivate(payload.userId, contactId, true);
        room = result.room;
      } catch (err) {
        console.error('Failed to auto-create private room for emergency contact:', err);
      }
    }

    if (room) {
      try {
        const message = await messageService.sendMessage(payload.userId, room.roomId, payload.message);
        io.to(`room_${room.roomId}`).emit('new_message', message);
      } catch (err) {
        console.error('Failed to auto-send emergency message:', err);
        io.to(`user_${contactId}`).emit('emergency_alert', payload);
      }
    } else {
      io.to(`user_${contactId}`).emit('emergency_alert', payload);
    }
  },
  friendRepo,
  async (userId, data) => {
    try {
      const rooms = await roomRepo.findByMember(userId);
      for (const room of rooms) {
        io.to(`room_${room.roomId}`).emit('room_update', {
          type: 'USER_UPDATED',
          roomId: room.roomId,
          data: { userId, ...data },
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
  (roomId, eventName, payload) => {
    if (eventName === 'room_update') {
      const p = payload as { type: string; data: unknown };
      io.to(`room_${roomId}`).emit('room_update', { ...p, roomId });
    } else {
      io.to(`room_${roomId}`).emit(eventName as keyof ServerToClientEvents, payload as never);
    }
  },
  friendRepo,
  userRepo,
  messageRepo,
  (userId, eventName, payload) => {
    io.to(`user_${userId}`).emit(eventName as keyof ServerToClientEvents, payload as never);
  },
);

const messageService = makeMessageService(messageRepo, roomRepo, roomMemberRepo);
const folderService = makeFolderService(folderRepo, roomMemberRepo);
const attachmentService = makeAttachmentService(attachmentRepo);

const friendService = makeFriendService(friendRepo, (userId, eventName, payload) => {
  io.to(`user_${userId}`).emit(eventName as keyof ServerToClientEvents, payload as never);
}, {
  markPrivateReadOnly: roomService.markPrivateReadOnly,
  createPrivate: (userA: string, userB: string, bypassFriendCheck?: boolean) => roomService.createPrivate(userA, userB, bypassFriendCheck),
  reopenPrivateRoom: roomService.reopenPrivateRoom,
});

// Attach Hono API Routes
honoApp.use('/api/v1/auth/*', makeAuthRateLimiter());
honoApp.route('/api/v1/auth', makeAuthRoutes(userService));
honoApp.route('/api/v1/users', makeUserRoutes(userService));
honoApp.route('/api/v1/rooms', makeRoomRoutes(roomService));
honoApp.route('/api/v1/rooms', makeMessageRoutes(messageService));
honoApp.route('/api/v1/folders', makeFolderRoutes(folderService));
honoApp.route('/api/v1/attachments', makeAttachmentRoutes(attachmentService));
honoApp.route('/api/v1/friends', makeFriendRoutes(friendService));
honoApp.route('/api/v1/friend-requests', makeFriendRequestRoutes(friendService));
honoApp.route('/api/v1/blocks', makeBlockRoutes(friendService));

honoApp.onError(errorHandler);

const requestListener = getRequestListener(honoApp.fetch);
const server = createServer(requestListener);
const app = server;

const io = new Server<ClientToServerEvents, ServerToClientEvents>(server, {
  cors: { origin: allowedOrigins, credentials: true },
});

const PORT = process.env.PORT || 4000;

attachSocketAuth(io);
attachSockets(io, {
  messageService,
  messageRepository: messageRepo,
  roomMemberRepository: roomMemberRepo,
  friendRepository: friendRepo
});

if (require.main === module) {
  startInactivityJob(userRepo, userService);

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

    server.listen(PORT as number, "0.0.0.0", () =>
      console.log(`Backend server (v${version}) successfully listening on port ${PORT} (0.0.0.0)`),
    );
  })();
}

export { app, honoApp, server, io };
