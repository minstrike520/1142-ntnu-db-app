import { describe, it, expect } from 'bun:test';
import {
  createAttachmentUploadConfig,
  DEFAULT_ATTACHMENT_ALLOWED_EXTENSIONS,
  DEFAULT_ATTACHMENT_ALLOWED_MIME_TYPES,
  DEFAULT_ATTACHMENT_MAX_BYTES,
} from '../../../src/lib/attachmentUploadConfig';

describe('createAttachmentUploadConfig', () => {
  it('uses type-open defaults when restriction is not configured', () => {
    const config = createAttachmentUploadConfig({});

    expect(config).toEqual({
      restrictionEnabled: false,
      allowedMimeTypes: [...DEFAULT_ATTACHMENT_ALLOWED_MIME_TYPES],
      allowedExtensions: [...DEFAULT_ATTACHMENT_ALLOWED_EXTENSIONS],
      maxBytes: DEFAULT_ATTACHMENT_MAX_BYTES,
    });
  });

  it('normalizes custom allowlists and max bytes from env', () => {
    const config = createAttachmentUploadConfig({
      ATTACHMENT_TYPE_RESTRICTION_ENABLED: 'true',
      ATTACHMENT_ALLOWED_MIME_TYPES: 'image/webp, application/json ',
      ATTACHMENT_ALLOWED_EXTENSIONS: '.WEBP, .json ',
      ATTACHMENT_MAX_BYTES: '2048',
    });

    expect(config).toEqual({
      restrictionEnabled: true,
      allowedMimeTypes: ['image/webp', 'application/json'],
      allowedExtensions: ['.webp', '.json'],
      maxBytes: 2048,
    });
  });

  it('falls back to defaults for invalid boolean, csv, or size values', () => {
    const config = createAttachmentUploadConfig({
      ATTACHMENT_TYPE_RESTRICTION_ENABLED: 'maybe',
      ATTACHMENT_ALLOWED_MIME_TYPES: '   ',
      ATTACHMENT_ALLOWED_EXTENSIONS: '',
      ATTACHMENT_MAX_BYTES: '-1',
    });

    expect(config).toEqual({
      restrictionEnabled: false,
      allowedMimeTypes: [...DEFAULT_ATTACHMENT_ALLOWED_MIME_TYPES],
      allowedExtensions: [...DEFAULT_ATTACHMENT_ALLOWED_EXTENSIONS],
      maxBytes: DEFAULT_ATTACHMENT_MAX_BYTES,
    });
  });
});
