export const DEFAULT_ATTACHMENT_ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'application/pdf',
  'application/zip',
  'text/plain',
] as const;

export const DEFAULT_ATTACHMENT_ALLOWED_EXTENSIONS = [
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.pdf',
  '.zip',
  '.txt',
] as const;

export const DEFAULT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

const parseBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return fallback;
};

const parseCsv = (value: string | undefined, fallback: readonly string[]): string[] => {
  if (!value || !value.trim()) {
    return [...fallback];
  }

  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
};

const parseMaxBytes = (value: string | undefined): number => {
  if (!value || !value.trim()) {
    return DEFAULT_ATTACHMENT_MAX_BYTES;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ATTACHMENT_MAX_BYTES;
};

export const defaultAttachmentUploadConfig = {
  allowedMimeTypes: [...DEFAULT_ATTACHMENT_ALLOWED_MIME_TYPES],
  allowedExtensions: [...DEFAULT_ATTACHMENT_ALLOWED_EXTENSIONS],
  maxBytes: DEFAULT_ATTACHMENT_MAX_BYTES,
};

export const createAttachmentUploadConfig = (env: NodeJS.ProcessEnv = process.env) => ({
  restrictionEnabled: parseBoolean(env.ATTACHMENT_TYPE_RESTRICTION_ENABLED, false),
  allowedMimeTypes: parseCsv(
    env.ATTACHMENT_ALLOWED_MIME_TYPES,
    DEFAULT_ATTACHMENT_ALLOWED_MIME_TYPES,
  ).map((mimeType) => mimeType.toLowerCase()),
  allowedExtensions: parseCsv(
    env.ATTACHMENT_ALLOWED_EXTENSIONS,
    DEFAULT_ATTACHMENT_ALLOWED_EXTENSIONS,
  ).map((extension) => extension.toLowerCase()),
  maxBytes: parseMaxBytes(env.ATTACHMENT_MAX_BYTES),
});

export const attachmentUploadConfig = createAttachmentUploadConfig();
