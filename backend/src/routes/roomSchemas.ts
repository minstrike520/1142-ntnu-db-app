import { z } from 'zod';

const roomTypeSchema = z.enum(['private', 'group']);

export const createRoomSchema = z.preprocess(
  (raw: unknown) => {
    const data = (raw && typeof raw === 'object' ? raw as Record<string, unknown> : {});
    return {
      ...data,
      targetUserId: data.targetUserId ?? data.target_user_id,
    };
  },
  z
    .object({
      type: roomTypeSchema.default('group'),
      name: z.string().trim().min(1, 'Room name cannot be empty').optional(),
      avatarUrl: z.string().url('Invalid avatar URL').optional(),
      requireApproval: z.boolean().default(false),
      viewHistory: z.boolean().default(true),
      targetUserId: z.string().uuid().optional(),
    })
    // `type` defaults to 'group', so without this an empty body would create a
    // group with name = NULL. Only private rooms may omit the name.
    .refine((value) => value.type !== 'group' || Boolean(value.name), {
      message: 'Room name cannot be empty',
      path: ['name'],
    })
);

const roomSettingsFields = {
  name: z.string().trim().min(1, 'Room name cannot be empty').optional(),
  avatarUrl: z.string().url('Invalid avatar URL').optional(),
  requireApproval: z.boolean().optional(),
  viewHistory: z.boolean().optional(),
  isArchived: z.boolean().optional(),
};

const atLeastOneField = {
  message: 'At least one room field must be provided',
};

export const updateRoomSchema = z
  .object(roomSettingsFields)
  .refine((value) => Object.keys(value).length > 0, atLeastOneField);

// PATCH /rooms/:id doubles as the ownership-transfer endpoint, so the route-level
// schema also accepts `ownerId`; the settings-only shape stays in updateRoomSchema
// because that is what the service hands to the repository.
export const patchRoomSchema = z.preprocess(
  (raw: unknown) => {
    const data = (raw && typeof raw === 'object' ? raw as Record<string, unknown> : {});
    const { owner_id: snakeOwnerId, ...rest } = data;
    const ownerId = data.ownerId ?? snakeOwnerId;
    return ownerId === undefined ? rest : { ...rest, ownerId };
  },
  z
    .object({
      ...roomSettingsFields,
      ownerId: z.string().uuid('Invalid ownerId').optional(),
    })
    .refine((value) => Object.keys(value).length > 0, atLeastOneField)
);

export type CreateRoomInput = z.input<typeof createRoomSchema>;
export type UpdateRoomInput = z.input<typeof updateRoomSchema>;
export type PatchRoomInput = z.output<typeof patchRoomSchema>;

export const joinByCodeSchema = z.object({
  inviteCode: z.string().trim().min(1, 'inviteCode is required'),
});

// `isMuted` matches the API contract, the frontend request type and
// RoomService.updateMember. Declaring it as `muted` made Zod strip the field, so
// the handler silently answered 200 without ever touching is_muted.
export const updateMemberSchema = z.object({
  role: z.enum(['owner', 'admin', 'member', 'pending']).optional(),
  nickname: z.string().trim().optional(),
  isMuted: z.boolean().optional(),
  status: z.string().optional(),
});

