import type { Attachment, Message, MessageChange, MessageWithSender } from '@shared/types';

export interface MessageRow {
  message_id: string;
  room_id: string;
  sender_id: string | null;
  content: string;
  reply_to_id?: string | null;
  is_recalled: boolean;
  sent_at: Date;
  message_sequence: number | string;
  change_sequence: number | string;
  revision: number;
  command_id?: string | null;
}

export interface MessageWithSenderRow extends MessageRow {
  sender_user_id?: string | null;
  sender_name?: string | null;
  sender_avatar_url?: string | null;
  sender_deleted_at?: Date | null;
}

export interface MentionRow {
  message_id: string;
  user_id: string;
}

export interface AttachmentRow {
  attachment_id: string;
  message_id?: string | null;
  uploaded_by: string | null;
  file_type: string;
  original_name: string;
  uploaded_at: Date;
}

export type AttachmentSnapshotRow = Omit<AttachmentRow, 'message_id'>;

type MessageChangeRelationRow = {
  attachment_id?: string;
  message_id?: string | null;
  uploaded_by?: string | null;
  file_type?: string;
  original_name?: string;
  uploaded_at?: string | Date;
};

export interface MessageChangeRow extends MessageWithSenderRow {
  change_type: MessageChange['changeType'];
  current_is_recalled?: boolean;
  mentions?: unknown;
  attachments?: unknown;
}

export function mapAttachmentRow(row: AttachmentRow): Attachment {
  return {
    attachmentId: row.attachment_id,
    messageId: row.message_id ?? undefined,
    uploadedBy: row.uploaded_by ?? '',
    fileUrl: `/api/v1/attachments/${row.attachment_id}`,
    fileType: row.file_type,
    originalName: row.original_name,
    uploadedAt: row.uploaded_at,
  };
}

export function mapSnapshotAttachments(value: unknown): Attachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as MessageChangeRelationRow;
    if (!row.attachment_id || !row.file_type || !row.original_name || !row.uploaded_at) return [];
    return [mapAttachmentRow({
      attachment_id: row.attachment_id,
      message_id: row.message_id,
      uploaded_by: row.uploaded_by ?? null,
      file_type: row.file_type,
      original_name: row.original_name,
      uploaded_at: new Date(row.uploaded_at),
    })];
  });
}

export function mapSnapshotMentions(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((userId): userId is string => typeof userId === 'string');
  }
  if (typeof value !== 'string' || value.length < 2) return [];
  return value
    .slice(1, -1)
    .split(',')
    .map((userId) => userId.trim())
    .filter(Boolean);
}

export function mapMessageRow(row: MessageRow): Message {
  return {
    messageId: row.message_id,
    roomId: row.room_id,
    senderId: row.sender_id,
    content: row.is_recalled ? '' : row.content,
    replyToId: row.reply_to_id ?? undefined,
    isRecalled: row.is_recalled,
    sentAt: row.sent_at,
    messageSequence: Number(row.message_sequence ?? 0),
    changeSequence: Number(row.change_sequence ?? 0),
    revision: Number(row.revision ?? 1),
  };
}

export function mapMessageWithSenderRow(row: MessageWithSenderRow & {
  mentions?: unknown;
  attachments?: unknown;
}): MessageWithSender {
  const isDeleted = row.sender_deleted_at !== null && row.sender_deleted_at !== undefined;
  const message: MessageWithSender = {
    ...mapMessageRow(row),
    sender: row.sender_user_id
      ? isDeleted
        ? { userId: row.sender_user_id, name: 'Deleted User', avatarUrl: undefined }
        : {
            userId: row.sender_user_id,
            name: row.sender_name!,
            avatarUrl: row.sender_avatar_url ?? undefined,
          }
      : null,
  };
  if (!row.is_recalled) {
    const attachments = Array.isArray(row.attachments)
      ? mapSnapshotAttachments(row.attachments)
      : [];
    if (attachments.length > 0) message.attachments = attachments;
    if (row.mentions !== undefined) message.mentions = mapSnapshotMentions(row.mentions);
  }
  return message;
}

export interface MessageSnapshotRow {
  content: string;
  reply_to_id?: string | null;
  is_recalled: boolean;
  sent_at: Date;
  message_sequence: number | string;
  change_sequence: number | string;
  revision: number;
  mentions?: unknown;
  attachments?: unknown;
}

export function applyMessageSnapshot(
  message: MessageWithSender,
  snapshot: MessageSnapshotRow & { current_is_recalled?: boolean },
): MessageWithSender {
  const isRecalled = snapshot.is_recalled || snapshot.current_is_recalled === true;
  return {
    ...message,
    content: isRecalled ? '' : snapshot.content,
    replyToId: snapshot.reply_to_id ?? undefined,
    isRecalled,
    sentAt: snapshot.sent_at,
    messageSequence: Number(snapshot.message_sequence),
    changeSequence: Number(snapshot.change_sequence),
    revision: Number(snapshot.revision),
    mentions: isRecalled ? [] : mapSnapshotMentions(snapshot.mentions),
    attachments: isRecalled ? undefined : mapSnapshotAttachments(snapshot.attachments),
  };
}

export function mapMessageChangeRow(row: MessageChangeRow): MessageChange {
  const base = mapMessageWithSenderRow({
    ...row,
    is_recalled: false,
    mentions: undefined,
    attachments: undefined,
  });
  const message = applyMessageSnapshot(base, row);
  return {
    changeSequence: Number(row.change_sequence),
    messageSequence: Number(row.message_sequence),
    revision: Number(row.revision),
    changeType: row.change_type,
    message,
  };
}
