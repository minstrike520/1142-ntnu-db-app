import multer from 'multer';
import { AppError } from './AppError';
import type { ApiError } from '@shared/types';

export const mapErrorToApiShape = (err: unknown): ApiError => {
  if (err instanceof AppError) {
    const apiError: ApiError = {
      statusCode: err.statusCode,
      message: err.message,
    };
    if (err.code !== undefined) {
      apiError.code = err.code;
    }
    return apiError;
  }

  if (err instanceof multer.MulterError) {
    return {
      statusCode: err.code === 'LIMIT_FILE_SIZE' ? 413 : 400,
      message: err.code === 'LIMIT_FILE_SIZE' ? 'Attachment file exceeds the configured size limit' : err.message,
      code: err.code,
    };
  }

  // Unknown / unexpected errors
  if (process.env.NODE_ENV !== 'test') {
    console.error("APP ERROR:", err);
  }
  return {
    statusCode: 500,
    message: 'Internal Server Error',
    code: 'INTERNAL_ERROR',
  };
};
