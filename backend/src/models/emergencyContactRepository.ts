import { SQL } from "bun";
import defaultSql from "./db";
import type { IEmergencyContactRepository, EmergencyContact } from "./IEmergencyContactRepository";

export interface EmergencyContactRow {
  user_id: string;
  contact_id: string;
  message: string;
  created_at: Date;
  name?: string;
  email?: string;
  avatar_url?: string | null;
}

export class EmergencyContactRepository implements IEmergencyContactRepository {
  constructor(private sql: SQL = defaultSql) {}

  private readonly contactLocks = new Map<string, Promise<void>>();

  private contactLockKey(userId: string, contactId: string): string {
    return [userId, contactId].sort().join(':');
  }

  async findByUserId(userId: string): Promise<EmergencyContact[]> {
    const rows = await this.sql<EmergencyContactRow[]>`
      SELECT ec.*, u.name, u.email, u.avatar_url 
      FROM emergency_contacts ec
      JOIN users u ON ec.contact_id = u.user_id
      WHERE ec.user_id = ${userId}
    `;
    return rows.map(row => ({
      userId: row.user_id,
      contactId: row.contact_id,
      message: row.message,
      createdAt: row.created_at,
      contact: {
        name: row.name!,
        email: row.email!,
        avatarUrl: row.avatar_url ?? undefined
      }
    }));
  }

  async upsert(userId: string, contactId: string, message: string): Promise<{ contact: EmergencyContact, isUpdate: boolean }> {
    let result: { contact: EmergencyContact; isUpdate: boolean } | null = null;

    await this.sql.begin(async (tx) => {
      await tx`
        SELECT pg_advisory_xact_lock(hashtextextended(${this.contactLockKey(userId, contactId)}, 2))
      `;
      const existingRes = await tx<EmergencyContactRow[]>`
        SELECT user_id, contact_id, message, created_at
        FROM emergency_contacts
        WHERE user_id = ${userId} AND contact_id = ${contactId}
      `;

      const isUpdate = existingRes.length > 0;
      if (isUpdate) {
        await tx`
          UPDATE emergency_contacts
          SET message = ${message}
          WHERE user_id = ${userId} AND contact_id = ${contactId}
        `;
      } else {
        await tx`
          INSERT INTO emergency_contacts (user_id, contact_id, message)
          VALUES (${userId}, ${contactId}, ${message})
        `;
      }

      const contactRes = await tx<EmergencyContactRow[]>`
        SELECT ec.user_id, ec.contact_id, ec.message, ec.created_at, u.name, u.email, u.avatar_url
        FROM emergency_contacts ec
        JOIN users u ON u.user_id = ec.contact_id
        WHERE ec.user_id = ${userId} AND ec.contact_id = ${contactId}
      `;

      result = {
        contact: {
          userId: contactRes[0].user_id,
          contactId: contactRes[0].contact_id,
          message: contactRes[0].message,
          createdAt: contactRes[0].created_at,
          contact: {
            name: contactRes[0].name!,
            email: contactRes[0].email!,
            avatarUrl: contactRes[0].avatar_url ?? undefined
          }
        },
        isUpdate,
      };
    });

    return result!;
  }

  async delete(userId: string, contactId: string): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`
        SELECT pg_advisory_xact_lock(hashtextextended(${this.contactLockKey(userId, contactId)}, 2))
      `;
      await tx`
        DELETE FROM emergency_contacts WHERE user_id = ${userId} AND contact_id = ${contactId}
      `;
    });
  }

  async withContactLock<T>(userId: string, contactId: string, operation: () => Promise<T>): Promise<T> {
    const key = this.contactLockKey(userId, contactId);
    const prior = this.contactLocks.get(key);
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.contactLocks.set(key, current);
    if (prior) await prior;
    try {
      return await operation();
    } finally {
      release();
      if (this.contactLocks.get(key) === current) this.contactLocks.delete(key);
    }
  }

  async recordAlertIfNew(userId: string, lastActivity: Date): Promise<boolean> {
    const leaseMinutes = 5;
    const inserted = await this.sql<{ user_id: string }[]>`
      INSERT INTO emergency_alert_logs (user_id, last_activity_at, delivery_status, lease_until)
      VALUES (${userId}, ${lastActivity}, 'pending', NOW() + ${leaseMinutes} * INTERVAL '1 minute')
      ON CONFLICT (user_id, last_activity_at) DO NOTHING
      RETURNING user_id
    `;
    if (inserted.length > 0) return true;

    const reclaimed = await this.sql<{ user_id: string }[]>`
      UPDATE emergency_alert_logs
      SET delivery_status = 'pending',
          lease_until = NOW() + ${leaseMinutes} * INTERVAL '1 minute'
      WHERE user_id = ${userId}
        AND last_activity_at = ${lastActivity}
        AND delivery_status = 'pending'
        AND lease_until < NOW()
      RETURNING user_id
    `;
    return reclaimed.length > 0;
  }

  async releaseAlertIfNew(userId: string, lastActivity: Date): Promise<void> {
    await this.sql`
      DELETE FROM emergency_alert_logs
      WHERE user_id = ${userId}
        AND last_activity_at = ${lastActivity}
        AND delivery_status = 'pending'
    `;
  }

  async completeAlert(userId: string, lastActivity: Date): Promise<void> {
    await this.sql`
      UPDATE emergency_alert_logs
      SET delivery_status = 'completed', lease_until = NULL
      WHERE user_id = ${userId} AND last_activity_at = ${lastActivity}
    `;
  }
}
