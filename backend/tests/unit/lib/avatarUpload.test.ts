import { describe, it, expect, afterEach } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { ValidationError } from '../../../src/errors/AppError';
import { assertValidAvatarUpload, removeManagedAvatar } from '../../../src/lib/avatarUpload';
import { AVATARS_UPLOAD_DIR, ensureUploadDirectories } from '../../../src/lib/uploads';

const makeFile = (mimetype: string, bytes: number[]): Express.Multer.File =>
  ({
    fieldname: 'file',
    originalname: 'avatar',
    encoding: '7bit',
    mimetype,
    size: bytes.length,
    buffer: Buffer.from(bytes),
  }) as Express.Multer.File;

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

describe('removeManagedAvatar', () => {
  const createdFiles: string[] = [];

  const makeManagedFile = async (ownerId: string): Promise<string> => {
    ensureUploadDirectories();
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
});
