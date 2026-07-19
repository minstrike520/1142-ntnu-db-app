import { Pool } from "pg";
import type { User } from "@shared/types";
import type { IUserRepository } from "./IUserRepository";

// ponytail: we keep the columns here in USER_COLUMNS select temporarily until we've run migration, or we can drop them now to be clean since they will be dropped from DB anyway.
// Wait, actually, let's keep them out of USER_COLUMNS so that we don't select them, and mapRowToUser doesn't map them.
// Let's rewrite it:
const USER_COLUMNS =
  'user_id, name, email, password_hash, bio, avatar_url, lang_preference, app_theme, ' +
  'notify_desktop, notify_sound, warning_enabled, warning_days, last_activity, created_at, deleted_at, room_order';

function mapRowToUser(row: any): User {
  return {
    userId: row.user_id,
    name: row.name,
    email: row.email,
    passwordHash: row.password_hash,
    bio: row.bio ?? undefined,
    avatarUrl: row.avatar_url ?? undefined,
    language: row.lang_preference,
    theme: row.app_theme ?? 'light',
    notifyDesktop: row.notify_desktop ?? true,
    notifySound: row.notify_sound ?? true,
    warningEnabled: row.warning_enabled,
    warningDays: row.warning_days,
    lastActivity: row.last_activity,
    createdAt: row.created_at,
    deletedAt: row.deleted_at ?? null,
    roomOrder: row.room_order ?? undefined,
  };
}

export class UserRepository implements IUserRepository {
  constructor(private db: Pool) {}

  async findById(userId: string): Promise<User | null> {
    const res = await this.db.query(
      `SELECT ${USER_COLUMNS} FROM users WHERE user_id = $1 AND deleted_at IS NULL`,
      [userId]
    );
    if (res.rows.length === 0) return null;
    return mapRowToUser(res.rows[0]);
  }

  async findByEmail(email: string): Promise<User | null> {
    const res = await this.db.query(
      `SELECT ${USER_COLUMNS} FROM users WHERE email = $1 AND deleted_at IS NULL`,
      [email]
    );
    if (res.rows.length === 0) return null;
    return mapRowToUser(res.rows[0]);
  }

  async search(query: string, mode?: 'name' | 'userId' | 'email'): Promise<User[]> {
    let res;
    if (mode === 'userId') {
      res = await this.db.query(
        `SELECT ${USER_COLUMNS} FROM users WHERE user_id::text = $1 AND deleted_at IS NULL LIMIT 20`,
        [query]
      );
    } else if (mode === 'email') {
      res = await this.db.query(
        `SELECT ${USER_COLUMNS} FROM users WHERE email = $1 AND deleted_at IS NULL LIMIT 20`,
        [query]
      );
    } else if (mode === 'name') {
      res = await this.db.query(
        `SELECT ${USER_COLUMNS} FROM users WHERE LOWER(name) LIKE LOWER($1) AND deleted_at IS NULL LIMIT 20`,
        [`%${query}%`]
      );
    } else {
      // Legacy: combined search across name, user_id, and email
      res = await this.db.query(
        `SELECT ${USER_COLUMNS} FROM users WHERE (LOWER(name) LIKE LOWER($1) OR user_id::text = $2 OR LOWER(email) LIKE LOWER($1)) AND deleted_at IS NULL LIMIT 20`,
        [`%${query}%`, query]
      );
    }
    return res.rows.map(mapRowToUser);
  }

  async findAllWarningEnabled(): Promise<{ userId: string; lastActivity: Date; warningDays: number }[]> {
    const res = await this.db.query(
      `SELECT user_id, last_activity, warning_days FROM users WHERE warning_enabled = true AND deleted_at IS NULL`
    );
    return res.rows.map(row => ({
      userId: row.user_id,
      lastActivity: row.last_activity,
      warningDays: row.warning_days,
    }));
  }


  async create(data: { name: string; email: string; passwordHash: string }): Promise<User> {
    const res = await this.db.query(
      `INSERT INTO users (name, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING ${USER_COLUMNS}`,
      [data.name, data.email, data.passwordHash]
    );
    return mapRowToUser(res.rows[0]);
  }

  async update(
    userId: string,
    data: Partial<
      Pick<
        User,
        | "name"
        | "email"
        | "passwordHash"
        | "bio"
        | "avatarUrl"
        | "language"
        | "theme"
        | "notifyDesktop"
        | "notifySound"
        | "warningEnabled"
        | "warningDays"
        | "lastActivity"
        | "deletedAt"
        | "roomOrder"
      >
    >,
  ): Promise<User> {
    const fields: string[] = [];
    const values: any[] = [];
    let queryIdx = 1;

    if (data.name !== undefined) {
      fields.push(`name = $${queryIdx++}`);
      values.push(data.name);
    }
    if (data.email !== undefined) {
      fields.push(`email = $${queryIdx++}`);
      values.push(data.email);
    }
    if (data.passwordHash !== undefined) {
      fields.push(`password_hash = $${queryIdx++}`);
      values.push(data.passwordHash);
    }
    if (data.bio !== undefined) {
      fields.push(`bio = $${queryIdx++}`);
      values.push(data.bio);
    }
    if (data.avatarUrl !== undefined) {
      fields.push(`avatar_url = $${queryIdx++}`);
      values.push(data.avatarUrl);
    }
    if (data.language !== undefined) {
      fields.push(`lang_preference = $${queryIdx++}`);
      values.push(data.language);
    }
    if (data.theme !== undefined) {
      fields.push(`app_theme = $${queryIdx++}`);
      values.push(data.theme);
    }
    if (data.notifyDesktop !== undefined) {
      fields.push(`notify_desktop = $${queryIdx++}`);
      values.push(data.notifyDesktop);
    }
    if (data.notifySound !== undefined) {
      fields.push(`notify_sound = $${queryIdx++}`);
      values.push(data.notifySound);
    }
    if (data.warningEnabled !== undefined) {
      fields.push(`warning_enabled = $${queryIdx++}`);
      values.push(data.warningEnabled);
    }
    if (data.warningDays !== undefined) {
      fields.push(`warning_days = $${queryIdx++}`);
      values.push(data.warningDays);
    }
    if (data.lastActivity !== undefined) {
      fields.push(`last_activity = $${queryIdx++}`);
      values.push(data.lastActivity);
    }

    if (data.deletedAt !== undefined) {
      fields.push(`deleted_at = $${queryIdx++}`);
      values.push(data.deletedAt);
    }
    if (data.roomOrder !== undefined) {
      fields.push(`room_order = $${queryIdx++}`);
      values.push(JSON.stringify(data.roomOrder));
    }

    if (fields.length === 0) {
      const res = await this.db.query(
        `SELECT ${USER_COLUMNS} FROM users WHERE user_id = $1`,
        [userId]
      );
      if (res.rows.length === 0) {
        throw new Error("User not found");
      }
      return mapRowToUser(res.rows[0]);
    }

    values.push(userId);
    const query = `
      UPDATE users
      SET ${fields.join(", ")}
      WHERE user_id = $${queryIdx}
      RETURNING ${USER_COLUMNS}
    `;
    const res = await this.db.query(query, values);
    if (res.rows.length === 0) {
        throw new Error("User not found");
    }
    return mapRowToUser(res.rows[0]);
  }

  async delete(userId: string): Promise<void> {
    await this.db.query("DELETE FROM users WHERE user_id = $1", [userId]);
  }
}
