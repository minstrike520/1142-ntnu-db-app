import type { UploadedFile } from '../../../src/utils/fileUpload';
import { describe, it, expect, beforeEach, afterEach, mock, type Mock } from 'bun:test';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import zlib from 'zlib';
import sharp from 'sharp';
import { makeAttachmentService } from '../../../src/services/attachmentService';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const pngChunk = (type: string, data: Buffer): Buffer => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
};

const readPngChunks = (png: Buffer): { type: string; data: Buffer }[] => {
  const chunks: { type: string; data: Buffer }[] = [];
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    chunks.push({
      type: png.subarray(offset + 4, offset + 8).toString('ascii'),
      data: png.subarray(offset + 8, offset + 8 + length),
    });
    offset += 12 + length;
  }
  return chunks;
};

// Builds a real 2-frame APNG (acTL/fcTL/fdAT). sharp cannot emit one when
// libvips lacks APNG write support, so assemble the chunk stream directly.
const buildApngBuffer = async (): Promise<Buffer> => {
  const size = 8;
  const makeFrame = (r: number, g: number, b: number) =>
    sharp({ create: { width: size, height: size, channels: 3, background: { r, g, b } } })
      .png()
      .toBuffer();

  const [first, second] = await Promise.all([makeFrame(220, 20, 20), makeFrame(20, 20, 220)]);
  const ihdr = readPngChunks(first).find((chunk) => chunk.type === 'IHDR')!;

  const acTL = Buffer.alloc(8);
  acTL.writeUInt32BE(2, 0); // num_frames
  acTL.writeUInt32BE(0, 4); // num_plays: loop forever

  const fcTL = (sequence: number): Buffer => {
    const data = Buffer.alloc(26);
    data.writeUInt32BE(sequence, 0);
    data.writeUInt32BE(size, 4);
    data.writeUInt32BE(size, 8);
    data.writeUInt16BE(1, 20); // delay numerator
    data.writeUInt16BE(2, 22); // delay denominator
    return data;
  };

  const parts: Buffer[] = [
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr.data),
    pngChunk('acTL', acTL),
    pngChunk('fcTL', fcTL(0)),
  ];

  for (const chunk of readPngChunks(first).filter((c) => c.type === 'IDAT')) {
    parts.push(pngChunk('IDAT', chunk.data));
  }

  parts.push(pngChunk('fcTL', fcTL(1)));

  let sequence = 2;
  for (const chunk of readPngChunks(second).filter((c) => c.type === 'IDAT')) {
    const fdAT = Buffer.alloc(4 + chunk.data.length);
    fdAT.writeUInt32BE(sequence++, 0);
    chunk.data.copy(fdAT, 4);
    parts.push(pngChunk('fdAT', fdAT));
  }

  parts.push(pngChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
};

