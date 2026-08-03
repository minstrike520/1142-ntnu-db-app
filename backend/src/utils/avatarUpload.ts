import type { UploadedFile } from './fileUpload';
import crypto from 'crypto';
import path from 'path';
import { ValidationError } from '../utils/AppError';
import { AVATARS_UPLOAD_DIR } from './uploads';
import { compressAvatarBuffer } from './imageCompression';

export const AVATAR_UPLOAD_MAX_BYTES = 2 * 1024 * 1024;

export const ALLOWED_AVATAR_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

const ALLOWED_AVATAR_TYPES: Record<(typeof ALLOWED_AVATAR_MIME_TYPES)[number], string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

const AVATAR_EXTENSION_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/**
 * Content-Type for a stored avatar, derived from its extension.
 *
 * Newly stored avatars are always `.webp`, but avatars saved before that
 * conversion are still on disk as PNG, GIF or JPEG. Serving those as
 * `image/jpeg` mislabels most of them — a mismatch that clients enforcing
 * `nosniff` may reject or cache wrongly — so keep deriving the type per file.
 */
export const avatarContentType = (fileName: string): string => {
  const extension = fileName.toLowerCase().match(/\.[^.]+$/)?.[0];
  return (extension && AVATAR_EXTENSION_MIME_TYPES[extension]) || 'application/octet-stream';
};

const hasPrefix = (buffer: Buffer, prefix: number[]): boolean =>
  prefix.every((value, index) => buffer[index] === value);

const detectAvatarExtension = (buffer: Buffer): string | null => {
  if (buffer.length >= 8 && hasPrefix(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return '.png';
  }
  if (buffer.length >= 3 && hasPrefix(buffer, [0xff, 0xd8, 0xff])) {
    return '.jpg';
  }
  if (buffer.length >= 6) {
    const signature = buffer.subarray(0, 6).toString('ascii');
    if (signature === 'GIF87a' || signature === 'GIF89a') {
      return '.gif';
    }
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return '.webp';
  }

  return null;
};

export const assertValidAvatarUpload = (file: UploadedFile): string => {
  if (!file.buffer || file.buffer.length === 0) {
    throw new ValidationError('Avatar file is empty');
  }

  const mimeType = file.mimetype as keyof typeof ALLOWED_AVATAR_TYPES;
  const expectedExtension = ALLOWED_AVATAR_TYPES[mimeType];
  if (!expectedExtension) {
    throw new ValidationError('Unsupported avatar file type');
  }

  const detectedExtension = detectAvatarExtension(file.buffer);
  if (!detectedExtension || detectedExtension !== expectedExtension) {
    throw new ValidationError('Avatar file content does not match its declared type');
  }

  return detectedExtension;
};

export const saveAvatarUpload = async (
  userId: string,
  file: UploadedFile,
): Promise<string> => {
  assertValidAvatarUpload(file);

  // Re-encode every avatar to a fixed-size WebP regardless of the uploaded
  // format, so stored avatars have a predictable size and format on disk.
  // Note: an animated upload (GIF, or an animated WebP — both are accepted by
  // `ALLOWED_AVATAR_MIME_TYPES`) loses its animation here, collapsing to a
  // single still frame — an accepted tradeoff for a small profile picture.
  //
  // `assertValidAvatarUpload` only checks the magic-byte prefix, so a
  // truncated or otherwise corrupt image still reaches this point. Surface
  // that as a client validation error rather than letting the raw sharp
  // failure bubble up to the global handler as a 500.
  let compressed: Buffer;
  try {
    compressed = await compressAvatarBuffer(file.buffer);
  } catch {
    throw new ValidationError('Avatar file content could not be processed as an image');
  }
  const storedName = `${userId}-${crypto.randomUUID()}.webp`;
  const targetPath = path.join(AVATARS_UPLOAD_DIR, storedName);

  await Bun.write(targetPath, compressed);

  return `/uploads/avatars/${storedName}`;
};

export const removeManagedAvatar = async (
  avatarUrl?: string,
  ownerId?: string,
): Promise<void> => {
  if (!avatarUrl || !avatarUrl.startsWith('/uploads/avatars/')) {
    return;
  }

  const fileName = path.basename(avatarUrl);

  // Defense in depth: only ever delete files that this owner produced.
  // `saveAvatarUpload` always names files `${userId}-<uuid><ext>`, so a managed
  // avatar belonging to `ownerId` must carry that prefix. This prevents one
  // user's stored avatarUrl from ever pointing the unlink at another user's
  // file, even if a future write path lets an arbitrary value reach here.
  if (ownerId && !fileName.startsWith(`${ownerId}-`)) {
    return;
  }

  const targetPath = path.join(AVATARS_UPLOAD_DIR, fileName);

  try {
    await Bun.file(targetPath).delete();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
};

/**
 * The avatar side effects a service needs, as an injectable seam.
 *
 * Services take this instead of importing `saveAvatarUpload` /
 * `removeManagedAvatar` directly so their unit tests can pass a stub through
 * the factory. The alternative — `mock.module('../utils/avatarUpload', ...)` —
 * mutates Bun's process-global module registry, so it also replaces the real
 * implementation for every other test file in the same `bun test` process and
 * cannot be undone (re-registering the original module does not restore the
 * binding). That made this module's own tests pass or fail purely on test-file
 * enumeration order. See issue #467.
 */
export interface AvatarStore {
  saveAvatarUpload(ownerId: string, file: UploadedFile): Promise<string>;
  removeManagedAvatar(avatarUrl?: string, ownerId?: string): Promise<void>;
}

export const defaultAvatarStore: AvatarStore = {
  saveAvatarUpload,
  removeManagedAvatar,
};
