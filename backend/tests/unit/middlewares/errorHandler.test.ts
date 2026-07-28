import { describe, it, expect, mock, type Mock } from 'bun:test';
import type { Context } from 'hono';
import { errorHandler } from '../../../src/middlewares/errorHandler';
import {
  AppError,
  NotFoundError,
  ForbiddenError,
  ValidationError,
  ConflictError,
} from '../../../src/utils/AppError';

function makeHonoContext() {
  const c = {
    json: mock().mockReturnThis(),
  } as unknown as Context;
  return c;
}

describe('errorHandler middleware', () => {
  it('maps NotFoundError → 404 with ApiError body', () => {
    const c = makeHonoContext();
    const err = new NotFoundError('user', 42);
    errorHandler(err, c);
    expect(c.json).toHaveBeenCalledWith(
      {
        statusCode: 404,
        message: 'user with id 42 not found',
        code: 'NOT_FOUND',
      },
      404
    );
  });

  it('maps ForbiddenError → 403 with ApiError body', () => {
    const c = makeHonoContext();
    const err = new ForbiddenError();
    errorHandler(err, c);
    expect(c.json).toHaveBeenCalledWith(
      {
        statusCode: 403,
        message: 'Forbidden',
        code: 'FORBIDDEN',
      },
      403
    );
  });

  it('maps ForbiddenError with custom message → 403', () => {
    const c = makeHonoContext();
    const err = new ForbiddenError('You shall not pass');
    errorHandler(err, c);
    expect(((c.json as Mock<any>).mock.calls[0][0] as any).message).toBe('You shall not pass');
  });

  it('maps ValidationError → 400 with ApiError body', () => {
    const c = makeHonoContext();
    const err = new ValidationError('username is required');
    errorHandler(err, c);
    expect(c.json).toHaveBeenCalledWith(
      {
        statusCode: 400,
        message: 'username is required',
        code: 'VALIDATION_ERROR',
      },
      400
    );
  });

  it('maps ConflictError → 409 with ApiError body', () => {
    const c = makeHonoContext();
    const err = new ConflictError('username already taken');
    errorHandler(err, c);
    expect(c.json).toHaveBeenCalledWith(
      {
        statusCode: 409,
        message: 'username already taken',
        code: 'CONFLICT',
      },
      409
    );
  });

  it('maps generic AppError → correct statusCode', () => {
    const c = makeHonoContext();
    const err = new AppError(418, "I'm a teapot", 'TEAPOT');
    errorHandler(err, c);
    expect(c.json).toHaveBeenCalledWith(
      {
        statusCode: 418,
        message: "I'm a teapot",
        code: 'TEAPOT',
      },
      418
    );
  });

  it('maps unknown Error → 500 without stack', () => {
    const c = makeHonoContext();
    const err = new Error('something exploded');
    errorHandler(err, c);
    const body = (c.json as Mock<any>).mock.calls[0][0] as any;
    expect(body.statusCode).toBe(500);
    expect(body.message).toBe('Internal Server Error');
    expect(body.stack).toBeUndefined();
  });

  it('maps non-Error unknown → 500', () => {
    const c = makeHonoContext();
    errorHandler(new Error('string error'), c);
    expect(((c.json as Mock<any>).mock.calls[0][0] as any).statusCode).toBe(500);
  });
});
