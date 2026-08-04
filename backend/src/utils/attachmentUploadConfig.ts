import {
  DEFAULT_ATTACHMENT_ALLOWED_EXTENSIONS,
  DEFAULT_ATTACHMENT_ALLOWED_MIME_TYPES,
  DEFAULT_ATTACHMENT_MAX_BYTES,
  env,
} from '../config/env';

export {
  DEFAULT_ATTACHMENT_ALLOWED_MIME_TYPES,
  DEFAULT_ATTACHMENT_ALLOWED_EXTENSIONS,
  DEFAULT_ATTACHMENT_MAX_BYTES,
};

export const defaultAttachmentUploadConfig = {
  allowedMimeTypes: [...DEFAULT_ATTACHMENT_ALLOWED_MIME_TYPES],
  allowedExtensions: [...DEFAULT_ATTACHMENT_ALLOWED_EXTENSIONS],
  maxBytes: DEFAULT_ATTACHMENT_MAX_BYTES,
};

/**
 * The attachment slice of the typed config.
 *
 * Kept as a named factory so tests can hand it a literal environment; the
 * parsing itself lives in `config/env.ts` with every other variable.
 */
export const createAttachmentUploadConfig = (source: NodeJS.ProcessEnv = process.env) =>
  env(source).attachments;

export const attachmentUploadConfig = createAttachmentUploadConfig();
