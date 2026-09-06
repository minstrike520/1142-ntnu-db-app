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

/** Sanitizes client-provided filename into a safe path segment without path traversal. */
export const sanitizeStoredFileName = (rawName: string): string => {
  const segment = path.posix.basename(String(rawName ?? '').replace(/\\/g, '/'));
  const safe = segment
    .replace(/\0/g, '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '');
  return safe.length > 0 ? safe.slice(-100) : 'upload';
};

// Allowance for multipart envelope headers and boundaries.
const MULTIPART_OVERHEAD_ALLOWANCE = 64 * 1024;

/** Enforces byte limit on incoming request stream to avoid buffering oversized bodies. */
const limitBodyStream = (
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): ReadableStream<Uint8Array> => {
  const reader = body.getReader();
  let received = 0;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();

      if (done) {
        controller.close();
        return;
      }

      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel('upload exceeded its size limit');
        controller.error(new ValidationError('File size limit exceeded'));
        return;
      }

      controller.enqueue(value);
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
};

/** Decodes multipart form body using byte-limited stream. */
const parseFormBody = async (c: Context, maxBytes?: number): Promise<FormData> => {
  const raw = c.req.raw;
  const contentType = raw.headers.get('content-type') ?? '';
  const body = raw.body;

  if (!body) {
    throw new ValidationError('file is required');
  }

  const stream = maxBytes ? limitBodyStream(body, maxBytes + MULTIPART_OVERHEAD_ALLOWANCE) : body;

  try {
    return await new Response(stream, { headers: { 'content-type': contentType } }).formData();
  } catch (error) {
    if (error instanceof ValidationError) {
      throw error;
    }
    throw new ValidationError('file is required');
  }
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

  // Fast-path rejection if declared Content-Length already exceeds limit.
  if (options.maxBytes) {
    const declaredLength = Number(c.req.header('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes + MULTIPART_OVERHEAD_ALLOWANCE) {
      throw new ValidationError('File size limit exceeded');
    }
  }

  const body = await parseFormBody(c, options.maxBytes);
  const file = body.get(fieldName);

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