describe('AttachmentService', () => {
  let attachmentRepo: { create: Mock<any>; findById: Mock<any> };
  let service: ReturnType<typeof makeAttachmentService>;

  beforeEach(() => {
    attachmentRepo = {
      create: mock(),
      findById: mock(),
    };
    service = makeAttachmentService(attachmentRepo as any);
  });

  it('normalizes mojibake original filenames before persisting', async () => {
    attachmentRepo.create.mockResolvedValue({
      attachment_id: 'att-1',
      uploaded_by: 'user-1',
      file_type: 'application/pdf',
      original_name: '運算思維與程式設計平台 多個頁點.pdf',
      uploaded_at: new Date('2026-01-01T00:00:00.000Z'),
    });

    await service.uploadAttachment('user-1', {
      path: '/tmp/file.pdf',
      mimetype: 'application/pdf',
      originalname: 'éç®æç¶­èç¨å¼è¨­è¨å¹³å° å¤åé é».pdf',
    } as UploadedFile);

    expect(attachmentRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        originalName: '運算思維與程式設計平台 多個頁點.pdf',
      }),
    );
  });

  it('getAttachment returns null when the parent message has been recalled', async () => {
    attachmentRepo.findById.mockResolvedValue({
      attachmentId: 'att-1',
      messageId: 'msg-1',
      uploadedBy: 'user-1',
      fileUrl: '/api/v1/attachments/att-1',
      fileType: 'application/pdf',
      originalName: 'doc.pdf',
      uploadedAt: new Date(),
      messageIsRecalled: true,
    });

    await expect(service.getAttachment('att-1')).resolves.toBeNull();
  });

  it('getAttachment returns the attachment when the parent message has not been recalled', async () => {
    const attachment = {
      attachmentId: 'att-1',
      messageId: 'msg-1',
      uploadedBy: 'user-1',
      fileUrl: '/api/v1/attachments/att-1',
      fileType: 'application/pdf',
      originalName: 'doc.pdf',
      uploadedAt: new Date(),
      messageIsRecalled: false,
    };
    attachmentRepo.findById.mockResolvedValue(attachment);

    await expect(service.getAttachment('att-1')).resolves.toEqual(attachment);
  });

  it('getAttachment returns the attachment when it is not yet linked to any message', async () => {
    const attachment = {
      attachmentId: 'att-1',
      messageId: undefined,
      uploadedBy: 'user-1',
      fileUrl: '/api/v1/attachments/att-1',
      fileType: 'application/pdf',
      originalName: 'doc.pdf',
      uploadedAt: new Date(),
      messageIsRecalled: undefined,
    };
    attachmentRepo.findById.mockResolvedValue(attachment);

    await expect(service.getAttachment('att-1')).resolves.toEqual(attachment);
  });

  it('getAttachment returns null when the attachment does not exist', async () => {
    attachmentRepo.findById.mockResolvedValue(null);

    await expect(service.getAttachment('missing')).resolves.toBeNull();
  });
});

