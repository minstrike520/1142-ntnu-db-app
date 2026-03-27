import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { query } from "../db.js";
import { config } from "../config.js";

export const authRouter = express.Router();

authRouter.post("/register", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password || password.length < 6) {
    return res
      .status(400)
      .json({ error: "username and password(>=6) are required" });
  }

  const passwordHash = await bcrypt.hash(password, 10);

  try {
    const result = await query(
      `
        INSERT INTO users (username, password_hash)
        VALUES ($1, $2)
        RETURNING id, username, created_at
      `,
      [username, passwordHash]
    );

    return res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "username already exists" });
    }
    return res.status(500).json({ error: "failed to register" });
  }
});

authRouter.post("/login", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "username and password are required" });
  }

  const userResult = await query(
    `SELECT id, username, password_hash FROM users WHERE username = $1`,
    [username]
  );

  if (!userResult.rows.length) {
    return res.status(401).json({ error: "invalid credentials" });
  }

  const user = userResult.rows[0];
  const ok = await bcrypt.compare(password, user.password_hash);

  if (!ok) {
    return res.status(401).json({ error: "invalid credentials" });
  }

  const token = jwt.sign(
    {
      id: user.id,
      username: user.username,
    },
    config.jwtSecret,
    { expiresIn: "24h" }
  );

  return res.json({ token, user: { id: user.id, username: user.username } });
});
