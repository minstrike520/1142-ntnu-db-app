import sharp from 'sharp';

export const AVATAR_DIMENSION = 256;
export const AVATAR_WEBP_QUALITY = 80;

export const ATTACHMENT_MAX_DIMENSION = 4096;
export const ATTACHMENT_WEBP_QUALITY = 80;

// Upload routes only cap the *compressed* byte size, which says nothing about
// how many pixels the file decodes to: a solid-colour 9000x9000 PNG (81 MP)
// compresses to well under 250 KB and would still sit comfortably inside the
// 2 MB avatar limit. Decoding that costs hundreds of MB of RAM and blocks a
// libvips worker, so a handful of concurrent uploads could degrade the whole
// API. Cap the pixel count at decode time rather than relying on byte size;
// sharp's own default (~268 MP) is far too permissive for this service.
export const MAX_INPUT_PIXELS = 64_000_000;

// Only re-encode formats where converting to a single static WebP frame is a
// safe, lossless-in-intent operation. GIF is excluded because it may be
// animated and sharp would silently collapse it to its first frame.
export const COMPRESSIBLE_ATTACHMENT_MIME_TYPES = new Set(['image/jpeg', 'image/png']);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Each PNG chunk is: 4-byte length, 4-byte type, payload, 4-byte CRC.
const PNG_CHUNK_HEADER_BYTES = 8;
const PNG_CHUNK_OVERHEAD_BYTES = 12;
const PNG_SCAN_YIELD_INTERVAL = 4_096;

type ChunkVerdict = 'animated' | 'still' | 'keep-looking';

/**
 * `acTL` marks an APNG and the spec requires it before the first `IDAT`, so
 * reaching image data (or the end of the stream) means it is a still image.
 */
const classifyChunk = (type: string): ChunkVerdict => {
  if (type === 'acTL') return 'animated';
  if (type === 'IDAT' || type === 'IEND') return 'still';
  return 'keep-looking';
};

/**
 * Detects an animated PNG (APNG) from a complete in-memory PNG.
 *
 * This deliberately parses the chunk stream instead of asking sharp, because
 * `sharp().metadata()` reports `pages: 1` for APNG unless libvips was built
 * with APNG support — so metadata-based detection silently misses them and the
 * animation would be flattened to frame one.
 */
export const isAnimatedPng = async (buffer: Buffer): Promise<boolean> => {
  if (buffer.length < PNG_SIGNATURE.length || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return false;
  }

  let offset = PNG_SIGNATURE.length;
  let chunksScanned = 0;

  while (offset + PNG_CHUNK_HEADER_BYTES <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const verdict = classifyChunk(buffer.subarray(offset + 4, offset + 8).toString('ascii'));

    if (verdict !== 'keep-looking') return verdict === 'animated';

    offset += PNG_CHUNK_OVERHEAD_BYTES + length;
    chunksScanned += 1;

    // A valid upload can contain many ancillary chunks. Yield periodically so
    // a chunk-dense PNG cannot monopolize Bun's event loop while it is scanned.
    if (chunksScanned % PNG_SCAN_YIELD_INTERVAL === 0) {
      await Bun.sleep(0);
    }
  }

  return false;
};

export const compressAvatarBuffer = (buffer: Buffer): Promise<Buffer> =>
  sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .resize(AVATAR_DIMENSION, AVATAR_DIMENSION, { fit: 'cover' })
    .webp({ quality: AVATAR_WEBP_QUALITY })
    .toBuffer();

export const compressAttachmentBuffer = (buffer: Buffer): Promise<Buffer> =>
  sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .resize(ATTACHMENT_MAX_DIMENSION, ATTACHMENT_MAX_DIMENSION, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: ATTACHMENT_WEBP_QUALITY })
    .toBuffer();
