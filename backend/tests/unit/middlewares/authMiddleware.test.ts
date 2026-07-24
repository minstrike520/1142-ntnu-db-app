import { describe, it, expect, beforeEach, afterEach, mock, spyOn, type Mock } from 'bun:test';
import { Request, Response, NextFunction } from 'express';
import { authMiddleware } from '../../../src/middlewares/authMiddleware';
import * as jwtHelper from '../../../src/utils/jwt';
import { AppError } from '../../../src/utils/AppError';
import pool from '../../../src/models/db';

mock.module('../../../src/models/db', () => ({
  default: { query: mock() },
}));

describe('authMiddleware', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let nextFunction: NextFunction;

  beforeEach(() => {
    mockRequest = {
      headers: {},
    };
    mockResponse = {};
    nextFunction = mock() as any;
    ((pool.query as any) as Mock<any>).mockResolvedValue({ rows: [{}] } as any);
  });

  afterEach(() => {
    mock.restore();
    mock.clearAllMocks();
  });

  it('calls next with 401 when auth token is missing', async () => {
    await authMiddleware(mockRequest as Request, mockResponse as Response, nextFunction);
    expect(nextFunction).toHaveBeenCalledTimes(1);
    const arg = (nextFunction as any as Mock<any>).mock.calls[0][0] as AppError;
    expect(arg).toBeInstanceOf(AppError);
    expect(arg.statusCode).toBe(401);
    expect(arg.message).toMatch(/Missing authentication token/);
  });

  it('calls next with 401 when Authorization header is malformed and no cookie exists', async () => {
    mockRequest.headers = { authorization: 'Basic sometoken' };
    await authMiddleware(mockRequest as Request, mockResponse as Response, nextFunction);
    expect(nextFunction).toHaveBeenCalledTimes(1);
    const arg = (nextFunction as any as Mock<any>).mock.calls[0][0] as AppError;
    expect(arg).toBeInstanceOf(AppError);
    expect(arg.statusCode).toBe(401);
    expect(arg.message).toMatch(/Missing authentication token/);
  });

  it('calls next with 401 when token is invalid', async () => {
    mockRequest.headers = { authorization: 'Bearer invalid-token' };
    spyOn(jwtHelper, 'verifyToken').mockImplementation(() => {
      throw new Error('Invalid token');
    });

    await authMiddleware(mockRequest as Request, mockResponse as Response, nextFunction);
    expect(nextFunction).toHaveBeenCalledTimes(1);
    const arg = (nextFunction as any as Mock<any>).mock.calls[0][0] as AppError;
    expect(arg).toBeInstanceOf(AppError);
    expect(arg.statusCode).toBe(401);
    expect(arg.message).toMatch(/Invalid token/);
  });

  it('calls next() and populates (req as any).user when token is valid and user is active', async () => {
    mockRequest.headers = { authorization: 'Bearer valid-token' };
    const mockPayload = { userId: '1', name: 'Test User' };
    
    spyOn(jwtHelper, 'verifyToken').mockReturnValue(mockPayload as any);

    await authMiddleware(mockRequest as Request, mockResponse as Response, nextFunction);

    expect((mockRequest as any).user).toEqual(mockPayload);
    expect(nextFunction).toHaveBeenCalledTimes(1);
    expect(nextFunction).toHaveBeenCalledWith(); // called with no args
  });

  it('prefers the HttpOnly auth cookie token when present', async () => {
    mockRequest.headers = {
      authorization: 'Bearer header-token',
      cookie: 'theme=dark; auth_token=cookie-token',
    };
    const mockPayload = { userId: '1', name: 'Test User' };

    spyOn(jwtHelper, 'verifyToken').mockReturnValue(mockPayload as any);

    await authMiddleware(mockRequest as Request, mockResponse as Response, nextFunction);

    expect(jwtHelper.verifyToken).toHaveBeenCalledWith('cookie-token');
    expect((mockRequest as any).user).toEqual(mockPayload);
    expect(nextFunction).toHaveBeenCalledTimes(1);
    expect(nextFunction).toHaveBeenCalledWith();
  });

  it('calls next with 401 when user is not found in the database', async () => {
    mockRequest.headers = { authorization: 'Bearer valid-token' };
    spyOn(jwtHelper, 'verifyToken').mockReturnValue({ userId: '1', name: 'Test User' } as any);
    ((pool.query as any) as Mock<any>).mockResolvedValueOnce({ rows: [] } as any);
    await authMiddleware(mockRequest as Request, mockResponse as Response, nextFunction);
    const arg = (nextFunction as any as Mock<any>).mock.calls[0][0] as AppError;
    expect(arg).toBeInstanceOf(AppError);
    expect(arg.statusCode).toBe(401);
    expect(arg.message).toMatch(/not found or deleted/);
  });

  it('calls next with the original AppError when verifyToken throws an AppError', async () => {
    mockRequest.headers = { authorization: 'Bearer valid-token' };
    const customErr = new AppError(403, 'Custom forbidden');
    spyOn(jwtHelper, 'verifyToken').mockImplementation(() => { throw customErr; });
    await authMiddleware(mockRequest as Request, mockResponse as Response, nextFunction);
    expect(nextFunction).toHaveBeenCalledWith(customErr);
  });
});
