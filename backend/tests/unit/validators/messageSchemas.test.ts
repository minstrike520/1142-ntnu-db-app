import { describe, expect, it } from 'vitest';
import {
  listMessagesSchema,
  recallMessageSchema,
  sendMessageSchema,
} from '../../../src/validators/messageSchemas';

describe('message validation schemas', () => {
  it('validates send message payloads and trims content', () => {
    expect(sendMessageSchema.parse({
      roomId: 'room-1',
      content: ' hello ',
      replyToId: 'msg-0',
    })).toEqual({
      roomId: 'room-1',
      content: 'hello',
      replyToId: 'msg-0',
    });
    expect(sendMessageSchema.safeParse({ roomId: 'room-1', content: '   ' }).success).toBe(false);
    expect(sendMessageSchema.safeParse({ roomId: '', content: 'hello' }).success).toBe(false);
  });

  it('allows empty content when attachments are provided, but not without them', () => {
    expect(sendMessageSchema.safeParse({
      roomId: 'room-1',
      content: '',
      attachmentIds: ['550e8400-e29b-41d4-a716-446655440000'],
    }).success).toBe(true);
    expect(sendMessageSchema.safeParse({
      roomId: 'room-1',
      content: '   ',
      attachmentIds: [],
    }).success).toBe(false);
    expect(sendMessageSchema.safeParse({ roomId: 'room-1', content: '' }).success).toBe(false);
  });

  it('validates list messages payloads and bounds limit', () => {
    expect(listMessagesSchema.parse({ roomId: 'room-1' })).toEqual({
      roomId: 'room-1',
      limit: 50,
    });
    expect(listMessagesSchema.safeParse({ roomId: 'room-1', limit: 0 }).success).toBe(false);
    expect(listMessagesSchema.safeParse({ roomId: 'room-1', limit: 101 }).success).toBe(false);
    expect(listMessagesSchema.safeParse({ roomId: 'room-1', limit: 10.5 }).success).toBe(false);
  });

  it('validates recall message payloads', () => {
    expect(recallMessageSchema.safeParse({
      roomId: 'room-1',
      messageId: 'msg-1',
    }).success).toBe(true);
    expect(recallMessageSchema.safeParse({
      roomId: 'room-1',
      messageId: '',
    }).success).toBe(false);
  });
});
