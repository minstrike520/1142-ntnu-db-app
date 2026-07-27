import type { Server } from 'socket.io';
import type { ClientToServerEvents, JwtPayload, ServerToClientEvents } from '@shared/types';
import { verifyToken } from '../utils/jwt';
import pool from '../models/db';
import { UserRepository } from '../models/userRepository';

type SocketData = {
  user: JwtPayload;
};

export type ChatServer = Server<ClientToServerEvents, ServerToClientEvents, never, SocketData>;

export const attachSocketAuth = (io: ChatServer): void => {
  io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    if (typeof token !== 'string' || token.length === 0) {
      next(new Error('Authentication error'));
      return;
    }

    try {
      const payload = await verifyToken(token);
      const userRepo = new UserRepository(pool);
      const user = await userRepo.findById(payload.userId);
      if (!user) {
        next(new Error('Authentication error'));
        return;
      }
      socket.data.user = payload;
      next();
    } catch {
      next(new Error('Authentication error'));
    }
  });
};
