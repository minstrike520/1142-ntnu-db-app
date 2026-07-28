import { z } from 'zod';

const idSchema = z.string().trim().min(1, 'Id cannot be empty');
const titleSchema = z.string().trim().min(1, 'Title cannot be empty').max(200, 'Title is too long');
const descriptionSchema = z.string().trim().max(2000, 'Description is too long');
const dueAtSchema = z.coerce.date();
const externalLinkSchema = z.string().trim().url('Invalid external link').max(2048, 'External link is too long');

export const createTaskSchema = z.object({
  roomId: idSchema,
  title: titleSchema,
  description: descriptionSchema.optional(),
  dueAt: dueAtSchema.optional(),
  externalLink: externalLinkSchema.optional(),
  assigneeUserIds: z.array(idSchema).default([]),
});

export const updateTaskSchema = z
  .object({
    roomId: idSchema,
    taskId: idSchema,
    title: titleSchema.optional(),
    description: descriptionSchema.nullable().optional(),
    dueAt: dueAtSchema.nullable().optional(),
    externalLink: externalLinkSchema.nullable().optional(),
  })
  .refine(
    (value) =>
      value.title !== undefined ||
      value.description !== undefined ||
      value.dueAt !== undefined ||
      value.externalLink !== undefined,
    { message: 'At least one task field must be provided' },
  );

export const setTaskStatusSchema = z.object({
  roomId: idSchema,
  taskId: idSchema,
  status: z.enum(['open', 'done']),
});

export const listTasksSchema = z.object({
  roomId: idSchema,
});

export const deleteTaskSchema = z.object({
  roomId: idSchema,
  taskId: idSchema,
});

export type CreateTaskInput = z.input<typeof createTaskSchema>;
export type UpdateTaskInput = z.input<typeof updateTaskSchema>;
export type SetTaskStatusInput = z.input<typeof setTaskStatusSchema>;
