import { describe, expect, it } from 'bun:test';
import zlib from 'zlib';
import sharp from 'sharp';
import {
  MAX_INPUT_PIXELS,
  compressAttachmentBuffer,
  compressAvatarBuffer,
  isAnimatedPng,
} from '../../../src/utils/imageCompression';

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

const makeStillPng = () =>
  sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .png()
    .toBuffer();

const buildApng = async (): Promise<Buffer> => {
  const still = await makeStillPng();
  const ihdr = readPngChunks(still).find((chunk) => chunk.type === 'IHDR')!;

  const acTL = Buffer.alloc(8);
  acTL.writeUInt32BE(2, 0);
  acTL.writeUInt32BE(0, 4);

  const fcTL = Buffer.alloc(26);
  fcTL.writeUInt32BE(0, 0);
  fcTL.writeUInt32BE(8, 4);
  fcTL.writeUInt32BE(8, 8);

  const parts = [
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr.data),
    pngChunk('acTL', acTL),
    pngChunk('fcTL', fcTL),
    ...readPngChunks(still)
      .filter((chunk) => chunk.type === 'IDAT')
      .map((chunk) => pngChunk('IDAT', chunk.data)),
    pngChunk('IEND', Buffer.alloc(0)),
  ];

  return Buffer.concat(parts);
};

describe('isAnimatedPng', () => {
  it('detects an APNG via its acTL chunk', async () => {
    expect(await isAnimatedPng(await buildApng())).toBe(true);
  });

  it('returns false for a still PNG', async () => {
    expect(await isAnimatedPng(await makeStillPng())).toBe(false);
  });

  it('returns false for non-PNG input', async () => {
    const jpeg = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .jpeg()
      .toBuffer();

    expect(await isAnimatedPng(jpeg)).toBe(false);
    expect(await isAnimatedPng(Buffer.alloc(0))).toBe(false);
    expect(await isAnimatedPng(Buffer.from('not an image'))).toBe(false);
  });

  it('does not mistake a later acTL-like payload for animation once IDAT is reached', async () => {
    const still = await makeStillPng();
    // Append a bogus trailing chunk named acTL *after* IDAT/IEND; per spec a
    // real acTL must precede IDAT, so this must not count as animated.
    const trailing = Buffer.concat([still, pngChunk('acTL', Buffer.alloc(8))]);

    expect(await isAnimatedPng(trailing)).toBe(false);
  });
});

// Ported from the disk-backed `isAnimatedPngFile` suite. The Bun upload path
// always has the full upload in memory, so the file variant was dropped; these
// edge cases still matter for the buffer scanner.
describe('isAnimatedPng edge cases', () => {
  it('detects an APNG whose acTL sits far beyond any fixed header window', async () => {
    // A single legal ancillary chunk (here a 100 KiB tEXt, but an iCCP colour
    // profile behaves the same) can push acTL past a fixed scan window. Only
    // "acTL precedes the first IDAT" is guaranteed by the spec.
    const still = await makeStillPng();
    const ihdr = readPngChunks(still).find((chunk) => chunk.type === 'IHDR')!;

    const acTL = Buffer.alloc(8);
    acTL.writeUInt32BE(2, 0);
    acTL.writeUInt32BE(0, 4);

    const bigAncillary = Buffer.concat([
      Buffer.from('Comment\0', 'ascii'),
      Buffer.alloc(100 * 1024, 0x41),
    ]);

    const apng = Buffer.concat([
      PNG_SIGNATURE,
      pngChunk('IHDR', ihdr.data),
      pngChunk('tEXt', bigAncillary),
      pngChunk('acTL', acTL),
      pngChunk('fcTL', Buffer.alloc(26)),
      ...readPngChunks(still)
        .filter((chunk) => chunk.type === 'IDAT')
        .map((chunk) => pngChunk('IDAT', chunk.data)),
      pngChunk('IEND', Buffer.alloc(0)),
    ]);

    expect(apng.indexOf(Buffer.from('acTL', 'ascii'))).toBeGreaterThan(64 * 1024);
    expect(await isAnimatedPng(apng)).toBe(true);
  });

  it('returns false for a truncated stream without hanging', async () => {
    expect(await isAnimatedPng((await makeStillPng()).subarray(0, 20))).toBe(false);
  });

  it('returns false for a chunk declaring a bogus oversized length', async () => {
    const still = await makeStillPng();
    const ihdr = readPngChunks(still).find((chunk) => chunk.type === 'IHDR')!;
    // Hand-write a chunk header claiming ~4 GiB of payload that is not there.
    const bogusHeader = Buffer.alloc(8);
    bogusHeader.writeUInt32BE(0xfffffff0, 0);
    bogusHeader.write('tEXt', 4, 'ascii');

    const malformed = Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', ihdr.data), bogusHeader]);

    expect(await isAnimatedPng(malformed)).toBe(false);
  });

  it('scans a chunk-dense buffer in bounded time', async () => {
    // A 10 MB upload (the default attachment ceiling) made entirely of
    // zero-length chunks holds ~870k of them; the walk must stay linear.
    const emptyChunk = pngChunk('tEXt', Buffer.alloc(0));
    const chunkCount = Math.floor((10 * 1024 * 1024) / emptyChunk.length);
    const dense = Buffer.concat([PNG_SIGNATURE, ...Array(chunkCount).fill(emptyChunk)]);

    expect(chunkCount).toBeGreaterThan(800_000);

    const startedAt = Date.now();
    let timerFired = false;
    const timer = setTimeout(() => {
      timerFired = true;
    }, 0);

    expect(await isAnimatedPng(dense)).toBe(false);
    clearTimeout(timer);
    expect(timerFired).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  }, 30_000);
});

describe('decode pixel limit', () => {
  const makePixelBomb = () =>
    sharp({
      create: { width: 9000, height: 9000, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();

  it('caps input pixels well below sharp default', () => {
    expect(MAX_INPUT_PIXELS).toBeLessThan(268_402_689);
  });

  it('refuses to decode an oversized-pixel avatar', async () => {
    const bomb = await makePixelBomb();
    expect(9000 * 9000).toBeGreaterThan(MAX_INPUT_PIXELS);

    await expect(compressAvatarBuffer(bomb)).rejects.toThrow(/pixel limit/i);
  });

  it('refuses to decode an oversized-pixel attachment', async () => {
    await expect(compressAttachmentBuffer(await makePixelBomb())).rejects.toThrow(/pixel limit/i);
  });

  it('still processes a normal-sized image', async () => {
    const normal = await sharp({
      create: { width: 400, height: 300, channels: 3, background: { r: 60, g: 70, b: 80 } },
    })
      .png()
      .toBuffer();

    const out = await compressAvatarBuffer(normal);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(256);
  });
});
