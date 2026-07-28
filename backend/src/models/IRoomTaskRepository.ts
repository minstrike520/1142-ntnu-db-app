import type { RoomTaskStatus, RoomTaskWithDetails } from '@shared/types';

export interface CreateRoomTaskData {
  roomId: string;
  title: string;
  description?: string;
  createdBy: string;
  dueAt?: Date;
  externalLink?: string;
  assigneeUserIds: string[];
}

export interface UpdateRoomTaskData {
  title?: string;
  description?: string | null;
  dueAt?: Date | null;
  externalLink?: string | null;
}

export interface IRoomTaskRepository {
  findById(taskId: string): Promise<RoomTaskWithDetails | null>;
  findByRoom(roomId: string): Promise<RoomTaskWithDetails[]>;
  create(data: CreateRoomTaskData): Promise<RoomTaskWithDetails>;
  update(taskId: string, data: UpdateRoomTaskData): Promise<RoomTaskWithDetails>;
  setStatus(taskId: string, status: RoomTaskStatus): Promise<RoomTaskWithDetails>;
  delete(taskId: string): Promise<void>;
}
