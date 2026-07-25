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

function mapRowToAttachment(row: AttachmentRow): Attachment & { messageIsRecalled?: boolean, filePath?: string } {
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
    return mapRowToAttachment(rows[0]);
  }

  async findById(attachmentId: string): Promise<(Attachment & { messageIsRecalled?: boolean, filePath?: string }) | null> {
    const rows = await this.sql<AttachmentRow[]>`
      SELECT a.*, m.is_recalled AS message_is_recalled
      FROM attachments a
      LEFT JOIN messages m ON m.message_id = a.message_id
      WHERE a.attachment_id = ${attachmentId}
    `;
    return rows.length === 0 ? null : mapRowToAttachment(rows[0]);
  }
}
