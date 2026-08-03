import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { parseSingleFile, sanitizeStoredFileName } from '../../../src/utils/fileUpload';
import { errorHandler } from '../../../src/middlewares/errorHandler';

describe('sanitizeStoredFileName', () => {
  it('keeps an ordinary filename usable', () => {
    expect(sanitizeStoredFileName('report.pdf')).toBe('report.pdf');
  });

  it('strips POSIX traversal segments', () => {
    expect(sanitizeStoredFileName('../../../../src/index.ts')).toBe('index.ts');
    expect(sanitizeStoredFileName('../../evil.png')).toBe('evil.png');
  });

  it('strips Windows-style traversal segments', () => {
    expect(sanitizeStoredFileName('..\\..\\evil.png')).toBe('evil.png');
  });

  it('never returns a value containing a path separator', () => {
    for (const name of ['a/b/c.txt', 'a\\b\\c.txt', '/etc/passwd', '....//x.png']) {
      const result = sanitizeStoredFileName(name);
      expect(result).not.toInclude('/');
      expect(result).not.toInclude('\\');
      expect(result).not.toBe('..');
    }
  });

  it('drops leading dots so dotfiles cannot be produced', () => {
    expect(sanitizeStoredFileName('.env')).toBe('env');
    expect(sanitizeStoredFileName('..')).toBe('upload');
  });

  it('falls back to a placeholder for empty or fully stripped names', () => {
    expect(sanitizeStoredFileName('')).toBe('upload');
    expect(sanitizeStoredFileName('/')).toBe('upload');
  });

  it('replaces characters outside the safe set', () => {
    expect(sanitizeStoredFileName('my file;rm -rf.txt')).toBe('my_file_rm_-rf.txt');
  });

  it('caps the length while preserving the extension', () => {
    const long = `${'a'.repeat(300)}.png`;
    const result = sanitizeStoredFileName(long);
    expect(result.length).toBe(100);
    expect(result.endsWith('.png')).toBe(true);
  });
});

describe('parseSingleFile storage containment', () => {
  let uploadDir: string;
  let outsideDir: string;

  const makeApp = (saveToDir: string) => {
    const app = new Hono();
    app.post('/upload', async (c) => {
      const file = await parseSingleFile(c, { saveToDir });
      return c.json({ path: file.path, filename: file.filename, originalname: file.originalname });
    });
    return app;
  };

  const upload = async (app: Hono, filename: string, content = 'payload') => {
    const form = new FormData();
    form.append('file', new File([content], filename, { type: 'text/plain' }));
    const res = await app.request('/upload', { method: 'POST', body: form });
    return { res, body: await res.json() as { path: string; filename: string; originalname: string } };
  };

  beforeEach(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'near-chat-upload-'));
    uploadDir = path.join(root, 'uploads', 'attachments');
    outsideDir = path.join(root, 'src');
    await fs.mkdir(uploadDir, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(path.dirname(path.dirname(uploadDir)), { recursive: true, force: true });
  });

  it('writes a normal upload inside the target directory', async () => {
    const app = makeApp(uploadDir);
    const { res, body } = await upload(app, 'notes.txt');

    expect(res.status).toBe(200);
    expect(path.dirname(body.path)).toBe(uploadDir);
    expect(await Bun.file(body.path).exists()).toBe(true);
  });

  it('does not let a traversing filename escape the upload directory', async () => {
    const app = makeApp(uploadDir);
    const { res, body } = await upload(app, '../../../../src/index.ts', 'pwned');

    expect(res.status).toBe(200);
    // The stored path must stay directly inside the upload directory...
    expect(path.dirname(body.path)).toBe(uploadDir);
    expect(path.resolve(body.path).startsWith(path.resolve(uploadDir) + path.sep)).toBe(true);
    // ...and nothing may appear in the sibling directory the payload aimed at.
    expect(await fs.readdir(outsideDir)).toEqual([]);
  });

  it('preserves the client-supplied name as originalname only', async () => {
    const app = makeApp(uploadDir);
    const { body } = await upload(app, '../../../../src/index.ts');

    expect(body.originalname).toBe('../../../../src/index.ts');
    expect(body.filename).toEndWith('_index.ts');
    expect(body.filename).not.toInclude('/');
  });

  it('keeps generated names unique for identical uploads', async () => {
    const app = makeApp(uploadDir);
    const first = await upload(app, 'same.txt');
    const second = await upload(app, 'same.txt');

    expect(first.body.path).not.toBe(second.body.path);
    expect((await fs.readdir(uploadDir)).length).toBe(2);
  });
});

