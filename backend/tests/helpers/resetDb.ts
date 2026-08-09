import { testPool } from './testPool';

export async function resetDb(): Promise<void> {
  await testPool`
    TRUNCATE users, chat_rooms, messages, room_members, emergency_contacts, friendships, blocks, folders, folder_rooms, attachments, message_sequence_counter RESTART IDENTITY CASCADE
  `;
}
