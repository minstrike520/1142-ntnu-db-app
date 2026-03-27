import express from "express";
import { query } from "../db.js";

export const roomsRouter = express.Router();

roomsRouter.get("/", async (_req, res) => {
  const result = await query(
    `
      SELECT r.id, r.name, r.created_at, u.username AS created_by
      FROM rooms r
      JOIN users u ON u.id = r.created_by
      ORDER BY r.id ASC
    `
  );

  return res.json(result.rows);
});

roomsRouter.post("/", async (req, res) => {
  const { name } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: "room name is required" });
  }

  try {
    const roomResult = await query(
      `
        INSERT INTO rooms (name, created_by)
        VALUES ($1, $2)
        RETURNING id, name, created_at
      `,
      [name.trim(), req.user.id]
    );

    await query(
      `
        INSERT INTO room_members (room_id, user_id)
        VALUES ($1, $2)
        ON CONFLICT DO NOTHING
      `,
      [roomResult.rows[0].id, req.user.id]
    );

    return res.status(201).json(roomResult.rows[0]);
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "room name already exists" });
    }
    return res.status(500).json({ error: "failed to create room" });
  }
});

roomsRouter.post("/:roomId/join", async (req, res) => {
  const roomId = Number(req.params.roomId);

  if (!Number.isInteger(roomId)) {
    return res.status(400).json({ error: "invalid room id" });
  }

  const exists = await query(`SELECT id FROM rooms WHERE id = $1`, [roomId]);
  if (!exists.rows.length) {
    return res.status(404).json({ error: "room not found" });
  }

  await query(
    `
      INSERT INTO room_members (room_id, user_id)
      VALUES ($1, $2)
      ON CONFLICT DO NOTHING
    `,
    [roomId, req.user.id]
  );

  return res.json({ roomId, joined: true });
});
