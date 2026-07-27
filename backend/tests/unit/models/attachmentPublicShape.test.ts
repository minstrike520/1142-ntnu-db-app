import { describe, it, expect } from 'bun:test';
import { toPublicAttachment, type InternalAttachment } from '../../../src/models/attachmentRepository';

const internal: InternalAttachment = {
  attachmentId: 'e4c08495-e224-4a67-b6dd-5958952d3d42',
  messageId: '22222222-2222-4222-8222-222222222222',
  uploadedBy: '11111111-1111-4111-8111-111111111111',
  fileUrl: '/api/v1/attachments/e4c08495-e224-4a67-b6dd-5958952d3d42',
  fileType: 'image/png',
  originalName: '報告.png',
  uploadedAt: new Date('2026-06-14T22:18:13Z'),
  filePath: '/app/uploads/attachments/1750000000_abcd1234_report.png',
  messageIsRecalled: false,
};

describe('toPublicAttachment', () => {
  it('drops the internal storage path', () => {
    const result = toPublicAttachment(internal);

    expect(result).not.toHaveProperty('filePath');
    expect(JSON.stringify(result)).not.toInclude('/app/uploads');
  });

  it('drops the internal recall flag', () => {
    expect(toPublicAttachment(internal)).not.toHaveProperty('messageIsRecalled');
  });

  it('preserves every documented public field', () => {
    expect(toPublicAttachment(internal)).toEqual({
      attachmentId: internal.attachmentId,
      messageId: internal.messageId,
      uploadedBy: internal.uploadedBy,
      fileUrl: internal.fileUrl,
      fileType: internal.fileType,
      originalName: internal.originalName,
      uploadedAt: internal.uploadedAt,
    });
  });

  it('keeps an unattached attachment usable', () => {
    const result = toPublicAttachment({ ...internal, messageId: undefined });

    expect(result.messageId).toBeUndefined();
    expect(result.attachmentId).toBe(internal.attachmentId);
  });
});
