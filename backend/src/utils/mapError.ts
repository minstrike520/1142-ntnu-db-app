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

  const errObj = err as any;
  if (errObj && (errObj.name === 'MulterError' || errObj.code === 'LIMIT_FILE_SIZE')) {
    return {
      statusCode: errObj.code === 'LIMIT_FILE_SIZE' ? 413 : 400,
      message: errObj.code === 'LIMIT_FILE_SIZE' ? 'Attachment file exceeds the configured size limit' : (errObj.message || 'File upload error'),
      code: errObj.code || 'UPLOAD_ERROR',
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