describe('parseSingleFile size limits', () => {
  const makeApp = (maxBytes: number) => {
    const app = new Hono();
    app.onError(errorHandler);
    app.post('/upload', async (c) => {
      const file = await parseSingleFile(c, { maxBytes });
      return c.json({ size: file.size });
    });
    return app;
  };

  const uploadOfSize = (app: Hono, bytes: number) => {
    const form = new FormData();
    form.append('file', new File(['x'.repeat(bytes)], 'blob.bin', { type: 'application/octet-stream' }));
    return app.request('/upload', { method: 'POST', body: form });
  };

  it('accepts a file within the limit', async () => {
    const res = await uploadOfSize(makeApp(1024), 512);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ size: 512 });
  });

  it('rejects a file over the limit', async () => {
    const res = await uploadOfSize(makeApp(1024), 4096);
    expect(res.status).toBe(400);
  });

  it('rejects on the declared Content-Length before parsing the body', async () => {
    const maxBytes = 1024;
    const app = makeApp(maxBytes);
    // Well past maxBytes + the multipart overhead allowance, so the early exit
    // fires without the request body ever being buffered and decoded.
    const res = await app.request('/upload', {
      method: 'POST',
      headers: {
        'content-type': 'multipart/form-data; boundary=----test',
        'content-length': String(maxBytes + 10 * 1024 * 1024),
      },
      body: '------test--',
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { message?: string };
    expect(body.message).toBe('File size limit exceeded');
  });

  it('does not reject a valid upload on multipart overhead alone', async () => {
    // The declared length always exceeds the raw file size because of boundaries
    // and part headers; a file at exactly the limit must still be accepted.
    const maxBytes = 4096;
    const res = await uploadOfSize(makeApp(maxBytes), maxBytes);

    expect(res.status).toBe(200);
  });
});

