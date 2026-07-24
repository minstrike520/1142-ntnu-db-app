import type { UploadedFile } from '../utils/fileUpload';
import { ValidationError } from '../utils/AppError';
import { AttachmentRepository } from '../models/attachmentRepository';
import type { Attachment } from '@shared/types';

const containsEastAsianChars = (value: string) => /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(value);

const normalizeOriginalFilename = (filename: string) => {
  const decoded = Buffer.from(filename, 'latin1').toString('utf8');

  if (containsEastAsianChars(decoded) && !containsEastAsianChars(filename)) {
    return decoded;
  }

  return filename;
};

const mapAttachment = (row: any): Attachment => ({
  attachmentId: row.attachment_id,
  messageId: row.message_id ?? undefined,
  uploadedBy: row.uploaded_by,
  fileUrl: `/api/v1/attachments/${row.attachment_id}`,
  fileType: row.file_type,
  originalName: row.original_name,
  uploadedAt: row.uploaded_at,
});

export function makeAttachmentService(attachmentRepo: AttachmentRepository) {
  return {
    async uploadAttachment(uploadedBy: string, file: UploadedFile) {
      if (!uploadedBy) {
        throw new ValidationError('uploadedBy is required');
      }
      if (!file) {
        throw new ValidationError('file is required');
      }
      const originalName = normalizeOriginalFilename(file.originalname);
      const attachment = await attachmentRepo.create({
        uploadedBy,
        filePath: file.path || '',
        fileType: file.mimetype,
        originalName,
      });
      return mapAttachment(attachment);
    },
    async getAttachment(attachmentId: string) {
      const attachment = await attachmentRepo.findById(attachmentId);
      if (!attachment || attachment.message_is_recalled === true) {
        return null;
      }
      return attachment;
    }
  };
}
