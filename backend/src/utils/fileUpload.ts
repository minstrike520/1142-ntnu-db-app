import type { Context } from 'hono';
import path from 'path';
import { ValidationError } from '../utils/AppError';

export interface UploadedFile {
  fieldname?: string;
  originalname: string;
  encoding?: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
  destination?: string;
  filename?: string;
  path?: string;
  stream?: ReadableStream | null;
}

/**
 * Reduce a client-supplied multipart filename to a single, inert path segment.
 *
 * The browser controls this value, and Bun keeps whatever it is given, so it can
 * carry `../` (or a Windows-style `..\`) and escape the upload directory once it
 * reaches `path.join`. The human-readable name is persisted separately as
 * `originalname`, so the on-disk name only has to be unique and safe.
 */
export const sanitizeStoredFileName = (rawName: string): string => {
  const segment = path.posix.basename(String(rawName ?? '').replace(/\\/g, '/'));
  const safe = segment
    .replace(/\0/g, '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '');
  return safe.length > 0 ? safe.slice(-100) : 'upload';
};

export interface ParseFileOptions {
  fieldName?: string;
  maxBytes?: number;
  allowedMimeTypes?: string[];
  allowedExtensions?: string[];
  restrictionEnabled?: boolean;
  saveToDir?: string;
}

export async function parseSingleFile(
  c: Context,
  options: ParseFileOptions = {}
): Promise<UploadedFile> {
  const fieldName = options.fieldName ?? 'file';
  const body = await c.req.parseBody();
  const file = body[fieldName];

  if (!file || typeof file === 'string') {
    throw new ValidationError('file is required');
  }

  const fileObj = file as File;
  const rawMime = (fileObj.type || 'application/octet-stream').toLowerCase();
  const cleanMime = rawMime.split(';')[0].trim();

  if (options.maxBytes && fileObj.size > options.maxBytes) {
    throw new ValidationError('File size limit exceeded');
  }

  if (options.restrictionEnabled) {
    if (options.allowedMimeTypes && options.allowedMimeTypes.length > 0 && !options.allowedMimeTypes.includes(cleanMime)) {
      throw new ValidationError(`Attachment MIME type is not allowed: ${fileObj.type}`);
    }

    const extension = fileObj.name.toLowerCase().match(/\.[^.]+$/)?.[0];
    if (
      options.allowedExtensions &&
      options.allowedExtensions.length > 0 &&
      (!extension || !options.allowedExtensions.includes(extension))
    ) {
      throw new ValidationError(`Attachment file extension is not allowed: ${extension ?? 'unknown'}`);
    }
  } else if (options.restrictionEnabled === undefined && options.allowedMimeTypes && options.allowedMimeTypes.length > 0) {
    if (!options.allowedMimeTypes.includes(cleanMime)) {
      throw new ValidationError('Unsupported file type');
    }
  }

  const arrayBuffer = await fileObj.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  let filePath = '';
  let storedName = '';
  if (options.saveToDir) {
    storedName = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}_${sanitizeStoredFileName(fileObj.name)}`;
    filePath = path.join(options.saveToDir, storedName);
    await Bun.write(filePath, buffer);
  }

  return {
    fieldname: fieldName,
    originalname: fileObj.name,
    encoding: '7bit',
    mimetype: cleanMime,
    buffer,
    size: fileObj.size,
    destination: options.saveToDir || '',
    filename: storedName || sanitizeStoredFileName(fileObj.name),
    path: filePath,
    stream: null,
  };
}
