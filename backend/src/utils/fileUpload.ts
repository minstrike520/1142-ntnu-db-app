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
 * Slack added on top of `maxBytes` to cover multipart boundaries, part headers
 * and other field values, which all ride along in the request body.
 *
 * This is no longer just a hint for an early exit: it is the authoritative
 * whole-request bound enforced while reading (see `readUploadForm`). Two
 * consequences worth keeping in mind before touching the value:
 *   - It caps the *whole request*, not the file part, so a metadata field
 *     larger than this alongside a near-limit file reports a size error.
 *   - The real memory high-water for a rejected upload is
 *     `maxBytes + MULTIPART_OVERHEAD_ALLOWANCE + one upstream chunk`, because a
 *     chunk is read before it can be counted. Under `@hono/node-server` a chunk
 *     is a socket read, so budget another 64 KB.
 * The exact per-file limit is still `options.maxBytes`, checked on the decoded
 * `File` below.
 */
const MULTIPART_OVERHEAD_ALLOWANCE = 64 * 1024;

/**
 * Media types whose body Hono's `parseBody()` actually reads. Anything else
 * yields `{}` there without touching the body, and we mirror that: an upload
 * request with an unrelated content type must still fail as `file is required`
 * without a single byte being read.
 */
const FORM_MEDIA_TYPES = new Set(['multipart/form-data', 'application/x-www-form-urlencoded']);

/** Raised through the body stream once the cap is passed. */
class UploadSizeExceededError extends Error {}

/** Mutable out-param so the caller can tell "we aborted" from "parse failed". */
interface CapState {
  exceeded: boolean;
}

/**
 * Wrap a body stream so that no more than `capBytes` is ever handed downstream.
 *
 * Counting here rather than after parsing is the whole point of issue #411: the
 * limit applies to bytes actually read off the wire, so omitting or forging
 * `Content-Length` (including `Transfer-Encoding: chunked`) cannot bypass it.
 */
const capBodyStream = (
  source: ReadableStream<Uint8Array>,
  capBytes: number,
  state: CapState
): ReadableStream<Uint8Array> => {
  const reader = source.getReader();
  let readBytes = 0;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }

      readBytes += value.byteLength;
      if (readBytes > capBytes) {
        // Stop pulling from the client and fail the parse. Note that
        // `@hono/node-server` still drains the abandoned request (bounded by its
        // own 64 MB / 500 ms limits) so the client gets our response rather than
        // a reset connection; nothing further is buffered by us either way.
        state.exceeded = true;
        await reader.cancel().catch(() => {});
        controller.error(new UploadSizeExceededError('File size limit exceeded'));
        return;
      }

      controller.enqueue(value);
    },
    cancel(reason) {
      void reader.cancel(reason);
    },
  });
};

/**
 * Read the request body as `FormData`, refusing to read past `capBytes`.
 *
 * Deliberately parses `c.req.raw.body` into a fresh `Response` instead of
 * wrapping `c.req.raw` and letting `c.req.parseBody()` run: reassigning
 * `c.req.raw` with a lazily-pulled stream (the shape `hono/body-limit` uses) was
 * prototyped against Bun 1.3.11 + Hono 4.12.32 and made `parseBody()` return an
 * empty body for *valid* uploads.
 */
async function readUploadForm(c: Context, capBytes: number | null, state: CapState): Promise<FormData> {
  const contentType = c.req.header('content-type') ?? '';
  const mediaType = contentType.split(';')[0].trim().toLowerCase();

  if (!FORM_MEDIA_TYPES.has(mediaType)) {
    return new FormData();
  }

  const raw = c.req.raw;
  if (!raw.body || raw.bodyUsed) {
    // No stream to meter (bodyless request, or something upstream already read
    // it). Fall back to the platform parser, which fails exactly as before.
    return raw.formData();
  }

  const source = capBytes === null ? raw.body : capBodyStream(raw.body, capBytes, state);

  // Normalise the media type case while preserving parameters like the
  // boundary, mirroring Hono's own `bufferToFormData`. Without this, an
  // upper-case `MULTIPART/FORM-DATA` that `parseBody()` accepts today would make
  // `formData()` throw on the MIME type.
  const normalizedContentType = contentType.replace(/^[^;]+/, (media) => media.toLowerCase());
  const form = await new Response(source, {
    headers: { 'Content-Type': normalizedContentType },
  }).formData();

  // Leave the result where Hono's parser would have cached it, so a later
  // `c.req.parseBody()` on this request still resolves even though the raw body
  // has now been consumed. Hono caches the pending promise here and awaits on
  // read; storing the settled value is equivalent for that reader and matches
  // the published `BodyCache` type.
  c.req.bodyCache.formData = form;

  return form;
}

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

  // Cheap early exit for a client that honestly declares an oversized body: it
  // costs nothing and reads zero bytes. It is only an optimisation now — the
  // streaming cap below is what a forged or absent `Content-Length` runs into.
  // Keep this check first: `fileUpload.test.ts` covers a request whose declared
  // length lies about a body that would otherwise parse to an empty form.
  if (options.maxBytes) {
    const declaredLength = Number(c.req.header('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes + MULTIPART_OVERHEAD_ALLOWANCE) {
      throw new ValidationError('File size limit exceeded');
    }
  }

  const capState: CapState = { exceeded: false };
  const capBytes = options.maxBytes ? options.maxBytes + MULTIPART_OVERHEAD_ALLOWANCE : null;

  let form: FormData;
  try {
    form = await readUploadForm(c, capBytes, capState);
  } catch (err) {
    // `capState.exceeded` is the primary signal; matching the error identity is
    // only a fallback, since whether the runtime rethrows our exact instance out
    // of `formData()` is an implementation detail we should not depend on.
    if (capState.exceeded || err instanceof UploadSizeExceededError) {
      // Deliberately a 400, byte-identical to the pre-existing rejection, so
      // this stays a pure security fix. Note `mapError.ts` maps the legacy
      // Multer `LIMIT_FILE_SIZE` to 413; aligning the two is a separate change
      // that has to touch the API docs.
      throw new ValidationError('File size limit exceeded');
    }
    throw err;
  }

  // `getAll(...).at(-1)` keeps `parseBody()`'s last-wins semantics for repeated
  // fields; `FormData.get()` would return the first instead.
  const file = form.getAll(fieldName).at(-1);

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
