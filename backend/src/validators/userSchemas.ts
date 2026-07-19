import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().email('Invalid email format'),
  name: z.string().min(1, 'Name cannot be empty'),
  password: z.string().min(8, 'Password must be at least 8 characters long'),
});

export const loginSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(1, 'Password cannot be empty'),
});

export const updateMeSchema = z
  .object({
    name: z.string().trim().min(1, 'Name cannot be empty').optional(),
    email: z.string().email('Invalid email format').optional(),
    password: z.string().min(8, 'Password must be at least 8 characters long').optional(),
    currentPassword: z.string().optional(),
    bio: z
      .string()
      .trim()
      .max(100, 'Bio must be at most 100 characters')
      .refine(
        (val) => val.split(/\r?\n/).length <= 8,
        'Bio must be at most 8 lines'
      )
      .optional(),
    avatarUrl: z.union([z.literal(''), z.string().url('Invalid avatar URL')]).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'At least one field must be provided',
  });

export const updateSettingsSchema = z
  .object({
    warningEnabled: z.boolean().optional(),
    warningDays: z.number().int().min(0).optional(),
    language: z
      .string()
      .trim()
      .min(2, 'language must be at least 2 characters')
      .max(10, 'language must be at most 10 characters')
      .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/, 'language must be a valid BCP 47 tag')
      .optional(),
    theme: z.enum(['light', 'dark']).optional(),
    notifyDesktop: z.boolean().optional(),
    notifySound: z.boolean().optional(),
    roomOrder: z.record(z.string(), z.array(z.string())).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'At least one field must be provided',
  });

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1, 'Search query cannot be empty'),
  mode: z.enum(['name', 'userId', 'email']).optional(),
  friendsOnly: z.preprocess((val) => val === 'true' || val === true, z.boolean()).optional(),
});

type RegisterSchema = z.infer<typeof registerSchema>;
type LoginSchema = z.infer<typeof loginSchema>;
export type UpdateMeInput = z.input<typeof updateMeSchema>;
export type UpdateSettingsInput = z.input<typeof updateSettingsSchema>;
type SearchQueryInput = z.input<typeof searchQuerySchema>;

export const addEmergencyContactSchema = z.object({
  contactId: z.string().uuid('Invalid contactId'),
  message: z.string().min(1, 'Message cannot be empty'),
});
type AddEmergencyContactInput = z.input<typeof addEmergencyContactSchema>;
