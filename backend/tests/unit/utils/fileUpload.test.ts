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
