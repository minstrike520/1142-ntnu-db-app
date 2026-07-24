import type { ErrorHandler } from 'hono';
import { mapErrorToApiShape } from '../utils/mapError';

export const errorHandler: ErrorHandler = (err, c) => {
  const body = mapErrorToApiShape(err);
  return c.json(body, body.statusCode as any);
};
