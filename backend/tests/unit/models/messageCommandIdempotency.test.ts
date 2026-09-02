import { describe, expect, it } from 'bun:test';
import type { SQL } from 'bun';
import {
  commandLockKey,
  findCommandReceipts,
  recordNoOpRecall,
  resolveCommandReceipt,
  type CommandReceipt,
} from '../../../src/models/message/commandIdempotency';

const createFakeTx = (result: unknown): { tx: SQL; calls: Array<{ strings: string[]; values: unknown[] }> } => {
  const calls: Array<{ strings: string[]; values: unknown[] }> = [];
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ strings: [...strings], values });
    return Promise.resolve(result);
  }) as unknown as SQL;
  return { tx, calls };
};

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

  it('looks up the shared actor and key namespace through the supplied transaction', async () => {
    const expected: CommandReceipt[] = [{
      message_id: 'message-1',
      change_type: 'created',
      change_sequence: '9',
    }];
    const { tx, calls } = createFakeTx(expected);

    await expect(findCommandReceipts(tx, 'actor-1', 'key-1')).resolves.toEqual(expected);

    expect(calls).toHaveLength(1);
    expect(calls[0].strings.join(' ')).toContain('FROM message_changes');
    expect(calls[0].strings.join(' ')).toContain('FROM message_command_receipts');
    expect(calls[0].strings.join(' ')).toContain('ORDER BY change_sequence ASC NULLS LAST');
    expect(calls[0].values).toEqual(['actor-1', 'key-1', 'actor-1', 'key-1']);
  });

  it('records a no-op recall receipt without allocating a new change', async () => {
    const { tx, calls } = createFakeTx([]);

    await recordNoOpRecall(tx, 'actor-1', 'key-1', 'message-1');

    expect(calls).toHaveLength(1);
    const statement = calls[0].strings.join(' ');
    expect(statement).toContain('INSERT INTO message_command_receipts');
    expect(statement).toContain("'recalled'");
    expect(statement).toContain('ORDER BY change_sequence DESC LIMIT 1');
    expect(statement).toContain('ON CONFLICT (actor_id, command_id) DO NOTHING');
    expect(statement).not.toContain('realtime_counters');
    expect(calls[0].values).toEqual(['actor-1', 'key-1', 'message-1', 'message-1']);
  });
});
