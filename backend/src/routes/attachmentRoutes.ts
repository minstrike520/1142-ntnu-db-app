import { Hono } from 'hono';
import fs from 'fs/promises';
import path from 'path';
import { NotFoundError } from '../utils/AppError';
import { authMiddleware } from '../middlewares/authMiddleware';
import { attachmentUploadConfig } from '../utils/attachmentUploadConfig';
import { ATTACHMENTS_UPLOAD_DIR, ensureUploadDirectories } from '../utils/uploads';
import { parseSingleFile } from '../utils/fileUpload';

ensureUploadDirectories();

const encodeDownloadFilename = (filename: string): string => {
  const asciiFallback = filename.replace(/[^\x20-\x7E]+/g, '_');
  const encoded = encodeURIComponent(filename)
    .replace(/['()]/g, escape)
    .replace(/\*/g, '%2A');

  return `attachment; filename="${asciiFallback || 'download'}"; filename*=UTF-8''${encoded}`;
};

export interface AttachmentService {
  uploadAttachment(userId: string, file: Express.Multer.File): Promise<any>;
  getAttachment(attachmentId: string): Promise<any>;
}

export const makeAttachmentRoutes = (service: AttachmentService) => {
  const app = new Hono();
  app.use('*', authMiddleware);

  app.post('/', async (c) => {
    const userId = c.get('user').userId;
    const file = await parseSingleFile(c, {
      fieldName: 'file',
      maxBytes: attachmentUploadConfig.maxBytes,
      restrictionEnabled: attachmentUploadConfig.restrictionEnabled,
      allowedMimeTypes: attachmentUploadConfig.allowedMimeTypes,
      allowedExtensions: attachmentUploadConfig.allowedExtensions,
      saveToDir: ATTACHMENTS_UPLOAD_DIR,
    });
    const result = await service.uploadAttachment(userId, file);
    return c.json(result, 201);
  });

  app.get('/:id', async (c) => {
    const attachmentId = c.req.param('id');
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(attachmentId);
    if (!isUuid) {
      throw new NotFoundError('attachment', attachmentId);
    }
    const attachment = await service.getAttachment(attachmentId);
    if (!attachment) {
      throw new NotFoundError('attachment', attachmentId);
    }
    const rawPath = attachment.filePath || attachment.file_path;
    if (!rawPath) {
      throw new NotFoundError('attachment file', attachmentId);
    }
    const filePath = path.isAbsolute(rawPath)
      ? rawPath
      : path.resolve(ATTACHMENTS_UPLOAD_DIR, path.basename(rawPath));

    const originalName = attachment.originalName || attachment.original_name || 'download';
    const mimeType = attachment.fileType || attachment.mime_type || 'application/octet-stream';

    try {
      await fs.access(filePath);
      const fileBuffer = await fs.readFile(filePath);
      return c.newResponse(fileBuffer, 200, {
        'Content-Type': mimeType,
        'Content-Disposition': encodeDownloadFilename(originalName),
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new NotFoundError('attachment file', attachmentId);
      }
      throw err;
    }
  });

  return app;
};
