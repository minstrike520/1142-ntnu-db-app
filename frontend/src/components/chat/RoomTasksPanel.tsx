"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useChat } from "@/context/ChatContext";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { Checkbox } from "@/components/ui/Checkbox";
import { useTranslation } from "@/hooks/useTranslation";

interface RoomTasksPanelProps {
  roomId: string;
  isOpen: boolean;
  onClose: () => void;
}

interface TaskFormState {
  title: string;
  description: string;
  dueAt: string;
  externalLink: string;
  assigneeUserIds: string[];
}

const emptyForm: TaskFormState = {
  title: "",
  description: "",
  dueAt: "",
  externalLink: "",
  assigneeUserIds: [],
};

const isSafeExternalLink = (value: string) => /^https?:\/\//i.test(value.trim());

export default function RoomTasksPanel({ roomId, isOpen, onClose }: RoomTasksPanelProps) {
  const { rooms, user, tasksByRoom, loadRoomTasks, handleCreateTask, handleUpdateTask, handleToggleTaskStatus, handleDeleteTask } =
    useChat();
  const { t } = useTranslation();

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [form, setForm] = useState<TaskFormState>(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const room = rooms.find((r) => r.id === roomId);
  const currentMember = room?.members?.find((m) => m.userId === user.userId);
  const canCreate = currentMember?.role === "owner" || currentMember?.role === "admin";
  const tasks = useMemo(() => tasksByRoom[roomId] ?? [], [tasksByRoom, roomId]);

  useEffect(() => {
    if (isOpen) {
      loadRoomTasks(roomId).catch(() => setError(t("tasks.loadFailed")));
    }
  }, [isOpen, roomId]); // eslint-disable-line react-hooks/exhaustive-deps

  const resetForm = () => {
    setForm(emptyForm);
    setIsFormOpen(false);
    setEditingTaskId(null);
    setError(null);
  };

  const startEdit = (taskId: string) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;
    setForm({
      title: task.title,
      description: task.description ?? "",
      dueAt: task.dueAt ? task.dueAt.slice(0, 16) : "",
      externalLink: task.externalLink ?? "",
      assigneeUserIds: [],
    });
    setEditingTaskId(taskId);
    setIsFormOpen(true);
  };

  const toggleAssignee = (userId: string) => {
    setForm((current) => ({
      ...current,
      assigneeUserIds: current.assigneeUserIds.includes(userId)
        ? current.assigneeUserIds.filter((id) => id !== userId)
        : [...current.assigneeUserIds, userId],
    }));
  };

  const handleSubmit = async () => {
    if (!form.title.trim()) {
      setError(t("tasks.titleCannotBeEmpty"));
      return;
    }
    if (form.externalLink.trim() && !isSafeExternalLink(form.externalLink)) {
      setError(t("tasks.invalidExternalLink"));
      return;
    }

    setIsSubmitting(true);
    setError(null);
    try {
      const payload = {
        title: form.title.trim(),
        description: form.description.trim() || undefined,
        dueAt: form.dueAt ? new Date(form.dueAt).toISOString() : undefined,
        externalLink: form.externalLink.trim() || undefined,
      };
      if (editingTaskId) {
        await handleUpdateTask(roomId, editingTaskId, payload);
      } else {
        await handleCreateTask(roomId, { ...payload, assigneeUserIds: form.assigneeUserIds });
      }
      resetForm();
    } catch {
      setError(editingTaskId ? t("tasks.updateFailed") : t("tasks.createFailed"));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (taskId: string) => {
    if (!window.confirm(t("tasks.confirmDelete"))) return;
    try {
      await handleDeleteTask(roomId, taskId);
    } catch {
      setError(t("tasks.deleteFailed"));
    }
  };

  const handleToggle = async (taskId: string, nextStatus: "open" | "done") => {
    try {
      await handleToggleTaskStatus(roomId, taskId, nextStatus);
    } catch {
      setError(t("tasks.updateFailed"));
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t("tasks.title", { count: tasks.length })}>
      <div className="flex flex-col gap-4">
        {error && <p className="text-xs text-red-600">{error}</p>}

        {canCreate && !isFormOpen && (
          <Button variant="secondary" className="self-start text-xs py-1.5 px-3" onClick={() => setIsFormOpen(true)}>
            {t("tasks.newTask")}
          </Button>
        )}
        {!canCreate && tasks.length === 0 && (
          <p className="text-xs text-text-muted">{t("tasks.onlyOwnerAdminCanCreate")}</p>
        )}

        {isFormOpen && (
          <div className="flex flex-col gap-3 border border-border-primary rounded-sm p-3 bg-surface-muted">
            <Input
              label={t("tasks.fieldTitle")}
              placeholder={t("tasks.fieldTitlePlaceholder")}
              value={form.title}
              maxLength={200}
              onChange={(e) => setForm((current) => ({ ...current, title: e.target.value }))}
            />
            <Textarea
              label={t("tasks.fieldDescription")}
              placeholder={t("tasks.fieldDescriptionPlaceholder")}
              value={form.description}
              maxLength={2000}
              onChange={(e) => setForm((current) => ({ ...current, description: e.target.value }))}
            />
            <Input
              type="datetime-local"
              label={t("tasks.fieldDueAt")}
              value={form.dueAt}
              onChange={(e) => setForm((current) => ({ ...current, dueAt: e.target.value }))}
            />
            <Input
              label={t("tasks.fieldExternalLink")}
              placeholder={t("tasks.fieldExternalLinkPlaceholder")}
              value={form.externalLink}
              onChange={(e) => setForm((current) => ({ ...current, externalLink: e.target.value }))}
            />
            {!editingTaskId && room?.members && room.members.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-bold uppercase tracking-wider text-text-muted font-sans">
                  {t("tasks.fieldAssignees")}
                </span>
                <div className="flex flex-col gap-1.5 max-h-32 overflow-y-auto">
                  {room.members
                    .filter((m) => m.role !== "pending")
                    .map((member) => (
                      <Checkbox
                        key={member.userId}
                        label={member.name}
                        checked={form.assigneeUserIds.includes(member.userId)}
                        onChange={() => toggleAssignee(member.userId)}
                      />
                    ))}
                </div>
              </div>
            )}
            <div className="flex items-center gap-2 justify-end">
              <Button variant="secondary" className="text-xs py-1.5 px-3" onClick={resetForm} disabled={isSubmitting}>
                {t("tasks.cancel")}
              </Button>
              <Button className="text-xs py-1.5 px-3" onClick={handleSubmit} disabled={isSubmitting}>
                {editingTaskId ? t("tasks.save") : t("tasks.create")}
              </Button>
            </div>
          </div>
        )}

        {tasks.length === 0 ? (
          <p className="text-xs text-text-muted">{t("tasks.empty")}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {tasks.map((task) => {
              const isAssignee = task.assignees.some((a) => a.userId === user.userId);
              const canManage = canCreate || task.createdBy === user.userId;
              const canToggle = canManage || isAssignee;
              return (
                <div key={task.id} className="border border-border-primary rounded-sm p-3 flex flex-col gap-1.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p
                        className={`text-sm font-semibold truncate ${
                          task.status === "done" ? "text-text-muted line-through" : "text-foreground"
                        }`}
                      >
                        {task.title}
                      </p>
                      {task.description && <p className="text-xs text-text-muted mt-0.5">{task.description}</p>}
                    </div>
                    <span className="text-[10px] uppercase font-mono shrink-0 text-text-muted">
                      {task.status === "done" ? t("tasks.statusDone") : t("tasks.statusOpen")}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-text-muted font-mono">
                    {task.creator && <span>{t("tasks.createdBy", { name: task.creator.name })}</span>}
                    {task.dueAt && <span>{t("tasks.due", { date: new Date(task.dueAt).toLocaleString() })}</span>}
                    {task.assignees.length > 0 && <span>{task.assignees.map((a) => a.name).join(", ")}</span>}
                  </div>

                  {task.externalLink && isSafeExternalLink(task.externalLink) && (
                    <a
                      href={task.externalLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-primary hover:underline truncate"
                    >
                      {task.externalLink}
                    </a>
                  )}

                  <div className="flex items-center gap-3 mt-1">
                    {canToggle && (
                      <button
                        onClick={() => handleToggle(task.id, task.status === "open" ? "done" : "open")}
                        className="text-xs text-primary hover:underline cursor-pointer"
                      >
                        {task.status === "open" ? t("tasks.markDone") : t("tasks.markOpen")}
                      </button>
                    )}
                    {canManage && (
                      <>
                        <button
                          onClick={() => startEdit(task.id)}
                          className="text-xs text-text-muted hover:text-foreground cursor-pointer"
                        >
                          {t("tasks.edit")}
                        </button>
                        <button
                          onClick={() => handleDelete(task.id)}
                          className="text-xs text-red-600 hover:underline cursor-pointer"
                        >
                          {t("tasks.delete")}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}