describe('parseSingleFile streaming size cap', () => {
  const MAX_BYTES = 4096;
  const OVERHEAD_ALLOWANCE = 64 * 1024;
  const RAW_CAP = MAX_BYTES + OVERHEAD_ALLOWANCE;
  const BOUNDARY = 'boundary411';
  const MULTIPART_TYPE = `multipart/form-data; boundary=${BOUNDARY}`;

  const makeApp = (options: Parameters<typeof parseSingleFile>[1] = { maxBytes: MAX_BYTES }) => {
    const app = new Hono();
    app.onError(errorHandler);
    app.post('/upload', async (c) => {
      const file = await parseSingleFile(c, options);
      return c.json({ size: file.size, name: file.originalname, path: file.path });
    });
    return app;
  };

  /**
   * A request body the server has to pull chunk by chunk, reporting how many
   * bytes it actually asked for. That count is the real assertion target here:
   * it is deterministic, unlike socket-level byte counts, which `@hono/node-server`
   * distorts by draining an abandoned request after the response is sent.
   */
  const meteredBody = (parts: string[], chunkBytes = 16 * 1024) => {
    const encoder = new TextEncoder();
    const payload = encoder.encode(parts.join(''));
    let offset = 0;
    let pulled = 0;

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= payload.byteLength) {
          controller.close();
          return;
        }
        const slice = payload.subarray(offset, offset + chunkBytes);
        offset += slice.byteLength;
        pulled += slice.byteLength;
        controller.enqueue(slice);
      },
    });

    return { stream, pulled: () => pulled, total: payload.byteLength };
  };

  const post = (
    app: Hono,
    body: ReadableStream<Uint8Array>,
    headers: Record<string, string>,
  ) => app.request('/upload', {
    method: 'POST',
    headers,
    body,
    // A streamed request body has no Content-Length, which is exactly the case
    // the old declared-size precheck could not police.
    duplex: 'half',
  } as RequestInit);

  const filePart = (bytes: number, filename = 'blob.bin') =>
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n`
    + `Content-Type: application/octet-stream\r\n\r\n${'x'.repeat(bytes)}\r\n`;

  const closing = `--${BOUNDARY}--\r\n`;

  /** A well-formed multipart body of an exact total byte length. */
  const multipartOfExactly = (totalBytes: number, fileBytes: number) => {
    const fillerHead = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="filler"\r\n\r\n`;
    const fixed = filePart(fileBytes).length + fillerHead.length + 2 + closing.length;
    const fillerBytes = totalBytes - fixed;
    if (fillerBytes < 0) {
      throw new Error(`cannot build a ${totalBytes}-byte body around a ${fileBytes}-byte file`);
    }
    return [filePart(fileBytes), fillerHead, 'y'.repeat(fillerBytes), '\r\n', closing];
  };

  it('rejects an oversized upload that declares no Content-Length', async () => {
    const offered = 20 * 1024 * 1024;
    const body = meteredBody([filePart(offered), closing]);
    const res = await post(makeApp(), body.stream, { 'content-type': MULTIPART_TYPE });

    expect(res.status).toBe(400);
    expect((await res.json() as { message?: string }).message).toBe('File size limit exceeded');
    // The whole point of #411: the body is refused on bytes read, not on a
    // declared header, so only the cap plus the chunk that tripped it is pulled.
    expect(body.pulled()).toBeLessThanOrEqual(RAW_CAP + 2 * 16 * 1024);
    expect(body.pulled()).toBeLessThan(offered);
  });

  it('rejects an oversized upload whose Content-Length is forged small', async () => {
    const body = meteredBody([filePart(20 * 1024 * 1024), closing]);
    const res = await post(makeApp(), body.stream, {
      'content-type': MULTIPART_TYPE,
      'content-length': '128',
    });

    expect(res.status).toBe(400);
    expect((await res.json() as { message?: string }).message).toBe('File size limit exceeded');
    expect(body.pulled()).toBeLessThanOrEqual(RAW_CAP + 2 * 16 * 1024);
  });

  it('accepts a raw body exactly at the cap', async () => {
    // The cap is exclusive, and the file itself stays well under maxBytes so
    // only the whole-request bound is under test.
    const body = meteredBody(multipartOfExactly(RAW_CAP, 1024));
    const res = await post(makeApp(), body.stream, { 'content-type': MULTIPART_TYPE });

    expect(body.total).toBe(RAW_CAP);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ size: 1024 });
  });

  it('rejects a raw body one byte past the cap', async () => {
    const body = meteredBody(multipartOfExactly(RAW_CAP + 1, 1024));
    const res = await post(makeApp(), body.stream, { 'content-type': MULTIPART_TYPE });

    expect(body.total).toBe(RAW_CAP + 1);
    expect(res.status).toBe(400);
    expect((await res.json() as { message?: string }).message).toBe('File size limit exceeded');
  });

  it('caps an oversized urlencoded body as well', async () => {
    // `parseBody()` buffers application/x-www-form-urlencoded through the same
    // full-request `arrayBuffer()` as multipart, so the cap has to cover it too.
    const offered = 20 * 1024 * 1024;
    const body = meteredBody([`file=${'y'.repeat(offered)}`]);
    const res = await post(makeApp(), body.stream, {
      'content-type': 'application/x-www-form-urlencoded',
    });

    expect(res.status).toBe(400);
    expect((await res.json() as { message?: string }).message).toBe('File size limit exceeded');
    expect(body.pulled()).toBeLessThan(offered);
  });

  it('does not consume a body whose content type carries no form data', async () => {
    const offered = 1024 * 1024;
    const chunkBytes = 16 * 1024;
    const body = meteredBody([`{"file":"${'z'.repeat(offered)}"}`], chunkBytes);
    const res = await post(makeApp(), body.stream, { 'content-type': 'application/json' });

    // Same 400 as before the change, and the body is never parsed. Bun's request
    // dispatch reads one chunk ahead on its own even for a handler that ignores
    // the body entirely, so one chunk is the floor here, not evidence of a read.
    expect(res.status).toBe(400);
    expect((await res.json() as { message?: string }).message).toBe('file is required');
    expect(body.pulled()).toBeLessThanOrEqual(chunkBytes);
  });

  it('accepts an upper-case multipart content type', async () => {
    // `formData()` rejects a non-lowercase media type, so the parser has to
    // normalise it the way Hono's own `bufferToFormData` does.
    const body = meteredBody([filePart(512), closing]);
    const res = await post(makeApp(), body.stream, {
      'content-type': `MULTIPART/FORM-DATA; boundary=${BOUNDARY}`,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ size: 512 });
  });

  it('keeps last-wins semantics for a repeated file field', async () => {
    const body = meteredBody([
      filePart(16, 'first.bin'),
      filePart(64, 'second.bin'),
      closing,
    ]);
    const res = await post(makeApp(), body.stream, { 'content-type': MULTIPART_TYPE });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ size: 64, name: 'second.bin' });
  });

  it('leaves a zero-byte part to the downstream checks rather than the size cap', async () => {
    const body = meteredBody([filePart(0), closing]);
    const res = await post(makeApp(), body.stream, { 'content-type': MULTIPART_TYPE });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ size: 0 });
  });

  it('still surfaces a malformed multipart body as a parse failure', async () => {
    // Unchanged behaviour: only the cap maps to a size error; anything else
    // propagates as it did before.
    const body = meteredBody(['not-multipart-at-all']);
    const res = await post(makeApp(), body.stream, { 'content-type': MULTIPART_TYPE });

    expect(res.status).toBe(500);
  });

  it('does not cap a caller that sets no maxBytes', async () => {
    const offered = 512 * 1024;
    const body = meteredBody([filePart(offered), closing]);
    const res = await post(makeApp({}), body.stream, { 'content-type': MULTIPART_TYPE });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ size: offered });
  });

  it('lets a later parseBody() reuse the form the cap already parsed', async () => {
    // The raw body is consumed by the metered read, so the parsed form has to be
    // left in Hono's body cache or any downstream parseBody() would throw.
    const app = new Hono();
    app.onError(errorHandler);
    app.post('/upload', async (c) => {
      const file = await parseSingleFile(c, { maxBytes: MAX_BYTES });
      const again = await c.req.parseBody();
      return c.json({ size: file.size, keys: Object.keys(again) });
    });

    const body = meteredBody([filePart(128), closing]);
    const res = await app.request('/upload', {
      method: 'POST',
      headers: { 'content-type': MULTIPART_TYPE },
      body: body.stream,
      duplex: 'half',
    } as RequestInit);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ size: 128, keys: ['file'] });
  });
});

