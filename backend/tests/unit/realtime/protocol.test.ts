import { describe, expect, test } from 'bun:test';
import {
  PROTOCOL_VERSION,
  parseClientFrame,
  parseServerFrame,
  type RealtimeCommand,
} from '@shared/realtime';

const sendMessageCommand: RealtimeCommand = {
  version: PROTOCOL_VERSION,
  kind: 'command',
  id: 'command-1',
  type: 'message.send',
  streamId: 'room:room-1',
  reliable: true,
  payload: {
    roomId: 'room-1',
    content: 'hello',
  },
};

describe('near-chat.v1 runtime contract', () => {
  test('accepts a valid command and rejects unsupported or malformed frames', () => {
    expect(parseClientFrame(JSON.stringify(sendMessageCommand))).toEqual({
      success: true,
      data: sendMessageCommand,
    });

    expect(parseClientFrame(JSON.stringify({ ...sendMessageCommand, version: 2 }))).toEqual({
      success: false,
      code: 'UNSUPPORTED_VERSION',
    });

    expect(parseClientFrame(JSON.stringify({
      ...sendMessageCommand,
      payload: { roomId: 'room-1', content: '' },
    }))).toMatchObject({
      success: false,
      code: 'INVALID_PAYLOAD',
    });

    expect(parseServerFrame('{not-json')).toEqual({
      success: false,
      code: 'INVALID_JSON',
    });
  });

  test('accepts attachment-only sends while requiring content or an attachment', () => {
    expect(parseClientFrame(JSON.stringify({
      ...sendMessageCommand,
      payload: { roomId: 'room-1', content: '', attachmentIds: ['attachment-1'] },
    }))).toMatchObject({ success: true });

    expect(parseClientFrame(JSON.stringify({
      ...sendMessageCommand,
      payload: { roomId: 'room-1', content: '', attachmentIds: [] },
    }))).toMatchObject({
      success: false,
      code: 'INVALID_PAYLOAD',
    });
  });

  test('requires reliable delivery for every command except typing', () => {
    expect(parseClientFrame(JSON.stringify({ ...sendMessageCommand, reliable: false }))).toMatchObject({
      success: false,
      code: 'INVALID_PAYLOAD',
    });

    expect(parseClientFrame(JSON.stringify({
      ...sendMessageCommand,
      type: 'typing.set',
      reliable: false,
      payload: { roomId: 'room-1', isTyping: true },
    }))).toEqual({
      success: true,
      data: {
        ...sendMessageCommand,
        type: 'typing.set',
        reliable: false,
        payload: { roomId: 'room-1', isTyping: true },
      },
    });
  });
});
