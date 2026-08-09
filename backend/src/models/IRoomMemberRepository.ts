import type { RoomMember } from '@shared/types';

export interface IRoomMemberRepository {
  findMember(roomId: string, userId: string): Promise<RoomMember | null>;
  findByRoom(roomId: string): Promise<RoomMember[]>;
  findByUser?(userId: string): Promise<RoomMember[]>;
  add(data: Pick<RoomMember, 'roomId' | 'userId' | 'role'>): Promise<RoomMember>;
  update(roomId: string, userId: string, data: Partial<Pick<RoomMember, 'role' | 'nickname' | 'isMuted' | 'lastReadId' | 'readPosition'>>): Promise<RoomMember>;
  markRead?(roomId: string, userId: string, messageId: string, commandId?: string): Promise<RoomMember>;
  remove(roomId: string, userId: string): Promise<void>;
  resolveMentions(roomId: string, names: string[]): Promise<string[]>;
}
