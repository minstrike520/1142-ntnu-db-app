import { describe, it, expect, mock, type Mock } from 'bun:test';
import type { Request, Response, NextFunction } from 'express';
import { errorHandler } from '../../../src/middlewares/errorHandler';
import {
  AppError,
  NotFoundError,
  ForbiddenError,
  ValidationError,
  ConflictError,
} from '../../../src/errors/AppError';

function makeRes() {
  const res = {
    status: mock().mockReturnThis(),
    json: mock().mockReturnThis(),
  } as unknown as Response;
  return res;
}

const req = {} as Request;
const next = mock() as unknown as NextFunction;

describe('errorHandler middleware', () => {
  it('maps NotFoundError → 404 with ApiError body', () => {
    const res = makeRes();
    const err = new NotFoundError('user', 42);
    errorHandler(err, req, res, next);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      statusCode: 404,
      message: 'user with id 42 not found',
      code: 'NOT_FOUND',
    });
  });

  it('maps ForbiddenError → 403 with ApiError body', () => {
    const res = makeRes();
    const err = new ForbiddenError();
    errorHandler(err, req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      statusCode: 403,
      message: 'Forbidden',
      code: 'FORBIDDEN',
    });
  });

  it('maps ForbiddenError with custom message → 403', () => {
    const res = makeRes();
    const err = new ForbiddenError('You shall not pass');
    errorHandler(err, req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(((res.json as Mock<any>).mock.calls[0][0] as any).message).toBe('You shall not pass');
  });

  it('maps ValidationError → 400 with ApiError body', () => {
    const res = makeRes();
    const err = new ValidationError('username is required');
    errorHandler(err, req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      statusCode: 400,
      message: 'username is required',
      code: 'VALIDATION_ERROR',
    });
  });

  it('maps ConflictError → 409 with ApiError body', () => {
    const res = makeRes();
    const err = new ConflictError('username already taken');
    errorHandler(err, req, res, next);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      statusCode: 409,
      message: 'username already taken',
      code: 'CONFLICT',
    });
  });

  it('maps generic AppError → correct statusCode', () => {
    const res = makeRes();
    const err = new AppError(418, "I'm a teapot", 'TEAPOT');
    errorHandler(err, req, res, next);
    expect(res.status).toHaveBeenCalledWith(418);
    expect(res.json).toHaveBeenCalledWith({
      statusCode: 418,
      message: "I'm a teapot",
      code: 'TEAPOT',
    });
  });

  it('maps unknown Error → 500 without stack', () => {
    const res = makeRes();
    const err = new Error('something exploded');
    errorHandler(err, req, res, next);
    expect(res.status).toHaveBeenCalledWith(500);
    const body = (res.json as Mock<any>).mock.calls[0][0] as any;
    expect(body.statusCode).toBe(500);
    expect(body.message).toBe('Internal Server Error');
    expect(body.stack).toBeUndefined();
  });

  it('maps non-Error unknown → 500', () => {
    const res = makeRes();
    errorHandler('string error', req, res, next);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(((res.json as Mock<any>).mock.calls[0][0] as any).statusCode).toBe(500);
  });
});
