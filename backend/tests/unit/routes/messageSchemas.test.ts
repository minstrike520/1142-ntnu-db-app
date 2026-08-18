import { describe, it, expect } from 'bun:test';
import {
  createMessageBodySchema,
  listMessagesSchema,
  recallMessageSchema,
  sendMessageSchema,
} from '../../../src/routes/messageSchemas';

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

  it('rejects create bodies whose optional fields have the wrong type', () => {
    // These used to be coerced to `undefined` in the route, so the message was
    // created without its reply or attachments and the client still got a 201.
    expect(createMessageBodySchema.safeParse({ content: 'hello', replyToId: 123 }).success).toBe(false);
    expect(createMessageBodySchema.safeParse({ content: 'hello', replyToId: 'msg-0' }).success).toBe(false);
    expect(createMessageBodySchema.safeParse({ content: 'hello', attachmentIds: '550e8400-e29b-41d4-a716-446655440000' }).success).toBe(false);
    expect(createMessageBodySchema.safeParse({ content: 'hello', attachmentIds: ['nope'] }).success).toBe(false);
    expect(createMessageBodySchema.safeParse({ content: 42 }).success).toBe(false);
    expect(createMessageBodySchema.safeParse({}).success).toBe(false);
  });

  it('accepts create bodies with well-formed optional fields', () => {
    expect(createMessageBodySchema.parse({ content: 'hello' })).toEqual({ content: 'hello' });
    // The published request body spells the empty case with `null`.
    expect(createMessageBodySchema.safeParse({
      content: 'hello',
      replyToId: null,
      attachmentIds: [],
    }).success).toBe(true);
    expect(createMessageBodySchema.parse({
      content: '',
      replyToId: '550e8400-e29b-41d4-a716-446655440000',
      attachmentIds: ['550e8400-e29b-41d4-a716-446655440000'],
    })).toEqual({
      content: '',
      replyToId: '550e8400-e29b-41d4-a716-446655440000',
      attachmentIds: ['550e8400-e29b-41d4-a716-446655440000'],
    });
  });
});
