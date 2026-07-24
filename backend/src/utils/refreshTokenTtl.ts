import { parsePositiveInt } from '../utils/parsePositiveInt';

export const DEFAULT_REFRESH_TTL_DAYS = 14;

export const getRefreshTokenTtlMs = (): number =>
  parsePositiveInt(process.env.JWT_REFRESH_EXPIRES_IN_DAYS, DEFAULT_REFRESH_TTL_DAYS) *
  24 * 60 * 60 * 1000;
