import { Pool } from "pg";
import type { IEmergencyContactRepository, EmergencyContact } from "./IEmergencyContactRepository";

export class EmergencyContactRepository implements IEmergencyContactRepository {
  constructor(private db: Pool) {}

  async findByUserId(userId: string): Promise<EmergencyContact[]> {
    const res = await this.db.query(
      `SELECT ec.*, u.name, u.email, u.avatar_url 
       FROM emergency_contacts ec
       JOIN users u ON ec.contact_id = u.user_id
       WHERE ec.user_id = $1`,
      [userId]
    );
    return res.rows.map(row => ({
      userId: row.user_id,
      contactId: row.contact_id,
      message: row.message,
      createdAt: row.created_at,
      contact: {
        name: row.name,
        email: row.email,
        avatarUrl: row.avatar_url ?? undefined
      }
    }));
  }

  async upsert(userId: string, contactId: string, message: string): Promise<{ contact: EmergencyContact, isUpdate: boolean }> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      const existingRes = await client.query(
        `SELECT user_id, contact_id, message, created_at
         FROM emergency_contacts
         WHERE user_id = $1 AND contact_id = $2`,
        [userId, contactId],
      );

      const isUpdate = (existingRes.rowCount ?? 0) > 0;
      if (isUpdate) {
        await client.query(
          `UPDATE emergency_contacts
           SET message = $3
           WHERE user_id = $1 AND contact_id = $2`,
          [userId, contactId, message],
        );
      } else {
        await client.query(
          `INSERT INTO emergency_contacts (user_id, contact_id, message)
           VALUES ($1, $2, $3)`,
          [userId, contactId, message],
        );
      }

      const contactRes = await client.query(
        `SELECT user_id, contact_id, message, created_at
         FROM emergency_contacts
         WHERE user_id = $1 AND contact_id = $2`,
        [userId, contactId],
      );

      await client.query('COMMIT');

      return {
        contact: {
          userId: contactRes.rows[0].user_id,
          contactId: contactRes.rows[0].contact_id,
          message: contactRes.rows[0].message,
          createdAt: contactRes.rows[0].created_at
        },
        isUpdate,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async delete(userId: string, contactId: string): Promise<void> {
    await this.db.query(
      "DELETE FROM emergency_contacts WHERE user_id = $1 AND contact_id = $2",
      [userId, contactId]
    );
  }

  async recordAlertIfNew(userId: string, lastActivity: Date): Promise<boolean> {
    const existingRes = await this.db.query(
      `SELECT 1
       FROM emergency_alert_logs
       WHERE user_id = $1 AND last_activity_at = $2`,
      [userId, lastActivity],
    );

    if ((existingRes.rowCount ?? 0) > 0) {
      return false;
    }

    await this.db.query(
      `INSERT INTO emergency_alert_logs (user_id, last_activity_at)
       VALUES ($1, $2)`,
      [userId, lastActivity],
    );
    return true;
  }
}
