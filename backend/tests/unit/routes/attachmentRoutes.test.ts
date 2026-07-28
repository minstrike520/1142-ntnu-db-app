import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import { Hono } from 'hono';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { makeAttachmentRoutes } from '../../../src/routes/attachmentRoutes';
import { errorHandler } from '../../../src/middlewares/errorHandler';
import { signToken } from '../../../src/utils/jwt';

const mockSqlFn: any = mock().mockResolvedValue([{ user_id: 'caller-id' }]);
mockSqlFn.unsafe = mock().mockResolvedValue([{}]);
mock.module('../../../src/models/db', () => ({ default: mockSqlFn }));

const CALLER_ID = '11111111-1111-4111-8111-111111111111';
const ATTACHMENT_ID = 'e4c08495-e224-4a67-b6dd-5958952d3d42';

const baseAttachment = {
  attachmentId: ATTACHMENT_ID,
  messageId: '22222222-2222-4222-8222-222222222222',
  uploadedBy: CALLER_ID,
  fileUrl: `/api/v1/attachments/${ATTACHMENT_ID}`,
  fileType: 'text/plain',
  originalName: 'report.txt',
  uploadedAt: new Date('2026-06-14T22:18:13Z'),
};

describe('GET /attachments/:id', () => {
  let service: any;
  let token: string;
  let tmpDir: string;

  const get = (headers: Record<string, string> = {}) => {
    const app = new Hono();
    app.onError(errorHandler);
    app.route('/attachments', makeAttachmentRoutes(service));
    return app.request(`/attachments/${ATTACHMENT_ID}`, {
      headers: { authorization: `Bearer ${token}`, ...headers },
    });
  };

  beforeEach(async () => {
    token = await signToken({ userId: CALLER_ID, email: 'caller@test.com' } as any);
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'near-chat-attach-'));
    service = { getAttachment: mock(), uploadAttachment: mock() };
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  afterAll(() => {
    mock.restore();
  });

  it('streams the file when it exists on disk', async () => {
    const filePath = path.join(tmpDir, 'stored.txt');
    await fs.writeFile(filePath, 'file contents');
    service.getAttachment.mockResolvedValue({ ...baseAttachment, filePath });

    const res = await get();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toInclude('text/plain');
    expect(await res.text()).toBe('file contents');
  });

  it('returns 404 when the stored file is missing', async () => {
    service.getAttachment.mockResolvedValue({
      ...baseAttachment,
      filePath: path.join(tmpDir, 'gone.txt'),
    });

    const res = await get();

    // Previously this answered 200 with metadata JSON, which download clients
    // would happily save as the file itself.
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toInclude('application/json');
  });

  it('returns 404 when the record has no stored path', async () => {
    service.getAttachment.mockResolvedValue({ ...baseAttachment, filePath: undefined });

    expect((await get()).status).toBe(404);
  });

  it('returns 404 for an unknown attachment', async () => {
    service.getAttachment.mockResolvedValue(null);

    expect((await get()).status).toBe(404);
  });

  it('does not leak the storage path in the JSON metadata response', async () => {
    service.getAttachment.mockResolvedValue({
      ...baseAttachment,
      filePath: '/app/uploads/attachments/1750000000_abcd_report.txt',
      messageIsRecalled: false,
    });

    const res = await get({ accept: 'application/json' });
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).not.toHaveProperty('filePath');
    expect(body).not.toHaveProperty('messageIsRecalled');
    expect(JSON.stringify(body)).not.toInclude('/app/uploads');
    expect(body.attachmentId).toBe(ATTACHMENT_ID);
  });
});
