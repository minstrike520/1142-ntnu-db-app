import { describe, it, expect, spyOn } from 'bun:test';
import multer from 'multer';
import { mapErrorToApiShape } from '../../../src/utils/mapError';
import { AppError, ValidationError, ForbiddenError, NotFoundError, ConflictError } from '../../../src/utils/AppError';

describe('mapErrorToApiShape', () => {
  it('maps ValidationError (400)', () => {
    const err = new ValidationError('bad request');
    expect(mapErrorToApiShape(err)).toEqual({
      statusCode: 400,
      message: 'bad request',
      code: 'VALIDATION_ERROR',
    });
  });

  it('maps AppError directly (e.g. 401)', () => {
    const err = new AppError(401, 'unauth', 'UNAUTHORIZED');
    expect(mapErrorToApiShape(err)).toEqual({
      statusCode: 401,
      message: 'unauth',
      code: 'UNAUTHORIZED',
    });
  });

  it('maps ForbiddenError (403)', () => {
    const err = new ForbiddenError('forbidden');
    expect(mapErrorToApiShape(err)).toEqual({
      statusCode: 403,
      message: 'forbidden',
      code: 'FORBIDDEN',
    });
  });

  it('maps NotFoundError (404)', () => {
    const err = new NotFoundError('User', '123');
    expect(mapErrorToApiShape(err)).toEqual({
      statusCode: 404,
      message: 'User with id 123 not found',
      code: 'NOT_FOUND',
    });
  });

  it('maps ConflictError (409)', () => {
    const err = new ConflictError('conflict');
    expect(mapErrorToApiShape(err)).toEqual({
      statusCode: 409,
      message: 'conflict',
      code: 'CONFLICT',
    });
  });

  it('maps unknown errors to 500', () => {
    const err = new Error('database connection failed');
    expect(mapErrorToApiShape(err)).toEqual({
      statusCode: 500,
      message: 'Internal Server Error',
      code: 'INTERNAL_ERROR',
    });
  });

  it('logs unknown errors outside the test environment', () => {
    const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      const err = new Error('unexpected');
      expect(mapErrorToApiShape(err).statusCode).toBe(500);
      expect(consoleSpy).toHaveBeenCalledWith('APP ERROR:', err);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
      consoleSpy.mockRestore();
    }
  });

  it('maps attachment size overflow to 413', () => {
    const err = new multer.MulterError('LIMIT_FILE_SIZE');

    expect(mapErrorToApiShape(err)).toEqual({
      statusCode: 413,
      message: 'Attachment file exceeds the configured size limit',
      code: 'LIMIT_FILE_SIZE',
    });
  });

  it('maps non-size multer errors to 400', () => {
    const err = new multer.MulterError('LIMIT_FILE_COUNT');

    const result = mapErrorToApiShape(err);

    expect(result.statusCode).toBe(400);
    expect(result.code).toBe('LIMIT_FILE_COUNT');
    expect(result.message).toBe(err.message);
  });
});
