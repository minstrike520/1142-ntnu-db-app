import { SQL } from 'bun';

export type DurableCommandType = 'created' | 'edited' | 'recalled';

export interface CommandReceipt {
  message_id: string;
  change_type: DurableCommandType;
  change_sequence: number | string | null;
}

export type CommandResolution =
  | { kind: 'new' }
  | {
      kind: 'replay';
      messageId: string;
      changeType: DurableCommandType;
      changeSequence: number | undefined;
    }
  | { kind: 'conflict'; message: string };

export function commandLockKey(actorId: string, commandId: string): string {
  return `${actorId}:${commandId}`;
}

export function resolveCommandReceipt(
  receipts: CommandReceipt[],
  expectedType: DurableCommandType,
  expectedMessageId?: string,
): CommandResolution {
  const prior = receipts[0];
  if (!prior) return { kind: 'new' };
  if (expectedMessageId && prior.message_id !== expectedMessageId) {
    return { kind: 'conflict', message: 'Idempotency-Key was already used for another message' };
  }
  if (prior.change_type !== expectedType) {
    return { kind: 'conflict', message: 'Idempotency-Key was already used for another operation' };
  }
  return {
    kind: 'replay',
    messageId: prior.message_id,
    changeType: prior.change_type,
    changeSequence: prior.change_sequence === null ? undefined : Number(prior.change_sequence),
  };
}

export async function findCommandReceipts(
  tx: SQL,
  actorId: string,
  commandId: string,
): Promise<CommandReceipt[]> {
  return tx<CommandReceipt[]>`
    SELECT message_id, change_type, change_sequence
    FROM (
      SELECT message_id, change_type, change_sequence
      FROM message_changes
      WHERE actor_id = ${actorId} AND command_id = ${commandId}
      UNION ALL
      SELECT message_id, change_type, change_sequence
      FROM message_command_receipts
      WHERE actor_id = ${actorId} AND command_id = ${commandId}
    ) receipts
    ORDER BY change_sequence ASC NULLS LAST
    LIMIT 1
  `;
}
