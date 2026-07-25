import type { UploadedFile } from '../../../src/utils/fileUpload';
import { describe, it, expect, beforeEach, mock, type Mock } from 'bun:test';
import { makeAttachmentService } from '../../../src/services/attachmentService';

describe('AttachmentService', () => {
  let attachmentRepo: { create: Mock<any>; findById: Mock<any> };
  let service: ReturnType<typeof makeAttachmentService>;

  beforeEach(() => {
    attachmentRepo = {
      create: mock(),
      findById: mock(),
    };
    service = makeAttachmentService(attachmentRepo as any);
  });

  it('normalizes mojibake original filenames before persisting', async () => {
    attachmentRepo.create.mockResolvedValue({
      attachment_id: 'att-1',
      uploaded_by: 'user-1',
      file_type: 'application/pdf',
      original_name: '運算思維與程式設計平台 多個頁點.pdf',
      uploaded_at: new Date('2026-01-01T00:00:00.000Z'),
    });

    await service.uploadAttachment('user-1', {
      path: '/tmp/file.pdf',
      mimetype: 'application/pdf',
      originalname: 'éç®æç¶­èç¨å¼è¨­è¨å¹³å° å¤åé é».pdf',
    } as UploadedFile);

    expect(attachmentRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        originalName: '運算思維與程式設計平台 多個頁點.pdf',
      }),
    );
  });

  it('getAttachment returns null when the parent message has been recalled', async () => {
    attachmentRepo.findById.mockResolvedValue({
      attachmentId: 'att-1',
      messageId: 'msg-1',
      uploadedBy: 'user-1',
      fileUrl: '/api/v1/attachments/att-1',
      fileType: 'application/pdf',
      originalName: 'doc.pdf',
      uploadedAt: new Date(),
      messageIsRecalled: true,
    });

    await expect(service.getAttachment('att-1')).resolves.toBeNull();
  });

  it('getAttachment returns the attachment when the parent message has not been recalled', async () => {
    const attachment = {
      attachmentId: 'att-1',
      messageId: 'msg-1',
      uploadedBy: 'user-1',
      fileUrl: '/api/v1/attachments/att-1',
      fileType: 'application/pdf',
      originalName: 'doc.pdf',
      uploadedAt: new Date(),
      messageIsRecalled: false,
    };
    attachmentRepo.findById.mockResolvedValue(attachment);

    await expect(service.getAttachment('att-1')).resolves.toEqual(attachment);
  });

  it('getAttachment returns the attachment when it is not yet linked to any message', async () => {
    const attachment = {
      attachmentId: 'att-1',
      messageId: undefined,
      uploadedBy: 'user-1',
      fileUrl: '/api/v1/attachments/att-1',
      fileType: 'application/pdf',
      originalName: 'doc.pdf',
      uploadedAt: new Date(),
      messageIsRecalled: undefined,
    };
    attachmentRepo.findById.mockResolvedValue(attachment);

    await expect(service.getAttachment('att-1')).resolves.toEqual(attachment);
  });

  it('getAttachment returns null when the attachment does not exist', async () => {
    attachmentRepo.findById.mockResolvedValue(null);

    await expect(service.getAttachment('missing')).resolves.toBeNull();
  });
});
