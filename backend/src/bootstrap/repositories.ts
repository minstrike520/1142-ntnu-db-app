import type sql from '../models/db';
import { UserRepository } from '../models/userRepository';
import { EmergencyContactRepository } from '../models/emergencyContactRepository';
import { RoomRepository } from '../models/roomRepository';
import { RoomMemberRepository } from '../models/roomMemberRepository';
import { MessageRepository } from '../models/messageRepository';
import { FolderRepository } from '../models/folderRepository';
import { AttachmentRepository } from '../models/attachmentRepository';
import { RefreshTokenRepository } from '../models/refreshTokenRepository';
import { makeFriendRepository } from '../models/friendRepository';

export type Db = typeof sql;

export interface Repositories {
  users: UserRepository;
  emergencyContacts: EmergencyContactRepository;
  rooms: RoomRepository;
  roomMembers: RoomMemberRepository;
  messages: MessageRepository;
  folders: FolderRepository;
  attachments: AttachmentRepository;
  refreshTokens: RefreshTokenRepository;
  friends: ReturnType<typeof makeFriendRepository>;
}

/**
 * Every repository, bound to one database handle.
 *
 * Repositories are stateless over the handle, so construction order carries no
 * meaning here — unlike the services, which reference one another.
 */
export const createRepositories = (db: Db): Repositories => ({
  users: new UserRepository(db),
  emergencyContacts: new EmergencyContactRepository(db),
  rooms: new RoomRepository(db),
  roomMembers: new RoomMemberRepository(db),
  messages: new MessageRepository(db),
  folders: new FolderRepository(db),
  attachments: new AttachmentRepository(db),
  refreshTokens: new RefreshTokenRepository(db),
  friends: makeFriendRepository(db),
});