describe('parseSingleFile streaming cap with storage', () => {
  const MAX_BYTES = 4096;
  const BOUNDARY = 'boundary411store';
  let uploadDir: string;

  beforeEach(async () => {
    uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'near-chat-cap-'));
  });

  afterEach(async () => {
    await fs.rm(uploadDir, { recursive: true, force: true });
  });

  it('stores a streamed upload with a non-ASCII filename under the sanitized name', async () => {
    // maxBytes and saveToDir together: the capped read has to produce a file the
    // storage path can still write.
    const app = new Hono();
    app.onError(errorHandler);
    app.post('/upload', async (c) => {
      const file = await parseSingleFile(c, { maxBytes: MAX_BYTES, saveToDir: uploadDir });
      return c.json({ path: file.path, filename: file.filename, originalname: file.originalname });
    });

    const payload = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="測試報告.txt"\r\n`
      + `Content-Type: text/plain\r\n\r\nhello\r\n--${BOUNDARY}--\r\n`;
    const res = await app.request('/upload', {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      body: new Response(payload).body!,
      duplex: 'half',
    } as RequestInit);

    expect(res.status).toBe(200);
    const body = await res.json() as { path: string; filename: string; originalname: string };
    expect(body.originalname).toBe('測試報告.txt');
    expect(path.dirname(body.path)).toBe(uploadDir);
    expect(body.filename).toEndWith('.txt');
    expect(body.filename).not.toInclude('/');
    expect(await Bun.file(body.path).text()).toBe('hello');
  });
});
