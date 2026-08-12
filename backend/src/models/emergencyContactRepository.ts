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
    await this.sql`
      DELETE FROM emergency_contacts WHERE user_id = ${userId} AND contact_id = ${contactId}
    `;
  }

  async recordAlertIfNew(userId: string, lastActivity: Date): Promise<boolean> {
    // Claimed in one statement. The previous SELECT-then-INSERT let a second
    // concurrent run pass the existence check and then fail on the
    // (user_id, last_activity_at) primary key with a unique violation, which
    // nothing handled.
    const rows = await this.sql<{ claimed: number }[]>`
      INSERT INTO emergency_alert_logs (user_id, last_activity_at)
      VALUES (${userId}, ${lastActivity})
      ON CONFLICT (user_id, last_activity_at) DO NOTHING
      RETURNING 1 as claimed
    `;
    return rows.length > 0;
  }

  /**
   * Hands the claim back so a later run can retry this `lastActivity` window.
   *
   * Only called when nothing durable reached a contact. Once even one alert is
   * persisted the claim must stand, or the retry would write a duplicate.
   */
  async releaseAlert(userId: string, lastActivity: Date): Promise<void> {
    await this.sql`
      DELETE FROM emergency_alert_logs
      WHERE user_id = ${userId} AND last_activity_at = ${lastActivity}
    `;
  }
}
