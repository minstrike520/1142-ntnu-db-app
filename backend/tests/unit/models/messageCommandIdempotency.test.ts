import { describe, expect, it } from 'bun:test';
import {
  commandLockKey,
  resolveCommandReceipt,
  type CommandReceipt,
} from '../../../src/models/message/commandIdempotency';

describe('message command idempotency helpers', () => {
  const receipt: CommandReceipt = {
    message_id: 'message-1',
    change_type: 'edited',
    change_sequence: '12',
  };

  it('builds one lock key for every durable command operation', () => {
    expect(commandLockKey('actor-1', 'key-1')).toBe('actor-1:key-1');
  });

  it('returns replay for the same operation and message', () => {
    expect(resolveCommandReceipt([receipt], 'edited', 'message-1')).toEqual({
      kind: 'replay',
      messageId: 'message-1',
      changeType: 'edited',
      changeSequence: 12,
    });
  });

  it('returns a conflict when a key changes operation or message', () => {
    expect(resolveCommandReceipt([receipt], 'recalled', 'message-1')).toEqual({
      kind: 'conflict',
      message: 'Idempotency-Key was already used for another operation',
    });
    expect(resolveCommandReceipt([receipt], 'edited', 'message-2')).toEqual({
      kind: 'conflict',
      message: 'Idempotency-Key was already used for another message',
    });
  });

  it('returns a replay without a sequence for a no-op receipt', () => {
    expect(resolveCommandReceipt([{
      message_id: 'message-1',
      change_type: 'recalled',
      change_sequence: null,
    }], 'recalled', 'message-1')).toMatchObject({
      kind: 'replay',
      changeSequence: undefined,
    });
  });
});
