import { SQL } from "bun";
import defaultSql from "./db";
import type { User } from "@shared/types";
import type { IUserRepository } from "./IUserRepository";

export interface UserRow {
  user_id: string;
  name: string;
  email: string;
  password_hash: string;
  bio?: string | null;
  avatar_url?: string | null;
  lang_preference: string;
  app_theme: string;
  notify_desktop: boolean;
  notify_sound: boolean;
  warning_enabled: boolean;
  warning_days: number;
  last_activity: Date;
  created_at: Date;
  deleted_at?: Date | null;
  room_order?: any;
}

function mapRowToUser(row: UserRow): User {
  return {
    userId: row.user_id,
    name: row.name,
    email: row.email,
    passwordHash: row.password_hash,
    bio: row.bio ?? undefined,
    avatarUrl: row.avatar_url ?? undefined,
    language: row.lang_preference,
    theme: (row.app_theme as 'light' | 'dark') ?? 'light',
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
  constructor(private sql: SQL = defaultSql) {}

  async findById(userId: string): Promise<User | null> {
    const rows = await this.sql<UserRow[]>`
      SELECT * FROM users WHERE user_id = ${userId} AND deleted_at IS NULL
    `;
    if (rows.length === 0) return null;
    return mapRowToUser(rows[0]);
  }

  async findByEmail(email: string): Promise<User | null> {
    const rows = await this.sql<UserRow[]>`
      SELECT * FROM users WHERE email = ${email} AND deleted_at IS NULL
    `;
    if (rows.length === 0) return null;
    return mapRowToUser(rows[0]);
  }

  async search(query: string, mode?: 'name' | 'userId' | 'email'): Promise<User[]> {
    let rows: UserRow[];
    if (mode === 'userId') {
      rows = await this.sql<UserRow[]>`
        SELECT * FROM users WHERE user_id::text = ${query} AND deleted_at IS NULL LIMIT 20
      `;
    } else if (mode === 'email') {
      rows = await this.sql<UserRow[]>`
        SELECT * FROM users WHERE email = ${query} AND deleted_at IS NULL LIMIT 20
      `;
    } else if (mode === 'name') {
      const pattern = `%${query}%`;
      rows = await this.sql<UserRow[]>`
        SELECT * FROM users WHERE LOWER(name) LIKE LOWER(${pattern}) AND deleted_at IS NULL LIMIT 20
      `;
    } else {
      const pattern = `%${query}%`;
      rows = await this.sql<UserRow[]>`
        SELECT * FROM users
        WHERE (LOWER(name) LIKE LOWER(${pattern}) OR user_id::text = ${query} OR LOWER(email) LIKE LOWER(${pattern}))
          AND deleted_at IS NULL
        LIMIT 20
      `;
    }
    return rows.map(mapRowToUser);
  }

  async findAllWarningEnabled(): Promise<{ userId: string; lastActivity: Date; warningDays: number }[]> {
    interface WarningRow {
      user_id: string;
      last_activity: Date;
      warning_days: number;
    }
    const rows = await this.sql<WarningRow[]>`
      SELECT user_id, last_activity, warning_days FROM users WHERE warning_enabled = true AND deleted_at IS NULL
    `;
    return rows.map(row => ({
      userId: row.user_id,
      lastActivity: row.last_activity,
      warningDays: row.warning_days,
    }));
  }

  async create(data: { name: string; email: string; passwordHash: string }): Promise<User> {
    const rows = await this.sql<UserRow[]>`
      INSERT INTO users (name, email, password_hash)
      VALUES (${data.name}, ${data.email}, ${data.passwordHash})
      RETURNING *
    `;
    return mapRowToUser(rows[0]);
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
    let idx = 1;

    if (data.name !== undefined) { fields.push(`name = $${idx++}`); values.push(data.name); }
    if (data.email !== undefined) { fields.push(`email = $${idx++}`); values.push(data.email); }
    if (data.passwordHash !== undefined) { fields.push(`password_hash = $${idx++}`); values.push(data.passwordHash); }
    if (data.bio !== undefined) { fields.push(`bio = $${idx++}`); values.push(data.bio); }
    if (data.avatarUrl !== undefined) { fields.push(`avatar_url = $${idx++}`); values.push(data.avatarUrl); }
    if (data.language !== undefined) { fields.push(`lang_preference = $${idx++}`); values.push(data.language); }
    if (data.theme !== undefined) { fields.push(`app_theme = $${idx++}`); values.push(data.theme); }
    if (data.notifyDesktop !== undefined) { fields.push(`notify_desktop = $${idx++}`); values.push(data.notifyDesktop); }
    if (data.notifySound !== undefined) { fields.push(`notify_sound = $${idx++}`); values.push(data.notifySound); }
    if (data.warningEnabled !== undefined) { fields.push(`warning_enabled = $${idx++}`); values.push(data.warningEnabled); }
    if (data.warningDays !== undefined) { fields.push(`warning_days = $${idx++}`); values.push(data.warningDays); }
    if (data.lastActivity !== undefined) { fields.push(`last_activity = $${idx++}`); values.push(data.lastActivity); }
    if (data.deletedAt !== undefined) { fields.push(`deleted_at = $${idx++}`); values.push(data.deletedAt); }
    if (data.roomOrder !== undefined) { fields.push(`room_order = $${idx++}`); values.push(JSON.stringify(data.roomOrder)); }

    if (fields.length === 0) {
      const rows = await this.sql<UserRow[]>`SELECT * FROM users WHERE user_id = ${userId}`;
      if (rows.length === 0) throw new Error("User not found");
      return mapRowToUser(rows[0]);
    }

    values.push(userId);
    const rows = await (this.sql as any).unsafe(
      `UPDATE users SET ${fields.join(', ')} WHERE user_id = $${idx} RETURNING *`,
      values
    ) as UserRow[];

    if (rows.length === 0) {
      throw new Error("User not found");
    }
    return mapRowToUser(rows[0]);
  }

  async delete(userId: string): Promise<void> {
    await this.sql`DELETE FROM users WHERE user_id = ${userId}`;
  }
}