describe('AttachmentService image compression', () => {
  let attachmentRepo: { create: Mock<any>; findById: Mock<any> };
  let service: ReturnType<typeof makeAttachmentService>;
  const createdFiles: string[] = [];

  beforeEach(() => {
    attachmentRepo = {
      create: mock(async (data: any) => ({
        attachment_id: 'att-1',
        uploaded_by: data.uploadedBy,
        file_type: data.fileType,
        original_name: data.originalName,
        uploaded_at: new Date('2026-01-01T00:00:00.000Z'),
      })),
      findById: mock(),
    };
    service = makeAttachmentService(attachmentRepo as any);
  });

  afterEach(async () => {
    while (createdFiles.length > 0) {
      const file = createdFiles.pop()!;
      await Bun.file(file).delete().catch(() => {});
      await Bun.file(`${file}.webp`).delete().catch(() => {});
    }
  });

  // Mirrors what `parseSingleFile` hands the service: the bytes are already in
  // memory *and* staged on disk under `path`.
  const stageUpload = async (
    buffer: Buffer,
    extension: string,
    mimetype: string,
    originalname: string,
  ): Promise<UploadedFile> => {
    const filePath = path.join(os.tmpdir(), `attachment-test-${crypto.randomUUID()}${extension}`);
    await Bun.write(filePath, buffer);
    createdFiles.push(filePath);
    return { path: filePath, buffer, mimetype, originalname, size: buffer.length } as UploadedFile;
  };

  const createdArg = () => attachmentRepo.create.mock.calls[0][0] as {
    filePath: string;
    fileType: string;
    originalName: string;
  };

  const solidPng = (size: number, r: number, g: number, b: number) =>
    sharp({ create: { width: size, height: size, channels: 3, background: { r, g, b } } })
      .png()
      .toBuffer();

  const animatedImage = (format: 'gif' | 'webp') => {
    const frameSize = 8 * 8 * 3;
    const first = Buffer.alloc(frameSize);
    const second = Buffer.alloc(frameSize);

    for (let offset = 0; offset < frameSize; offset += 3) {
      first.set([220, 20, 20], offset);
      second.set([20, 20, 220], offset);
    }

    return sharp(Buffer.concat([first, second]), {
      raw: { width: 8, height: 16, pageHeight: 8, channels: 3 },
    })
      [format]({ loop: 0, delay: [100, 100] })
      .toBuffer();
  };

  it('compresses a PNG attachment to WebP and stores image/webp at the .webp path', async () => {
    const file = await stageUpload(await solidPng(20, 10, 20, 30), '.png', 'image/png', 'photo.png');

    await service.uploadAttachment('user-1', file);

    const { filePath, fileType } = createdArg();
    expect(fileType).toBe('image/webp');
    expect(filePath).toBe(`${file.path!}.webp`);

    const compressedBytes = Buffer.from(await Bun.file(filePath).arrayBuffer());
    expect(compressedBytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(compressedBytes.subarray(8, 12).toString('ascii')).toBe('WEBP');
  });

  it('removes the original upload once the WebP is written', async () => {
    const file = await stageUpload(await solidPng(12, 9, 9, 9), '.png', 'image/png', 'photo.png');

    await service.uploadAttachment('user-1', file);

    expect(await Bun.file(file.path!).exists()).toBe(false);
    expect(await Bun.file(`${file.path!}.webp`).exists()).toBe(true);
  });

  it('rewrites the stored download filename extension to .webp when converting', async () => {
    const file = await stageUpload(await solidPng(12, 1, 2, 3), '.png', 'image/png', 'holiday photo.png');

    await service.uploadAttachment('user-1', file);

    expect(createdArg().originalName).toBe('holiday photo.webp');
  });

  it('leaves the download filename and path untouched for attachments it does not convert', async () => {
    const file = await stageUpload(Buffer.from('%PDF-1.4 fake pdf'), '.pdf', 'application/pdf', 'report.pdf');

    await service.uploadAttachment('user-1', file);

    const { filePath, fileType, originalName } = createdArg();
    expect(originalName).toBe('report.pdf');
    expect(fileType).toBe('application/pdf');
    expect(filePath).toBe(file.path!);

    const bytes = Buffer.from(await Bun.file(filePath).arrayBuffer());
    expect(bytes.toString()).toBe('%PDF-1.4 fake pdf');
  });

  it('skips APNG attachments so the animation is not flattened to one frame', async () => {
    const apng = await buildApngBuffer();
    const file = await stageUpload(apng, '.png', 'image/png', 'anim.png');

    await service.uploadAttachment('user-1', file);

    const { filePath, fileType, originalName } = createdArg();
    expect(fileType).toBe('image/png');
    expect(originalName).toBe('anim.png');
    expect(filePath).toBe(file.path!);

    // Bytes must be byte-for-byte untouched.
    const stored = Buffer.from(await Bun.file(filePath).arrayBuffer());
    expect(stored.equals(apng)).toBe(true);
  });

  it('skips images whose pixel count exceeds the decode limit instead of decoding them', async () => {
    // ~81 MP but only a couple hundred KB compressed: passes the byte-size
    // limit, so only the pixel cap can stop it.
    const bomb = await sharp({
      create: { width: 9000, height: 9000, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    const file = await stageUpload(bomb, '.png', 'image/png', 'huge.png');

    await service.uploadAttachment('user-1', file);

    const { filePath, fileType, originalName } = createdArg();
    expect(fileType).toBe('image/png');
    expect(originalName).toBe('huge.png');
    expect(filePath).toBe(file.path!);
    // The half-written WebP must not survive a failed conversion.
    expect(await Bun.file(`${file.path!}.webp`).exists()).toBe(false);
  });

  it('keeps the rewritten filename within the original_name column limit', async () => {
    // 251 chars + '.png' is exactly 255; naive replacement would yield 256.
    const longBase = 'a'.repeat(251);
    const file = await stageUpload(await solidPng(10, 4, 5, 6), '.png', 'image/png', `${longBase}.png`);

    await service.uploadAttachment('user-1', file);

    const persisted = createdArg().originalName;
    expect(persisted.length).toBeLessThanOrEqual(255);
    expect(persisted.endsWith('.webp')).toBe(true);
  });

  it('does not split a surrogate pair when truncating a long multi-byte filename', async () => {
    const longEmojiBase = '🙂'.repeat(200); // 200 code points, 400 UTF-16 units
    const file = await stageUpload(await solidPng(10, 7, 8, 9), '.png', 'image/png', `${longEmojiBase}.png`);

    await service.uploadAttachment('user-1', file);

    const persisted = createdArg().originalName;
    expect(persisted.endsWith('.webp')).toBe(true);
    expect(Array.from(persisted).length).toBeLessThanOrEqual(255);
    // No lone surrogates survived the truncation.
    expect(/[\uD800-\uDFFF]/.test(persisted.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))).toBe(false);
  });

  it('compresses a JPEG attachment to WebP and stores image/webp', async () => {
    const jpegBuffer = await sharp({
      create: { width: 20, height: 20, channels: 3, background: { r: 200, g: 150, b: 100 } },
    })
      .jpeg()
      .toBuffer();
    const file = await stageUpload(jpegBuffer, '.jpg', 'image/jpeg', 'photo.jpg');

    await service.uploadAttachment('user-1', file);

    expect(createdArg().fileType).toBe('image/webp');
  });

  it('keeps the original attachment when WebP is not smaller', async () => {
    const tinyPng = await sharp({
      create: { width: 1, height: 1, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    const file = await stageUpload(tinyPng, '.png', 'image/png', 'already-small.png');

    await service.uploadAttachment('user-1', file);

    const { filePath, fileType, originalName } = createdArg();
    expect(filePath).toBe(file.path!);
    expect(fileType).toBe('image/png');
    expect(originalName).toBe('already-small.png');
    expect(await Bun.file(file.path!).exists()).toBe(true);
    expect(await Bun.file(`${file.path!}.webp`).exists()).toBe(false);
  });

  it('skips animated-GIF-capable mimetype so animation is never collapsed', async () => {
    const file = await stageUpload(Buffer.from('GIF89afakegifbytes'), '.gif', 'image/gif', 'anim.gif');

    await service.uploadAttachment('user-1', file);

    expect(createdArg().fileType).toBe('image/gif');
  });

  for (const actualFormat of ['gif', 'webp'] as const) {
    it(`does not flatten an animated ${actualFormat.toUpperCase()} disguised as PNG`, async () => {
      const animation = await animatedImage(actualFormat);
      expect((await sharp(animation).metadata()).pages).toBe(2);
      const file = await stageUpload(animation, '.png', 'image/png', 'animation.png');

      await service.uploadAttachment('user-1', file);

      const { filePath, fileType, originalName } = createdArg();
      expect(filePath).toBe(file.path!);
      expect(fileType).toBe('image/png');
      expect(originalName).toBe('animation.png');
      expect(await Bun.file(`${file.path!}.webp`).exists()).toBe(false);

      const stored = Buffer.from(await Bun.file(filePath).arrayBuffer());
      expect(stored.equals(animation)).toBe(true);
      expect((await sharp(stored).metadata()).pages).toBe(2);
    });
  }

  it('falls back to the original mimetype and leaves the file untouched when compression fails', async () => {
    const originalBytes = Buffer.from('not a real png');
    const file = await stageUpload(originalBytes, '.png', 'image/png', 'corrupt.png');

    await service.uploadAttachment('user-1', file);

    const { filePath, fileType } = createdArg();
    expect(fileType).toBe('image/png');
    expect(filePath).toBe(file.path!);

    const bytes = Buffer.from(await Bun.file(filePath).arrayBuffer());
    expect(bytes.equals(originalBytes)).toBe(true);
  });
});
