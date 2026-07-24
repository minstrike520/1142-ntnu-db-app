import { z } from 'zod';

const roomTypeSchema = z.enum(['private', 'group']);

export const createRoomSchema = z.preprocess(
  (data: any) => ({
    ...data,
    targetUserId: data?.targetUserId ?? data?.target_user_id,
  }),
  z.object({
    type: roomTypeSchema.default('group'),
    name: z.string().trim().min(1, 'Room name cannot be empty').optional(),
    avatarUrl: z.string().url('Invalid avatar URL').optional(),
    requireApproval: z.boolean().default(false),
    viewHistory: z.boolean().default(true),
    targetUserId: z.string().uuid().optional(),
  })
);

export const updateRoomSchema = z
  .object({
    name: z.string().trim().min(1, 'Room name cannot be empty').optional(),
    avatarUrl: z.string().url('Invalid avatar URL').optional(),
    requireApproval: z.boolean().optional(),
    viewHistory: z.boolean().optional(),
    isArchived: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one room field must be provided',
  });

export type CreateRoomInput = z.input<typeof createRoomSchema>;
export type UpdateRoomInput = z.input<typeof updateRoomSchema>;

export const joinByCodeSchema = z.object({
  inviteCode: z.string().trim().min(1, 'inviteCode is required'),
});

export const updateMemberSchema = z.object({
  role: z.enum(['owner', 'admin', 'member', 'pending']).optional(),
  nickname: z.string().trim().optional(),
  muted: z.boolean().optional(),
  status: z.string().optional(),
  ownerId: z.string().uuid().optional(),
});

