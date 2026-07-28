import { IFolderRepository } from '../models/folderRepository';
import type { IRoomMemberRepository } from '../models/IRoomMemberRepository';
import type { Folder } from '../../../shared/types';
import { ForbiddenError } from '../utils/AppError';

export interface FolderService {
  createFolder(userId: string, name: string): Promise<Folder>;
  getFolders(userId: string): Promise<Folder[]>;
  deleteFolder(folderId: string, userId: string): Promise<void>;
  updateFolderRooms(folderId: string, userId: string, roomIds: string[]): Promise<void>;
  renameFolder(folderId: string, userId: string, name: string): Promise<Folder>;
}

export const makeFolderService = (folderRepo: IFolderRepository, roomMemberRepo: IRoomMemberRepository): FolderService => ({
  createFolder: (userId, name) => folderRepo.create(userId, name),
  getFolders: (userId) => folderRepo.findByUserId(userId),
  deleteFolder: (folderId, userId) => folderRepo.delete(folderId, userId),
  async updateFolderRooms(folderId, userId, roomIds) {
    for (const roomId of [...new Set(roomIds)]) {
      const membership = await roomMemberRepo.findMember(roomId, userId);
      if (!membership) {
        throw new ForbiddenError('Cannot categorize rooms the user is not a member of');
      }
    }
    await folderRepo.updateRooms(folderId, userId, roomIds);
  },
  renameFolder: (folderId, userId, name) => folderRepo.rename(folderId, userId, name),
});
