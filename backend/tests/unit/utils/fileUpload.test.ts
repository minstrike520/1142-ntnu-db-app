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

  describe('stream-level enforcement', () => {
    const BOUNDARY = '----streamtest';
    const CHUNK_BYTES = 64 * 1024;
    const WOULD_BE_TOTAL = 64 * 1024 * 1024;

    /**
     * A multipart body that keeps producing until it is cancelled, reporting how
     * much of it the server actually pulled.
     *
     * The point of these tests is not the status code — the pre-existing cases
     * above already cover that — but that the server stops reading. A limit
     * applied after `parseBody()` returns the same 400 while still having taken
     * the whole payload into memory.
     */
    const endlessUpload = () => {
      const counter = { produced: 0 };
      const chunk = new Uint8Array(CHUNK_BYTES).fill(0x78);
      const head =
        `--${BOUNDARY}\r\n` +
        'Content-Disposition: form-data; name="file"; filename="big.bin"\r\n' +
        'Content-Type: application/octet-stream\r\n\r\n';

      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(head));
        },
        pull(controller) {
          if (counter.produced >= WOULD_BE_TOTAL) {
            controller.enqueue(new TextEncoder().encode(`\r\n--${BOUNDARY}--\r\n`));
            controller.close();
            return;
          }
          counter.produced += chunk.byteLength;
          controller.enqueue(chunk);
        },
      });

      return { body, counter };
    };

    const post = (app: Hono, headers: Record<string, string>, body: ReadableStream<Uint8Array>) =>
      app.request('/upload', {
        method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}`, ...headers },
        body,
        // Required to send a stream as a request body.
        duplex: 'half',
      } as RequestInit);

    it('aborts an oversized body instead of receiving all of it', async () => {
      const maxBytes = 1024;
      const { body, counter } = endlessUpload();

      const res = await post(makeApp(maxBytes), {}, body);

      expect(res.status).toBe(400);
      expect((await res.json() as { message?: string }).message).toBe('File size limit exceeded');
      // Bounded by the cap plus the overhead allowance and one in-flight chunk,
      // and nowhere near what the client was willing to send.
      expect(counter.produced).toBeLessThan(maxBytes + 64 * 1024 + 2 * CHUNK_BYTES);
      expect(counter.produced).toBeLessThan(WOULD_BE_TOTAL);
    });

    it('cannot be bypassed by omitting Content-Length', async () => {
      // No declared length at all, as with `Transfer-Encoding: chunked`, so the
      // cheap pre-check has nothing to act on.
      const { body, counter } = endlessUpload();

      const res = await post(makeApp(1024), {}, body);

      expect(res.status).toBe(400);
      expect(counter.produced).toBeLessThan(WOULD_BE_TOTAL);
    });

    it('cannot be bypassed by under-declaring Content-Length', async () => {
      // A forged length that sails through the pre-check; only the byte counter
      // in the stream stops this.
      const { body, counter } = endlessUpload();

      const res = await post(makeApp(1024), { 'content-length': '32' }, body);

      expect(res.status).toBe(400);
      expect((await res.json() as { message?: string }).message).toBe('File size limit exceeded');
      expect(counter.produced).toBeLessThan(WOULD_BE_TOTAL);
    });

    it('leaves an unlimited caller unrestricted', async () => {
      // `maxBytes` is per route; a caller that sets none must keep working.
      const app = new Hono();
      app.onError(errorHandler);
      app.post('/upload', async (c) => c.json({ size: (await parseSingleFile(c)).size }));

      const form = new FormData();
      form.append('file', new File(['x'.repeat(200_000)], 'blob.bin', { type: 'application/octet-stream' }));
      const res = await app.request('/upload', { method: 'POST', body: form });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ size: 200_000 });
    });
  });

  describe('non-file bodies', () => {
    it('rejects a JSON body as a missing file rather than failing to parse', async () => {
      const res = await makeApp(1024).request('/upload', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: 'not-a-file' }),
      });

      expect(res.status).toBe(400);
      expect((await res.json() as { message?: string }).message).toBe('file is required');
    });

    it('rejects a form field that is not a file', async () => {
      const form = new FormData();
      form.append('file', 'just a string');
      const res = await makeApp(1024).request('/upload', { method: 'POST', body: form });

      expect(res.status).toBe(400);
      expect((await res.json() as { message?: string }).message).toBe('file is required');
    });

    it('rejects a malformed multipart body with a client error, not a 500', async () => {
      const res = await makeApp(1024).request('/upload', {
        method: 'POST',
        headers: { 'content-type': 'multipart/form-data; boundary=----nope' },
        body: 'this is not multipart at all',
      });

      expect(res.status).toBe(400);
    });
  });
});
