import { describe, it, expect, beforeAll, beforeEach } from 'bun:test';
import { request } from '../../helpers/http';
import sharp from 'sharp';
import { resetDb } from '../../helpers/resetDb';

let app: any;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
  const indexModule = await import('../../../src/index');
  app = indexModule.honoApp;
});

// attachment.e2e.test.ts only uploads plain text, so nothing there exercises
// the image-compression path. This covers the full round trip, including the
// fact that conversion changes the stored file path to `<original>.webp`.
describe('Attachment compression E2E', () => {
  let token: string;

  beforeEach(async () => {
    await resetDb();
    const res = await request(app).post('/api/v1/auth/register').send({
      name: 'ImgUser',
      email: 'attachment-compression@test.com',
      password: 'Password123!',
    });
    token = res.body.accessToken ?? res.body.token;
  });

  const readBody = (req: any) =>
    req.buffer(true).parse((r: any, cb: any) => {
      const chunks: Buffer[] = [];
      r.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });

  it('stores an uploaded PNG as WebP and still serves it for download', async () => {
    const png = await sharp({
      create: { width: 40, height: 40, channels: 3, background: { r: 10, g: 120, b: 200 } },
    })
      .png()
      .toBuffer();

    const uploadRes = await request(app)
      .post('/api/v1/attachments')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', png, 'photo.png');

    expect(uploadRes.status).toBe(201);
    expect(uploadRes.body.fileType).toBe('image/webp');
    expect(uploadRes.body.originalName).toBe('photo.webp');

    const downloadRes = await readBody(
      request(app)
        .get(`/api/v1/attachments/${uploadRes.body.attachmentId}`)
        .set('Authorization', `Bearer ${token}`),
    );

    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers['content-type']).toContain('image/webp');

    const body = downloadRes.body as Buffer;
    expect(body.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(body.subarray(8, 12).toString('ascii')).toBe('WEBP');
  });

  it('leaves a non-image attachment untouched', async () => {
    const uploadRes = await request(app)
      .post('/api/v1/attachments')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('plain text content'), 'notes.txt');

    expect(uploadRes.status).toBe(201);
    expect(uploadRes.body.fileType).not.toBe('image/webp');
    expect(uploadRes.body.originalName).toBe('notes.txt');
  });
});
