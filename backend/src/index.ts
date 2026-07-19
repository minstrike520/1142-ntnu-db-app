import express from "express";
import path from "path";
import fs from "fs";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import pool from "./db";
import { signToken, generateRefreshToken, hashToken } from "./auth/jwt";
import { RefreshTokenRepository } from "./repositories/refreshTokenRepository";
import { errorHandler } from "./middlewares/errorHandler";
import { makeAuthRateLimiter, makeGlobalRateLimiter, securityHeaders } from "./middlewares/securityMiddleware";
import { UserRepository } from "./repositories/userRepository";
import { EmergencyContactRepository } from "./repositories/emergencyContactRepository";
import { RoomRepository } from "./repositories/roomRepository";
import { RoomMemberRepository } from "./repositories/roomMemberRepository";
import { MessageRepository } from "./repositories/messageRepository";
import { FolderRepository } from "./repositories/folderRepository";
import { AttachmentRepository } from "./repositories/attachmentRepository";
import { makeAttachmentService } from "./services/attachmentService";
import { makeAttachmentController } from "./controllers/attachmentController";
import { makeAttachmentRoutes } from "./routes/attachmentRoutes";
import { makeFriendRepository } from "./repositories/friendRepository";
import { makeUserService } from "./services/userService";
import { makeRoomService } from "./services/roomService";
import { makeMessageService } from "./services/messageService";
import { makeFolderService } from "./services/folderService";
import { makeFriendService } from "./services/friendService";
import { makeAuthController } from "./controllers/authController";
import { makeUserController } from "./controllers/userController";
import { makeRoomController } from "./controllers/roomController";
import { makeMessageController } from "./controllers/messageController";
import { makeFolderController } from "./controllers/folderController";
import { makeFriendController } from "./controllers/friendController";
import { startInactivityJob } from "./cron/inactivityJob";
import { makeAuthRoutes } from "./routes/authRoutes";
import { makeUserRoutes } from "./routes/userRoutes";
import { makeRoomRoutes } from "./routes/roomRoutes";
import { makeMessageRoutes } from "./routes/messageRoutes";
import { makeFolderRoutes } from "./routes/folderRoutes";
import { makeFriendRoutes, makeBlockRoutes, makeFriendRequestRoutes } from "./routes/friendRoutes";
import { attachSocketAuth } from "./realtime/authSocket";
import { attachSockets } from "./realtime/socketServer";
import { AVATARS_UPLOAD_DIR, ensureUploadDirectories } from "./lib/uploads";
import type { ClientToServerEvents, ServerToClientEvents } from "../../shared/types";

const app = express();
const server = http.createServer(app);

const DEFAULT_CORS_ORIGINS = ['http://localhost:3000', 'http://localhost:3005', 'http://localhost:5173'];
const allowedOrigins = (process.env.CORS_ORIGINS ?? DEFAULT_CORS_ORIGINS.join(','))
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const io = new Server<ClientToServerEvents, ServerToClientEvents>(server, {
  cors: { origin: allowedOrigins, credentials: true },
});

const PORT = process.env.PORT || 4000;

app.use(securityHeaders);
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json());
app.use("/api", makeGlobalRateLimiter());
ensureUploadDirectories();
app.use("/uploads/avatars", express.static(AVATARS_UPLOAD_DIR, {
  fallthrough: true,
  index: false,
  immutable: true,
  maxAge: '7d',
  setHeaders: (res) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  },
}));

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
    // Send a real chat message
    let room = await roomRepo.findPrivateRoomByMembers(payload.userId, contactId);
    if (!room) {
      try {
        const result = await roomService.createPrivate(payload.userId, contactId, true);
        room = result.room as any;
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
        // Fallback to basic socket alert if messaging fails
        io.to(`user_${contactId}`).emit('emergency_alert', payload);
      }
    } else {
      // Fallback to basic socket alert if they have no private room and creation failed
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
      io.to(`room_${roomId}`).emit('room_update', { ...(payload as any), roomId });
    } else {
      io.to(`room_${roomId}`).emit(eventName as any, payload);
    }
  },
  friendRepo,
  userRepo,
  messageRepo,
  // Emits directly to a user's personal socket room for targeted notifications.
  (userId, eventName, payload) => {
    io.to(`user_${userId}`).emit(eventName as any, payload);
  },
);
const messageService = makeMessageService(messageRepo, roomRepo, roomMemberRepo);
const folderService = makeFolderService(folderRepo, roomMemberRepo);
const attachmentService = makeAttachmentService(attachmentRepo);

const friendService = makeFriendService(friendRepo, (userId, eventName, payload) => {
  io.to(`user_${userId}`).emit(eventName as any, payload);
}, {
  markPrivateReadOnly: roomService.markPrivateReadOnly,
  createPrivate: (userA: string, userB: string, bypassFriendCheck?: boolean) => roomService.createPrivate(userA, userB, bypassFriendCheck),
  reopenPrivateRoom: roomService.reopenPrivateRoom,
});
const friendController = makeFriendController(friendService);

app.use("/api/v1/auth", makeAuthRateLimiter(), makeAuthRoutes(makeAuthController(userService)));
app.use("/api/v1/users", makeUserRoutes(makeUserController(userService)));
app.use("/api/v1/rooms", makeRoomRoutes(makeRoomController(roomService)));
app.use("/api/v1/rooms", makeMessageRoutes(makeMessageController(messageService)));
app.use("/api/v1/folders", makeFolderRoutes(makeFolderController(folderService)));
app.use("/api/v1/attachments", makeAttachmentRoutes(makeAttachmentController(attachmentService)));
app.use("/api/v1/friends", makeFriendRoutes(friendController));
app.use("/api/v1/friend-requests", makeFriendRequestRoutes(friendController));
app.use("/api/v1/blocks", makeBlockRoutes(friendController));
app.use(errorHandler);

attachSocketAuth(io);
attachSockets(io, {
  messageService,
  messageRepository: messageRepo,
  roomMemberRepository: roomMemberRepo,
  friendRepository: friendRepo
});

if (require.main === module) {
  startInactivityJob(userRepo, userService);

  let version = "1.0.0";
  try {
    const rootPkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "../package.json"), "utf8"));
    version = rootPkg.version;
  } catch {
    try {
      const localPkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
      version = localPkg.version;
    } catch {}
  }

  server.listen(PORT as number, "0.0.0.0", () =>
    console.log(`Backend server (v${version}) successfully listening on port ${PORT} (0.0.0.0)`),
  );
}

export { app, server, io };
