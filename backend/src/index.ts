import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // allow all for dev
  },
});

const prisma = new PrismaClient();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_key";

app.use(cors());
app.use(express.json());

// --- REST API ---

app.post("/auth/register", async (req, res) => {
  const { username, password } = req.body;
  try {
    const existing = await prisma.user.findUnique({ where: { username } });
    if (existing) {
      return res.status(400).json({ error: "Username already exists" });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { username, password: hashedPassword },
    });
    // Create default room if doesn't exist just to test
    const defaultRoom = await prisma.room.findFirst({ where: { name: "General" } });
    if (!defaultRoom) {
      await prisma.room.create({ data: { name: "General" } });
    }

    const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET);
    res.json({ token, user: { id: user.id, username: user.username } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Register failed" });
  }
});

app.post("/auth/login", async (req, res) => {
  const { username, password } = req.body;
  try {
    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) {
      return res.status(400).json({ error: "Invalid credentials" });
    }
    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      return res.status(400).json({ error: "Invalid credentials" });
    }
    const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET);
    res.json({ token, user: { id: user.id, username: user.username } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Login failed" });
  }
});

app.get("/rooms", async (req, res) => {
  const rooms = await prisma.room.findMany();
  res.json(rooms);
});

app.post("/rooms", async (req, res) => {
  const { name } = req.body;
  try {
    const room = await prisma.room.create({ data: { name } });
    res.json(room);
  } catch (error) {
    res.status(400).json({ error: "Room creation failed" });
  }
});

app.get("/rooms/:id/messages", async (req, res) => {
  const roomId = parseInt(req.params.id);
  const messages = await prisma.message.findMany({
    where: { roomId },
    include: { user: { select: { username: true } } },
    orderBy: { createdAt: "asc" },
  });
  res.json(messages);
});

// --- Socket.IO WebSockets ---

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error("Authentication error"));
  jwt.verify(token, JWT_SECRET, (err: any, decoded: any) => {
    if (err) return next(new Error("Authentication error"));
    (socket as any).user = decoded;
    next();
  });
});

io.on("connection", (socket) => {
  const s = socket as any;
  console.log(`User connected: ${s.user.username}`);

  socket.on("join_room", (roomId) => {
    socket.join(`room_${roomId}`);
    console.log(`${s.user.username} joined room_${roomId}`);
  });

  socket.on("send_message", async (data) => {
    const { roomId, content } = data;
    try {
      const message = await prisma.message.create({
        data: {
          content,
          roomId: Number(roomId),
          userId: s.user.userId,
        },
        include: {
          user: { select: { username: true } },
        },
      });

      io.to(`room_${roomId}`).emit("new_message", message);
    } catch (err) {
      console.error("Message save error", err);
    }
  });

  socket.on("disconnect", () => {
    console.log(`User disconnected: ${s.user.username}`);
  });
});

server.listen(PORT as number, "0.0.0.0", () => {
  console.log(`Backend server successfully listening on port ${PORT} (0.0.0.0)`);
});
