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

/**
 * Slack allowed on top of the file's own size, to cover multipart boundaries,
 * part headers and other field values. Generous on purpose: it only has to keep
 * a legitimate at-the-limit upload from tripping the envelope check, because the
 * authoritative per-file check still runs on the decoded `File`.
 */
const MULTIPART_OVERHEAD_ALLOWANCE = 64 * 1024;

/**
 * Wrap a request body so it stops being read once `maxBytes` have gone past.
 *
 * This is what makes the upload cap real rather than advisory. Parsing the body
 * first and checking `File.size` afterwards means the whole payload is received
 * and decoded before it can be rejected, so any authenticated user can make the
 * server buffer an arbitrarily large request; the `Content-Length` pre-check
 * below does not close that off, since a client is free to under-declare the
 * length or omit it entirely with `Transfer-Encoding: chunked`.
 *
 * Counting the bytes as they arrive is independent of anything the client
 * declares. On the first chunk that crosses the limit the source is cancelled —
 * which tears down the underlying request — and the error surfaces out of
 * whichever parser is consuming this stream.
 */
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

/**
 * Decode the request's form body, reading at most `maxBytes` from the wire.
 *
 * `Response.formData()` is used in place of Hono's `c.req.parseBody()` because
 * it can be pointed at our own limited stream; `parseBody()` always reads
 * `c.req.raw` in full. The accepted content types are the same ones Hono parses
 * (`multipart/form-data` and `application/x-www-form-urlencoded`), so a request
 * that used to yield an empty body still ends up at the same `file is required`
 * rejection below — as does a malformed multipart body, which the old path let
 * escape as a 500.
 */
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
    // Our own limit error has to keep its identity; anything else means the
    // client sent a body this endpoint cannot read a file out of.
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

  // Honest clients that declare an oversized upload are turned away without a
  // single byte being read. This is only an optimisation — the declared length
  // is client-controlled, so `limitBodyStream` is what actually enforces the cap.
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
