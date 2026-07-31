import type { UploadedFile } from './fileUpload';
import crypto from 'crypto';
import path from 'path';
import { ValidationError } from '../utils/AppError';
import { AVATARS_UPLOAD_DIR } from './uploads';

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
 * Avatar uploads accept PNG, GIF, WebP and JPEG, so serving everything as
 * `image/jpeg` mislabels most of them — a mismatch that clients enforcing
 * `nosniff` may reject or cache wrongly.
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
  const extension = assertValidAvatarUpload(file);
  const storedName = `${userId}-${crypto.randomUUID()}${extension}`;
  const targetPath = path.join(AVATARS_UPLOAD_DIR, storedName);

  await Bun.write(targetPath, file.buffer);

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
