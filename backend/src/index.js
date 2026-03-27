import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { initDb, pool } from "./db.js";
import { authRouter } from "./routes/auth.js";
import { roomsRouter } from "./routes/rooms.js";
import { messagesRouter } from "./routes/messages.js";
import { requireAuth } from "./middleware/auth.js";

const app = express();

app.use(
  cors({
    origin: true,
    credentials: false,
  })
);
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "backend", env: config.nodeEnv });
});

app.use("/auth", authRouter);
app.use("/rooms", requireAuth, roomsRouter);
app.use("/", requireAuth, messagesRouter);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "internal server error" });
});

async function start() {
  await initDb();

  app.listen(config.port, "0.0.0.0", () => {
    console.log(`Backend listening on http://0.0.0.0:${config.port}`);
  });
}

start().catch((error) => {
  console.error("Failed to start server:", error);
  pool.end().finally(() => process.exit(1));
});
