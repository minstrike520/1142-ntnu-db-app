import { testPool } from './testPool';

export async function resetDb(): Promise<void> {
  await testPool`
    TRUNCATE users, chat_rooms, messages, message_changes, read_position_commands, room_members, emergency_contacts, friendships, blocks, folders, folder_rooms, attachments RESTART IDENTITY CASCADE
  `;
  await testPool`
    UPDATE realtime_counters SET message_sequence = 0, change_sequence = 0 WHERE counter_id = true
  `;
}
