import type { UploadedFile } from '../../../src/utils/fileUpload';
import { describe, it, expect, afterEach } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import sharp from 'sharp';
import { ValidationError } from '../../../src/utils/AppError';
import {
  AVATAR_UPLOAD_MAX_BYTES,
  assertValidAvatarUpload,
  avatarContentType,
  removeManagedAvatar,
  saveAvatarUpload,
} from '../../../src/utils/avatarUpload';
import { AVATARS_UPLOAD_DIR, ensureUploadDirectories } from '../../../src/utils/uploads';

const makeFile = (mimetype: string, bytes: number[]): UploadedFile =>
  ({
    fieldname: 'file',
    originalname: 'avatar',
    encoding: '7bit',
    mimetype,
    size: bytes.length,
    buffer: Buffer.from(bytes),
  }) as UploadedFile;

describe('avatarUpload helpers', () => {
  it('accepts matching png content', () => {
    const extension = assertValidAvatarUpload(
      makeFile('image/png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );

    expect(extension).toBe('.png');
  });

  it('rejects unsupported mimetypes', () => {
    expect(() =>
      assertValidAvatarUpload(makeFile('image/svg+xml', [0x3c, 0x73, 0x76, 0x67])),
    ).toThrow(ValidationError);
  });

  it('rejects mismatched content signatures', () => {
    expect(() =>
      assertValidAvatarUpload(makeFile('image/png', [0xff, 0xd8, 0xff, 0xe0])),
    ).toThrow(ValidationError);
  });
});

describe('saveAvatarUpload', () => {
  const createdFiles: string[] = [];

  afterEach(async () => {
    while (createdFiles.length > 0) {
      const file = createdFiles.pop()!;
      await fs.rm(file, { force: true });
    }
  });

  const makeUploadFile = (buffer: Buffer, mimetype: string): UploadedFile =>
    ({
      fieldname: 'file',
      originalname: 'avatar',
      encoding: '7bit',
      mimetype,
      size: buffer.length,
      buffer,
    }) as UploadedFile;

  it('always re-encodes the stored avatar to a 256x256 WebP file', async () => {
    ensureUploadDirectories();
    const pngBuffer = await sharp({
      create: { width: 800, height: 400, channels: 3, background: { r: 5, g: 100, b: 200 } },
    })
      .png()
      .toBuffer();

    const avatarUrl = await saveAvatarUpload('user-webp', makeUploadFile(pngBuffer, 'image/png'));
    const fullPath = path.join(AVATARS_UPLOAD_DIR, path.basename(avatarUrl));
    createdFiles.push(fullPath);

    expect(avatarUrl.endsWith('.webp')).toBe(true);

    const stored = await fs.readFile(fullPath);
    expect(stored.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(stored.subarray(8, 12).toString('ascii')).toBe('WEBP');

    const metadata = await sharp(stored).metadata();
    expect(metadata.width).toBe(256);
    expect(metadata.height).toBe(256);
  });

  it('rejects avatars that fail content validation before any compression happens', async () => {
    await expect(
      saveAvatarUpload('user-invalid', makeUploadFile(Buffer.from([0xff, 0xd8, 0xff]), 'image/png')),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects a pixel bomb that slips under the byte-size limit', async () => {
    // 9000x9000 (~81 MP) solid PNG compresses to a few hundred KB, so it
    // passes the 2 MB avatar byte limit; only the decode-time pixel cap
    // stops it. Avatars must be decoded to be stored, so this is a 400.
    const bomb = await sharp({
      create: { width: 9000, height: 9000, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();

    expect(bomb.length).toBeLessThan(AVATAR_UPLOAD_MAX_BYTES);
    await expect(
      saveAvatarUpload('user-bomb', makeUploadFile(bomb, 'image/png')),
    ).rejects.toThrow(ValidationError);
  });

  it('surfaces a truncated-but-valid-signature image as a ValidationError, not a raw sharp failure', async () => {
    // Passes the magic-byte check (real PNG signature) but has no image body,
    // so sharp cannot decode it. Must map to a 400-style ValidationError.
    const truncatedPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    await expect(
      saveAvatarUpload('user-truncated', makeUploadFile(truncatedPng, 'image/png')),
    ).rejects.toThrow(ValidationError);
  });
});

describe('removeManagedAvatar', () => {
  const createdFiles: string[] = [];

  const makeManagedFile = async (ownerId: string): Promise<string> => {
    // Must be awaited: `uploads/` is gitignored, so on a fresh checkout the
    // avatars directory does not exist yet and the write below races the
    // directory creation, failing with ENOENT.
    await ensureUploadDirectories();
    const fileName = `${ownerId}-${crypto.randomUUID()}.png`;
    const fullPath = path.join(AVATARS_UPLOAD_DIR, fileName);
    await fs.writeFile(fullPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    createdFiles.push(fullPath);
    return `/uploads/avatars/${fileName}`;
  };

  afterEach(async () => {
    while (createdFiles.length > 0) {
      const file = createdFiles.pop()!;
      await fs.rm(file, { force: true });
    }
  });

  it('deletes a managed avatar that belongs to the owner', async () => {
    const ownerId = 'user-owns-this';
    const avatarUrl = await makeManagedFile(ownerId);
    const fullPath = path.join(AVATARS_UPLOAD_DIR, path.basename(avatarUrl));

    await removeManagedAvatar(avatarUrl, ownerId);

    await expect(fs.access(fullPath)).rejects.toThrow();
  });

  it('refuses to delete a file whose prefix does not match the owner', async () => {
    const victimId = 'victim-user';
    const attackerId = 'attacker-user';
    const victimUrl = await makeManagedFile(victimId);
    const fullPath = path.join(AVATARS_UPLOAD_DIR, path.basename(victimUrl));

    // Attacker attempts to delete the victim's file by passing the victim URL.
    await removeManagedAvatar(victimUrl, attackerId);

    // Victim's file must still exist.
    await fs.access(fullPath);
  });

  it('ignores non-managed urls', async () => {
    await expect(
      removeManagedAvatar('http://evil.example/uploads/avatars/x.png', 'anyone'),
    ).resolves.toBeUndefined();
    await expect(removeManagedAvatar('', 'anyone')).resolves.toBeUndefined();
    await expect(removeManagedAvatar(undefined, 'anyone')).resolves.toBeUndefined();
  });

  describe('avatarContentType', () => {
    it('maps every allowed avatar extension to its real type', () => {
      expect(avatarContentType('a.png')).toBe('image/png');
      expect(avatarContentType('a.jpg')).toBe('image/jpeg');
      expect(avatarContentType('a.jpeg')).toBe('image/jpeg');
      expect(avatarContentType('a.gif')).toBe('image/gif');
      expect(avatarContentType('a.webp')).toBe('image/webp');
    });

    it('does not label a PNG avatar as JPEG', () => {
      expect(avatarContentType('user-uuid.png')).not.toBe('image/jpeg');
    });

    it('is case-insensitive', () => {
      expect(avatarContentType('A.PNG')).toBe('image/png');
    });

    it('falls back to a neutral type for unknown or missing extensions', () => {
      expect(avatarContentType('noext')).toBe('application/octet-stream');
      expect(avatarContentType('a.svg')).toBe('application/octet-stream');
    });
  });
});
