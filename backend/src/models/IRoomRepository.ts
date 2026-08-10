import type { Room, RoomSummary } from '@shared/types';

export type CreateRoomData = Pick<Room, 'type' | 'requireApproval' | 'viewHistory'> & Partial<Pick<Room, 'name' | 'avatarUrl' | 'inviteCode'>>;

export type UpdateRoomData = Partial<Pick<Room, 'name' | 'avatarUrl' | 'requireApproval' | 'viewHistory' | 'isArchived' | 'isReadonly'>>;

export interface IRoomRepository {
  findById(roomId: string): Promise<Room | null>;
  findByInviteCode(code: string): Promise<Room | null>;
  findPrivateRoomByMembers(userA: string, userB: string): Promise<Room | null>;
  reopenPrivateRoomIfUnblocked?(roomId: string, userA: string, userB: string): Promise<Room | null>;
  markPrivateReadOnlyIfBlocked?(roomId: string, userA: string, userB: string): Promise<Room | null>;
  findByMember(userId: string): Promise<RoomSummary[]>;
  create(data: CreateRoomData): Promise<Room>;
  update(roomId: string, data: UpdateRoomData): Promise<Room>;
  transferOwnership?(roomId: string, callerId: string, targetUserId: string): Promise<void>;
  delete(roomId: string): Promise<void>;
}
