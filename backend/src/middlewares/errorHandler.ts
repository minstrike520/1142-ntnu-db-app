import type { ErrorHandler, Context } from 'hono';
import type { Response as ExpressResponse } from 'express';
import { mapErrorToApiShape } from '../utils/mapError';

// ponytail: Dual-mode error handler supporting both Express (4 args: err, req, res, next) and Hono (2 args: err, c)
export const errorHandler = ((err: any, cOrReq: any, resOrC?: any, maybeNext?: any) => {
  const isExpress = typeof maybeNext === 'function';

  if (isExpress) {
    const res = resOrC as ExpressResponse;
    const body = mapErrorToApiShape(err);
    res.status(body.statusCode).json(body);
  } else {
    // Hono Mode: (err, c) where cOrReq is Hono Context 'c'
    const c = cOrReq as Context;
    const body = mapErrorToApiShape(err);
    return c.json(body, body.statusCode as any);
  }
}) as any;
