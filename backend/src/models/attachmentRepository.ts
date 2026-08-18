import { SQL } from "bun";
import defaultSql from "./db";
import type { Attachment } from "@shared/types";

export interface AttachmentRow {
  attachment_id: string;
  message_id?: string | null;
  uploaded_by: string;
  file_path: string;
  file_type: string;
  original_name: string;
  uploaded_at: Date;
  message_is_recalled?: boolean | null;
}

/** Server-side view of an attachment: the public shape plus internal-only fields. */
export type InternalAttachment = Attachment & {
  messageIsRecalled?: boolean;
  filePath?: string;
};

/**
 * Drop the internal fields before an attachment is serialized to a client.
 *
 * `filePath` is the absolute on-disk location (`/app/uploads/...`) and must never
 * reach the API; excess properties are not stripped at runtime just because the
 * declared return type is `Attachment`.
 */
export const toPublicAttachment = (attachment: InternalAttachment): Attachment => ({
  attachmentId: attachment.attachmentId,
  messageId: attachment.messageId,
  uploadedBy: attachment.uploadedBy,
  fileUrl: attachment.fileUrl,
  fileType: attachment.fileType,
  originalName: attachment.originalName,
  uploadedAt: attachment.uploadedAt,
});

function mapRowToAttachment(row: AttachmentRow): InternalAttachment {
  return {
    attachmentId: row.attachment_id,
    messageId: row.message_id ?? undefined,
    uploadedBy: row.uploaded_by,
    fileUrl: `/api/v1/attachments/${row.attachment_id}`,
    fileType: row.file_type,
    originalName: row.original_name,
    uploadedAt: row.uploaded_at,
    filePath: row.file_path,
    messageIsRecalled: row.message_is_recalled ?? undefined,
  };
}

export class AttachmentRepository {
  constructor(private readonly sql: SQL = defaultSql) {}

  async create(data: { uploadedBy: string, filePath: string, fileType: string, originalName: string }): Promise<Attachment> {
    const rows = await this.sql<AttachmentRow[]>`
      INSERT INTO attachments (uploaded_by, file_path, file_type, original_name)
      VALUES (${data.uploadedBy}, ${data.filePath}, ${data.fileType}, ${data.originalName})
      RETURNING *
    `;
    // Public shape only: the upload response must not carry the storage path.
    return toPublicAttachment(mapRowToAttachment(rows[0]));
  }

  async findById(attachmentId: string): Promise<InternalAttachment | null> {
    const rows = await this.sql<AttachmentRow[]>`
      SELECT a.*, m.is_recalled AS message_is_recalled
      FROM attachments a
      LEFT JOIN messages m ON m.message_id = a.message_id
      WHERE a.attachment_id = ${attachmentId}
    `;
    return rows.length === 0 ? null : mapRowToAttachment(rows[0]);
  }

  async findByIdForUser(attachmentId: string, userId: string): Promise<InternalAttachment | null> {
    const rows = await this.sql<AttachmentRow[]>`
      SELECT a.*, m.is_recalled AS message_is_recalled
      FROM attachments a
      LEFT JOIN messages m ON m.message_id = a.message_id
      WHERE a.attachment_id = ${attachmentId}
        AND (
          (a.message_id IS NULL AND a.uploaded_by = ${userId})
          OR EXISTS (
            SELECT 1
            FROM room_members rm
            JOIN chat_rooms cr ON cr.room_id = rm.room_id
            WHERE rm.room_id = m.room_id
              AND rm.user_id = ${userId}
              AND rm.role <> 'pending'
              AND (
                cr.view_history
                OR m.message_sequence > rm.join_boundary
                OR (m.message_sequence = 0 AND m.sent_at >= rm.join_time)
              )
              AND NOT (
                cr.type = 'private'
                AND EXISTS (
                  SELECT 1
                  FROM room_members other
                  JOIN blocks b ON (
                    (b.blocker_id = ${userId} AND b.blocked_id = other.user_id)
                    OR (b.blocker_id = other.user_id AND b.blocked_id = ${userId})
                  )
                  WHERE other.room_id = rm.room_id
                    AND other.user_id <> ${userId}
                    AND other.role <> 'pending'
                )
              )
          )
        )
    `;
    return rows.length === 0 ? null : mapRowToAttachment(rows[0]);
  }
}
