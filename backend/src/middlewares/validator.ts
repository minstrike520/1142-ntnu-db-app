import { zValidator } from '@hono/zod-validator';
import type { ValidationTargets } from 'hono';
import type { ZodSchema } from 'zod';
import { ValidationError } from '../utils/AppError';

export const validate = <T extends keyof ValidationTargets>(
  target: T,
  schema: ZodSchema
) =>
  zValidator(target, schema, (result) => {
    if (!result.success) {
      const firstError = result.error.issues[0]?.message || 'Validation failed';
      throw new ValidationError(firstError);
    }
  });
