import express from "express";
import { query } from "../db.js";

export const messagesRouter = express.Router();

messagesRouter.get("/rooms/:roomId/messages", async (req, res) => {
  const roomId = Number(req.params.roomId);
  const limit = Math.min(Number(req.query.limit || 50), 200);

  if (!Number.isInteger(roomId)) {
    return res.status(400).json({ error: "invalid room id" });
  }

  const membership = await query(
    `
      SELECT 1 FROM room_members
      WHERE room_id = $1 AND user_id = $2
    `,
    [roomId, req.user.id]
  );

  if (!membership.rows.length) {
    return res.status(403).json({ error: "join room first" });
  }

  const result = await query(
    `
      SELECT m.id, m.content, m.created_at, u.id AS user_id, u.username
      FROM messages m
      JOIN users u ON u.id = m.user_id
      WHERE m.room_id = $1
      ORDER BY m.created_at DESC
      LIMIT $2
    `,
    [roomId, limit]
  );

  return res.json(result.rows.reverse());
});

messagesRouter.post("/rooms/:roomId/messages", async (req, res) => {
  const roomId = Number(req.params.roomId);
  const content = (req.body.content || "").trim();

  if (!Number.isInteger(roomId)) {
    return res.status(400).json({ error: "invalid room id" });
  }

  if (!content) {
    return res.status(400).json({ error: "message content is required" });
  }

  const membership = await query(
    `
      SELECT 1 FROM room_members
      WHERE room_id = $1 AND user_id = $2
    `,
    [roomId, req.user.id]
  );

  if (!membership.rows.length) {
    return res.status(403).json({ error: "join room first" });
  }

  const result = await query(
    `
      INSERT INTO messages (room_id, user_id, content)
      VALUES ($1, $2, $3)
      RETURNING id, room_id, user_id, content, created_at
    `,
    [roomId, req.user.id, content]
  );

  return res.status(201).json(result.rows[0]);
});
