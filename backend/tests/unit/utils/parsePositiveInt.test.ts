import { describe, it, expect } from 'bun:test';
import { parsePositiveInt } from '../../../src/utils/parsePositiveInt';

describe('parsePositiveInt', () => {
  it('parses a valid positive integer string', () => {
    expect(parsePositiveInt('42', 7)).toBe(42);
  });

  it('returns fallback when value is undefined', () => {
    expect(parsePositiveInt(undefined, 7)).toBe(7);
  });

  it('returns fallback for a non-numeric string', () => {
    expect(parsePositiveInt('abc', 7)).toBe(7);
  });

  it('returns fallback for zero', () => {
    expect(parsePositiveInt('0', 7)).toBe(7);
  });

  it('returns fallback for a negative integer', () => {
    expect(parsePositiveInt('-5', 7)).toBe(7);
  });

  it('returns fallback for a non-integer number', () => {
    expect(parsePositiveInt('3.14', 7)).toBe(7);
  });
});
