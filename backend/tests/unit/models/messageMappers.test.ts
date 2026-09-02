import { describe, expect, it } from 'bun:test';
import {
  mapAttachmentRow,
  mapMessageChangeRow,
  mapMessageRow,
  mapMessageWithSenderRow,
  mapSnapshotAttachments,
  mapSnapshotMentions,
} from '../../../src/models/message/mappers';

describe('message mappers', () => {
  it('maps a message row while hiding recalled content and normalizing sequence values', () => {
    expect(mapMessageRow({
      message_id: 'message-1',
      room_id: 'room-1',
      sender_id: 'user-1',
      content: 'secret',
      is_recalled: true,
      sent_at: new Date('2026-01-01T00:00:00Z'),
      message_sequence: '7',
      change_sequence: '8',
      revision: 2,
    })).toMatchObject({
      messageId: 'message-1',
      roomId: 'room-1',
      content: '',
      messageSequence: 7,
      changeSequence: 8,
      revision: 2,
      isRecalled: true,
    });
  });

  it('maps deleted senders and only exposes relations for visible messages', () => {
    const row = {
      message_id: 'message-1',
      room_id: 'room-1',
      sender_id: 'user-1',
      content: 'hello',
      reply_to_id: null,
      is_recalled: false,
      sent_at: new Date('2026-01-01T00:00:00Z'),
      message_sequence: 1,
      change_sequence: 2,
      revision: 1,
      sender_user_id: 'user-1',
      sender_name: 'Alice',
      sender_avatar_url: null,
      sender_deleted_at: new Date('2026-01-02T00:00:00Z'),
      mentions: ['user-2'],
      attachments: [{
        attachment_id: 'attachment-1',
        message_id: 'message-1',
        uploaded_by: 'user-1',
        file_type: 'text/plain',
        original_name: 'note.txt',
        uploaded_at: '2026-01-01T00:00:00Z',
      }],
    };

    expect(mapMessageWithSenderRow(row)).toMatchObject({
      sender: { userId: 'user-1', name: 'Deleted User', avatarUrl: undefined },
      mentions: ['user-2'],
      attachments: [{
        attachmentId: 'attachment-1',
        messageId: 'message-1',
        fileUrl: '/api/v1/attachments/attachment-1',
      }],
    });

    expect(mapMessageWithSenderRow({ ...row, is_recalled: true })).not.toHaveProperty('attachments');
    expect(mapMessageWithSenderRow({ ...row, is_recalled: true })).not.toHaveProperty('mentions');
  });

  it('parses snapshot relations without throwing on malformed values', () => {
    expect(mapSnapshotMentions('{user-1, user-2}')).toEqual(['user-1', 'user-2']);
    expect(mapSnapshotMentions(['user-1', 42, null])).toEqual(['user-1']);
    expect(mapSnapshotMentions({})).toEqual([]);
    expect(mapSnapshotAttachments([
      { attachment_id: 'valid', file_type: 'image/png', original_name: 'a.png', uploaded_at: '2026-01-01T00:00:00Z' },
      { attachment_id: 'invalid' },
    ])).toHaveLength(1);
  });

  it('maps attachment rows to the public attachment shape', () => {
    expect(mapAttachmentRow({
      attachment_id: 'attachment-1',
      message_id: null,
      uploaded_by: null,
      file_type: 'text/plain',
      original_name: 'note.txt',
      uploaded_at: new Date('2026-01-01T00:00:00Z'),
    })).toEqual({
      attachmentId: 'attachment-1',
      messageId: undefined,
      uploadedBy: '',
      fileUrl: '/api/v1/attachments/attachment-1',
      fileType: 'text/plain',
      originalName: 'note.txt',
      uploadedAt: new Date('2026-01-01T00:00:00Z'),
    });
  });

  it('keeps historical snapshots masked when the current message is recalled', () => {
    const change = mapMessageChangeRow({
      message_id: 'message-1',
      room_id: 'room-1',
      sender_id: 'user-1',
      content: 'historical secret',
      reply_to_id: 'reply-1',
      is_recalled: false,
      current_is_recalled: true,
      sent_at: new Date('2026-01-01T00:00:00Z'),
      message_sequence: 1,
      change_sequence: 2,
      revision: 1,
      change_type: 'edited',
      sender_user_id: 'user-1',
      sender_name: 'Alice',
      sender_avatar_url: null,
      sender_deleted_at: null,
      mentions: ['user-2'],
      attachments: [{
        attachment_id: 'attachment-1',
        file_type: 'text/plain',
        original_name: 'secret.txt',
        uploaded_at: '2026-01-01T00:00:00Z',
      }],
    });

    expect(change.message).toMatchObject({
      content: '',
      isRecalled: true,
      mentions: [],
    });
    expect(change.message).not.toHaveProperty('attachments');
  });
});
