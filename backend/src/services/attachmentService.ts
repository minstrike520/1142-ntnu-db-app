import type { UploadedFile } from '../utils/fileUpload';
import { ValidationError } from '../utils/AppError';
import { AttachmentRepository } from '../models/attachmentRepository';

const containsEastAsianChars = (value: string) => /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(value);

const normalizeOriginalFilename = (filename: string) => {
  const decoded = Buffer.from(filename, 'latin1').toString('utf8');

  if (containsEastAsianChars(decoded) && !containsEastAsianChars(filename)) {
    return decoded;
  }

  return filename;
};

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
      return attachmentRepo.create({
        uploadedBy,
        filePath: file.path || '',
        fileType: file.mimetype,
        originalName,
      });
    },
    async getAttachment(attachmentId: string) {
      const attachment = await attachmentRepo.findById(attachmentId);
      const isRecalled = attachment?.messageIsRecalled;
      if (!attachment || isRecalled === true) {
        return null;
      }
      return attachment;
    }
  };
}
