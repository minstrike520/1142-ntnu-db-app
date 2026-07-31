import type { UploadedFile } from '../utils/fileUpload';
import { ValidationError } from '../utils/AppError';
import { AttachmentRepository } from '../models/attachmentRepository';
import {
  COMPRESSIBLE_ATTACHMENT_FORMATS,
  COMPRESSIBLE_ATTACHMENT_MIME_TYPES,
  compressAttachmentBuffer,
  detectImageFormat,
  isAnimatedPng,
} from '../utils/imageCompression';

const containsEastAsianChars = (value: string) => /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(value);

const normalizeOriginalFilename = (filename: string) => {
  const decoded = Buffer.from(filename, 'latin1').toString('utf8');

  if (containsEastAsianChars(decoded) && !containsEastAsianChars(filename)) {
    return decoded;
  }

  return filename;
};

const WEBP_EXTENSION = '.webp';

// Mirrors `attachments.original_name VARCHAR(255)`. Swapping a shorter
// extension for `.webp` can push a previously-fitting name over the limit
// (251 chars + `.png` is exactly 255, but becomes 256 with `.webp`), which
// would fail the INSERT and orphan the already-converted file on disk.
const MAX_ORIGINAL_NAME_LENGTH = 255;

const withWebpExtension = (filename: string): string => {
  const base = filename.replace(/\.[^.\\/]+$/, '');
  const budget = MAX_ORIGINAL_NAME_LENGTH - WEBP_EXTENSION.length;

  // Count by code point so multi-byte names are measured the way Postgres
  // counts characters, and so truncation never splits a surrogate pair.
  const baseChars = Array.from(base);
  const safeBase = baseChars.length > budget ? baseChars.slice(0, budget).join('') : base;

  return `${safeBase}${WEBP_EXTENSION}`;
};

// Compresses eligible image attachments to WebP. Compression failures never
// fail the upload — the original file, path, mimetype and filename are kept.
//
// The WebP is written to a *new* path and only becomes the stored path once it
// is fully written, so a partial write (e.g. ENOSPC) can never leave a
// truncated file under the path we go on to record. `parseSingleFile` already
// holds the upload in memory, so this re-encodes from the buffer rather than
// re-reading what it just wrote to disk.
const compressAttachmentIfEligible = async (
  file: UploadedFile,
  originalName: string,
): Promise<{ filePath: string; fileType: string; originalName: string }> => {
  const originalPath = file.path || '';
  const unchanged = { filePath: originalPath, fileType: file.mimetype, originalName };

  if (!originalPath || !COMPRESSIBLE_ATTACHMENT_MIME_TYPES.has(file.mimetype)) {
    return unchanged;
  }

  let detectedFormat: string | undefined;
  try {
    detectedFormat = await detectImageFormat(file.buffer);
  } catch {
    return unchanged;
  }

  // The multipart MIME and extension are controlled by the client. Only let
  // bytes that are actually a still-image-capable JPEG/PNG enter this
  // single-frame conversion path; animated GIF/WebP data disguised as PNG
  // must remain byte-for-byte untouched.
  if (!detectedFormat || !COMPRESSIBLE_ATTACHMENT_FORMATS.has(detectedFormat)) {
    return unchanged;
  }

  // `image/png` also covers APNG. Re-encoding one here would keep only the
  // first frame and permanently drop the animation, which is exactly what
  // excluding GIF above is meant to avoid — so skip those too.
  if (detectedFormat === 'png' && (await isAnimatedPng(file.buffer))) {
    return unchanged;
  }

  const webpPath = `${originalPath}${WEBP_EXTENSION}`;

  try {
    const compressed = await compressAttachmentBuffer(file.buffer);

    // Keep an already well-optimized source image when WebP would be larger.
    // This also avoids creating an unnecessary second copy on disk.
    if (compressed.length >= file.buffer.length) {
      return unchanged;
    }

    await Bun.write(webpPath, compressed);
    // Only now is the WebP complete and safe to point the record at.
    await Bun.file(originalPath).delete().catch(() => {});

    // The bytes are WebP now, so the stored download filename must say so —
    // it is handed straight to the browser as the saved file's name.
    return {
      filePath: webpPath,
      fileType: 'image/webp',
      originalName: withWebpExtension(originalName),
    };
  } catch {
    await Bun.file(webpPath).delete().catch(() => {});
    return unchanged;
  }
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
      const { filePath, fileType, originalName } = await compressAttachmentIfEligible(
        file,
        normalizeOriginalFilename(file.originalname),
      );
      return attachmentRepo.create({
        uploadedBy,
        filePath,
        fileType,
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
