"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { PublicUser } from "@shared/types";
import { useChat, Member } from "@/context/ChatContext";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { useTranslation } from "@/hooks/useTranslation";
import { Dropdown, DropdownItem } from "@/components/ui/Dropdown";
import { resolveAssetUrl } from "@/lib/assets";
import { cn } from "@/lib/utils";

const ACCEPTED_AVATAR_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const AVATAR_UPLOAD_MAX_BYTES = 2 * 1024 * 1024;

interface GroupSettingsProps {
  roomId: string;
  onClose: () => void;
}

export default function GroupSettings({ roomId, onClose }: GroupSettingsProps) {
  const router = useRouter();
  const { t } = useTranslation();
  const {
    rooms,
    user,
    loadGroupMembers,
    saveGroupSettings,
    approveGroupMember,
    updateGroupMember,
    kickGroupMember,
    transferGroupOwner,
    handleDeleteGroupRoom,
    searchUsersForInvite,
    handleOpenPrivateRoom,
    handleSendMessage,
    setHasUnsavedChanges,
  } = useChat();

  const activeRoom = rooms.find((room) => room.id === roomId);
  const [name, setName] = useState("");
  const [requireApproval, setRequireApproval] = useState(false);
  const [viewHistory, setViewHistory] = useState(true);
  const [members, setMembers] = useState<Member[]>([]);
  const [feedback, setFeedback] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<PublicUser[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isModifyNickOpen, setIsModifyNickOpen] = useState(false);
  const [selectedMember, setSelectedMember] = useState<Member | null>(null);
  const [nickInputValue, setNickInputValue] = useState("");
  const [memberActionUserId, setMemberActionUserId] = useState<string | null>(null);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreviewUrl, setAvatarPreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      if (avatarPreviewUrl) {
        URL.revokeObjectURL(avatarPreviewUrl);
      }
    };
  }, [avatarPreviewUrl]);

  const currentMember = useMemo(
    () => members.find((member) => member.userId === user.userId || member.name === user.username),
    [members, user.userId, user.username],
  );
  const canManageMembers = currentMember?.role === "owner" || currentMember?.role === "admin";
  const canTransferOwner = currentMember?.role === "owner";

  // Sync the form fields when the room data changes
  // (adjust state during render instead of cascading effects).
  const roomSyncKey = activeRoom
    ? `${activeRoom.id}|${activeRoom.name}|${String(Boolean(activeRoom.requireApproval))}|${String(activeRoom.viewHistory ?? true)}`
    : null;
  const [prevRoomSyncKey, setPrevRoomSyncKey] = useState<string | null>(null);
  if (activeRoom && roomSyncKey !== prevRoomSyncKey) {
    setPrevRoomSyncKey(roomSyncKey);
    setName(activeRoom.name);
    setRequireApproval(Boolean(activeRoom.requireApproval));
    setViewHistory(activeRoom.viewHistory ?? true);
  }

  // Mirror member data from the room context and clear stale feedback
  // whenever the room or its member list changes.
  const contextMembers = activeRoom?.members;
  const [prevMembersSync, setPrevMembersSync] = useState<{
    roomId: string;
    members: Member[] | undefined;
  } | null>(null);
  if (!prevMembersSync || prevMembersSync.roomId !== roomId || prevMembersSync.members !== contextMembers) {
    setPrevMembersSync({ roomId, members: contextMembers });
    setFeedback("");
    if (contextMembers) {
      setMembers(contextMembers);
    }
  }

  useEffect(() => {
    if (activeRoom?.members?.length) {
      return () => {
        if (searchTimeoutRef.current) {
          clearTimeout(searchTimeoutRef.current);
        }
      };
    }

    let cancelled = false;
    void loadGroupMembers(roomId)
      .then((loaded) => {
        if (!cancelled) {
          setMembers(loaded);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setFeedback(error instanceof Error ? error.message : t("groupSettings.loadFailed"));
        }
      });

    return () => {
      cancelled = true;
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
    };
  }, [activeRoom?.members, roomId, loadGroupMembers, t]);


  const refreshMembers = async () => {
    const nextMembers = await loadGroupMembers(roomId);
    if (nextMembers) {
      setMembers(nextMembers);
    }
  };

  const runMemberAction = async (
    member: Member,
    action: () => Promise<Member[] | undefined>,
    successMessage: string,
    fallbackMessage: string,
  ) => {
    setMemberActionUserId(member.userId);
    setFeedback("");
    try {
      const nextMembers = await action();
      if (nextMembers) {
        setMembers(nextMembers);
      }
      setFeedback(successMessage);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : fallbackMessage);
    } finally {
      setMemberActionUserId(null);
    }
  };

  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsSaving(true);
    setFeedback("");
    try {
      await saveGroupSettings(roomId, { name, avatarFile });
      setFeedback(t("groupSettings.settingsSaved"));
      setAvatarFile(null);
      if (avatarPreviewUrl) {
        URL.revokeObjectURL(avatarPreviewUrl);
        setAvatarPreviewUrl(null);
      }
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : t("groupSettings.roleFailed"));
    } finally {
      setIsSaving(false);
    }
  };

  const handleRequireApprovalChange = async (checked: boolean) => {
    setRequireApproval(checked);
    setFeedback("");
    try {
      await saveGroupSettings(roomId, { requireApproval: checked });
      setFeedback(t("groupSettings.settingsSaved"));
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : t("groupSettings.saveFailed") || "儲存失敗");
      setRequireApproval(!checked);
    }
  };

  const handleViewHistoryChange = async (checked: boolean) => {
    setViewHistory(checked);
    setFeedback("");
    try {
      await saveGroupSettings(roomId, { viewHistory: checked });
      setFeedback(t("groupSettings.settingsSaved"));
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : t("groupSettings.saveFailed") || "儲存失敗");
      setViewHistory(!checked);
    }
  };

  const hasUnsavedChanges = (activeRoom ? name !== activeRoom.name : false) || avatarFile !== null;

  const handleCancel = () => {
    if (activeRoom) {
      setName(activeRoom.name);
    }
    setAvatarFile(null);
    if (avatarPreviewUrl) {
      URL.revokeObjectURL(avatarPreviewUrl);
      setAvatarPreviewUrl(null);
    }
    setFeedback("");
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleCloseAttempt = () => {
    if (hasUnsavedChanges) {
      const confirmLeave = window.confirm(t("profile.unsavedChangesConfirm") || "有變更尚未儲存，確定要離開嗎？");
      if (!confirmLeave) return;
    }
    onClose();
  };

  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (hasUnsavedChanges) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasUnsavedChanges]);

  const [shouldAlertEffect, setShouldAlertEffect] = useState(false);

  useEffect(() => {
    setHasUnsavedChanges(hasUnsavedChanges);
    return () => setHasUnsavedChanges(false);
  }, [hasUnsavedChanges, setHasUnsavedChanges]);

  useEffect(() => {
    const handleAlert = () => {
      setShouldAlertEffect(true);
      setTimeout(() => {
        setShouldAlertEffect(false);
      }, 1600);
    };
    window.addEventListener("trigger-unsaved-alert", handleAlert);
    return () => window.removeEventListener("trigger-unsaved-alert", handleAlert);
  }, []);

  const handleAvatarClick = () => {
    fileInputRef.current?.click();
  };

  const handleAvatarFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!ACCEPTED_AVATAR_TYPES.includes(file.type)) {
      setFeedback(t("avatarUpload.invalidType"));
      event.target.value = "";
      return;
    }

    if (file.size > AVATAR_UPLOAD_MAX_BYTES) {
      setFeedback(t("avatarUpload.tooLarge"));
      event.target.value = "";
      return;
    }

    if (avatarPreviewUrl) {
      URL.revokeObjectURL(avatarPreviewUrl);
    }

    const previewUrl = URL.createObjectURL(file);
    setAvatarFile(file);
    setAvatarPreviewUrl(previewUrl);
    setFeedback("");
  };

  const handleApprove = async (member: Member) =>
    runMemberAction(
      member,
      () => approveGroupMember(roomId, member.userId),
      t("groupSettings.approveMember", { name: member.name }),
      t("groupSettings.approveFailed"),
    );

  const handleRoleChange = async (member: Member, role: "admin" | "member") =>
    runMemberAction(
      member,
      () => updateGroupMember(roomId, member.userId, { role }),
      t("groupSettings.roleUpdated", { name: member.name }),
      t("groupSettings.roleFailed"),
    );

  const handleNickname = (member: Member) => {
    setSelectedMember(member);
    setNickInputValue(member.nickname || member.name);
    setIsModifyNickOpen(true);
  };

  const handleModifyNickSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedMember) return;
    const trimmed = nickInputValue.trim();
    const finalNick = trimmed || selectedMember.name;
    setIsModifyNickOpen(false);

    await runMemberAction(
      selectedMember,
      () => updateGroupMember(roomId, selectedMember.userId, { nickname: finalNick }),
      t("groupSettings.nicknameUpdated", { name: selectedMember.name }),
      t("groupSettings.nicknameFailed"),
    );
    setSelectedMember(null);
  };

  const handleToggleMute = async (member: Member) =>
    runMemberAction(
      member,
      () => updateGroupMember(roomId, member.userId, { isMuted: !member.isMuted }),
      t("groupSettings.muteUpdated", { name: member.name }),
      t("groupSettings.muteFailed"),
    );

  const handleKick = async (member: Member) => {
    if (!window.confirm(t("groupSettings.kickConfirm", { name: member.name }))) return;

    await runMemberAction(
      member,
      () => kickGroupMember(roomId, member.userId),
      t("groupSettings.kickSuccess", { name: member.name }),
      t("groupSettings.kickFailed"),
    );
  };

  const handleTransferOwner = async (member: Member) => {
    if (!window.confirm(t("groupSettings.transferOwnerConfirm", { name: member.name }))) return;

    await runMemberAction(
      member,
      () => transferGroupOwner(roomId, member.userId),
      t("groupSettings.transferOwnerSuccess", { name: member.name }),
      t("groupSettings.transferOwnerFailed"),
    );
  };

  const handleDeleteGroupConfirm = async () => {
    if (!window.confirm(t("groupSettings.deleteGroupConfirm"))) return;

    const nextActiveId = await handleDeleteGroupRoom(roomId);
    if (nextActiveId) {
      router.push(`/chat/${nextActiveId}`);
      return;
    }
    router.push("/");
  };

  const handleArchiveToggle = async () => {
    if (!activeRoom) return;
    const next = !activeRoom.isArchived;
    const confirmMsg = next ? t("groupSettings.archiveConfirm") : t("groupSettings.unarchiveConfirm");
    if (!window.confirm(confirmMsg)) return;
    setIsSaving(true);
    setFeedback("");
    try {
      await saveGroupSettings(roomId, {
        name,
        requireApproval,
        viewHistory,
        isArchived: next,
      });
      setFeedback(next ? t("groupSettings.archived") : t("groupSettings.unarchived"));
    } catch (error) {
      setFeedback(
        error instanceof Error
          ? error.message
          : next
            ? t("groupSettings.archiveFailed")
            : t("groupSettings.unarchiveFailed"),
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleCopyInviteCode = async () => {
    const code = activeRoom?.inviteCode;
    if (!code) return;

    try {
      await navigator.clipboard.writeText(code);
      setFeedback(t("groupSettings.inviteCodeCopied"));
    } catch {
      window.prompt(t("groupSettings.inviteCodeManualCopy"), code);
    }
  };

  const handleCopyInviteLink = async () => {
    const code = activeRoom?.inviteCode;
    if (!code) return;
    const link = `${window.location.origin}/invite/${code}`;

    try {
      await navigator.clipboard.writeText(link);
      setFeedback(t("groupSettings.inviteLinkCopied"));
    } catch {
      window.prompt(t("groupSettings.inviteLinkManualCopy"), link);
    }
  };

  const handleSearchQueryChange = (value: string) => {
    setSearchQuery(value);

    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }

    if (!value.trim()) {
      setSearchResults([]);
      return;
    }

    searchTimeoutRef.current = setTimeout(() => {
      setIsSearching(true);
      searchUsersForInvite(value)
        .then((results) => {
          const memberIds = new Set(members.map((member) => member.userId));
          setSearchResults(results.filter((candidate) => !memberIds.has(candidate.userId)));
        })
        .catch((error) => {
          setFeedback(error instanceof Error ? error.message : t("groupSettings.searchFailed"));
        })
        .finally(() => {
          setIsSearching(false);
        });
    }, 400);
  };

  const handleSendInviteMessage = async (targetUser: PublicUser) => {
    if (!activeRoom) return;
    const code = activeRoom.inviteCode;
    if (!code) {
      setFeedback(t("groupSettings.noInviteCode"));
      return;
    }

    try {
      const privateRoomId = await handleOpenPrivateRoom(targetUser.userId);
      const message = t("groupSettings.inviteMessageContent", { name: activeRoom.name, code });
      handleSendMessage(privateRoomId, message, null);
      setFeedback(t("groupSettings.inviteSent", { name: targetUser.name }));
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : t("groupSettings.inviteFailed"));
    }
  };

  if (!activeRoom) {
    return (
      <div className="flex-1 flex items-center justify-center bg-background text-foreground font-sans">
        {t("groupSettings.notFound")}
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-background h-full overflow-hidden">
      <div className="h-14 border-b border-border-primary px-6 flex items-center justify-between select-none shrink-0 bg-surface-card z-10">
        <div>
          <h1 className="text-sm font-bold text-foreground tracking-wider">
            {t("groupSettings.title", { name: activeRoom.name })}
          </h1>
          <p className="text-[10px] text-text-muted font-mono mt-0.5">{t("groupSettings.subtitle")}</p>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="secondary" onClick={handleCloseAttempt} className="text-xs py-1 px-3">
            {t("groupSettings.close")}
          </Button>
          <Button type="button" variant="primary" onClick={() => void refreshMembers()} className="text-xs py-1 px-3">
            {t("groupSettings.reloadMembers")}
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6 bg-surface-card flex flex-col gap-6">
        {feedback && (
          <div className="border border-border-secondary bg-surface-muted px-3 py-2 text-xs text-foreground">
            {feedback}
          </div>
        )}

        {canManageMembers && (
          <form onSubmit={handleSave} className="flex flex-col gap-4">
            <SectionTitle title={t("groupSettings.basicSettings")} />
            <div className="flex items-center gap-6 py-2">
              <Avatar
                name={name}
                src={avatarPreviewUrl ?? (activeRoom.avatarUrl ? resolveAssetUrl(activeRoom.avatarUrl) : undefined)}
                size="lg"
              />
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                className="hidden"
                onChange={handleAvatarFileChange}
              />
              <Button type="button" variant="secondary" onClick={handleAvatarClick}>
                {t("profile.changeAvatar")}
              </Button>
            </div>
            <div className="text-xs text-text-muted -mt-3">
              {t("avatarUpload.requirements")}
              {avatarFile ? ` ${t("avatarUpload.selected", { name: avatarFile.name })}` : ""}
            </div>
            <Input
              label={t("groupSettings.groupName")}
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }}
              required
            />
            <div className={cn(
              "flex items-center justify-end border-t border-border-primary py-3 gap-3 transition-all duration-300",
              shouldAlertEffect && "animate-red-flash"
            )}>
              {hasUnsavedChanges && (
                <span className="text-xs text-amber-600 font-sans mr-2 select-none">
                  ⚠️ {t("profile.unsavedChangesTip")}
                </span>
              )}
              <Button type="button" variant="secondary" onClick={handleCancel}>
                {t("profile.cancel")}
              </Button>
              <Button type="submit" variant="primary" disabled={isSaving}>
                {isSaving ? t("groupSettings.saving") : t("groupSettings.saveSettings")}
              </Button>
            </div>
          </form>
        )}

        {canManageMembers && (
          <section className="flex flex-col gap-4 pt-6">
            <SectionTitle title={t("groupSettings.additionalSettings")} />
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Checkbox
                label={t("groupSettings.requireApprovalLabel")}
                description={t("groupSettings.requireApprovalDesc")}
                checked={requireApproval}
                onChange={(event) => void handleRequireApprovalChange(event.target.checked)}
              />
              <Checkbox
                label={t("groupSettings.viewHistoryLabel")}
                description={t("groupSettings.viewHistoryDesc")}
                checked={viewHistory}
                onChange={(event) => void handleViewHistoryChange(event.target.checked)}
              />
            </div>
          </section>
        )}

        <div className="flex items-center justify-between border border-border-secondary bg-surface-muted px-3 py-2 gap-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-foreground">{t("groupSettings.inviteCode")}</p>
            <p className="text-[10px] text-text-muted mt-1">{t("groupSettings.inviteCodeDesc")}</p>
            <code className="text-xs font-mono text-primary mt-1 block">
              {activeRoom.inviteCode ?? t("groupSettings.inviteCodeNotGenerated")}
            </code>
          </div>
          {activeRoom.inviteCode && (
            <div className="flex flex-col gap-1 shrink-0">
              <Button
                type="button"
                variant="secondary"
                className="text-xs py-1 px-3"
                onClick={() => void handleCopyInviteCode()}
              >
                {t("groupSettings.copyInviteCode")}
              </Button>
              <Button
                type="button"
                variant="secondary"
                className="text-xs py-1 px-3"
                onClick={() => void handleCopyInviteLink()}
              >
                {t("groupSettings.copyInviteLink")}
              </Button>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2 border border-border-secondary bg-surface-muted px-3 py-3">
          <p className="text-xs font-semibold text-foreground">{t("groupSettings.searchInviteTitle")}</p>
          <p className="text-[10px] text-text-muted">{t("groupSettings.searchInviteDesc")}</p>
          <div className="flex gap-2">
            <Input
              label=""
              value={searchQuery}
              onChange={(event) => handleSearchQueryChange(event.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }}
              placeholder={t("groupSettings.searchPlaceholder")}
            />
          </div>
          {isSearching && <p className="text-[10px] text-text-muted">{t("groupSettings.searching")}</p>}
          {!isSearching && searchQuery.trim() && searchResults.length === 0 && (
            <p className="text-[10px] text-text-muted">{t("groupSettings.noSearchResults")}</p>
          )}
          {searchResults.length > 0 && (
            <div className="flex flex-col divide-y divide-border-secondary border border-border-secondary rounded-sm overflow-hidden">
              {searchResults.map((candidate) => (
                <div
                  key={candidate.userId}
                  className="flex items-center justify-between px-3 py-2 text-xs bg-surface-card"
                >
                  <span className="font-medium text-foreground">{candidate.name}</span>
                  <Button
                    type="button"
                    variant="secondary"
                    className="text-[10px] py-1 px-2"
                    onClick={() => void handleSendInviteMessage(candidate)}
                  >
                    {t("groupSettings.sendInvite")}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>


        <section className="flex flex-col gap-3">
          <SectionTitle title={t("groupSettings.membersTitle", { count: String(members.length) })} />
          <div className="flex flex-col border border-border-primary divide-y divide-border-secondary rounded-sm bg-surface-card">
            {members.map((member) => (
              <MemberRow
                key={member.userId}
                member={member}
                currentUser={user}
                canManageMembers={canManageMembers}
                canTransferOwner={canTransferOwner}
                onApprove={handleApprove}
                onRoleChange={handleRoleChange}
                onNickname={handleNickname}
                onToggleMute={handleToggleMute}
                onKick={handleKick}
                onTransferOwner={handleTransferOwner}
                isBusy={memberActionUserId === member.userId}
              />
            ))}
            {members.length === 0 && (
              <div className="p-6 text-center text-xs text-text-muted">{t("groupSettings.noMembers")}</div>
            )}
          </div>
        </section>

        {canTransferOwner && (
          <section className="flex flex-col gap-3 border border-red-500/20 p-4 bg-red-500/5 rounded-sm">
            <SectionTitle title={t("groupSettings.dangerZone")} danger />
            <div className="flex flex-col items-start gap-4">
              <div className="flex flex-col items-start gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void handleArchiveToggle()}
                  disabled={isSaving}
                  className="text-amber-600 border-amber-600 hover:bg-amber-500/10"
                >
                  {activeRoom.isArchived ? t("groupSettings.unarchive") : t("groupSettings.archive")}
                </Button>
                <span className="text-[10px] text-amber-600/70 leading-normal">
                  {activeRoom.isArchived ? t("groupSettings.unarchiveDesc") : t("groupSettings.archiveDesc")}
                </span>
              </div>
              <div className="flex flex-col items-start gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={handleDeleteGroupConfirm}
                  className="text-red-600 border-red-600 hover:bg-red-500/10"
                >
                  {t("groupSettings.deleteGroup")}
                </Button>
                <span className="text-[10px] text-red-600/70 leading-normal">
                  {t("groupSettings.deleteGroupDesc")}
                </span>
              </div>
            </div>
          </section>
        )}
      </div>

      <Modal
        isOpen={isModifyNickOpen}
        onClose={() => {
          setIsModifyNickOpen(false);
          setSelectedMember(null);
        }}
        title={t("chatroom.modifyNickname")}
      >
        <form onSubmit={handleModifyNickSubmit} className="flex flex-col gap-5">
          <Input
            label={t("chatroom.nickname")}
            value={nickInputValue}
            onChange={(e) => setNickInputValue(e.target.value)}
            required
            placeholder={t("chatroom.nicknamePlaceholder")}
          />
          <div className="flex justify-end gap-3">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setIsModifyNickOpen(false);
                setSelectedMember(null);
              }}
            >
              {t("chatroom.cancel")}
            </Button>
            <Button type="submit">
              {t("chatroom.save")}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

function SectionTitle({ title, danger = false }: { title: string; danger?: boolean }) {
  return (
    <h3
      className={`text-xs font-bold uppercase tracking-wider border-b pb-1 ${danger ? "text-red-600 border-red-500/30" : "text-primary border-border-secondary"}`}
    >
      {title}
    </h3>
  );
}

function MemberRow({
  member,
  currentUser,
  canManageMembers,
  canTransferOwner,
  onApprove,
  onRoleChange,
  onNickname,
  onToggleMute,
  onKick,
  onTransferOwner,
  isBusy,
}: {
  member: Member;
  currentUser: { userId?: string; username: string; avatar: string };
  canManageMembers: boolean;
  canTransferOwner: boolean;
  onApprove: (member: Member) => Promise<void>;
  onRoleChange: (member: Member, role: "admin" | "member") => Promise<void>;
  onNickname: (member: Member) => Promise<void> | void;
  onToggleMute: (member: Member) => Promise<void>;
  onKick: (member: Member) => Promise<void>;
  onTransferOwner: (member: Member) => Promise<void>;
  isBusy: boolean;
}) {
  const { t } = useTranslation();
  const isSelf = member.userId === currentUser.userId || member.name === currentUser.username;
  const isOwner = member.role === "owner";
  const isPending = member.role === "pending";
  const isCurrentUserOwner = canTransferOwner;
  const isCurrentUserAdmin = canManageMembers && !canTransferOwner;
  const canOwnerManageTarget = isCurrentUserOwner && !isPending && !isOwner && !isSelf;
  const canAdminManageTarget =
    isCurrentUserAdmin && !isPending && !isSelf && member.role === "member";
  const canEditNickname =
    !isPending && (isSelf || canOwnerManageTarget || canAdminManageTarget);
  const canModerateMember = canOwnerManageTarget || canAdminManageTarget;

  const menuItems: DropdownItem[] = [];

  if (isPending && canManageMembers) {
    menuItems.push({
      label: t("groupSettings.approve"),
      onClick: () => void onApprove(member),
    });
  }

  if (canEditNickname) {
    menuItems.push({
      label: t("groupSettings.nickname"),
      onClick: () => void onNickname(member),
    });
  }

  if (canModerateMember) {
    menuItems.push({
      label: member.isMuted ? t("groupSettings.unmute") : t("groupSettings.mute"),
      onClick: () => void onToggleMute(member),
    });
  }

  if (canTransferOwner && !isOwner && !isPending) {
    menuItems.push({
      label: t("groupSettings.changeRole") || "Change Role",
      subMenuItems: [
        {
          label: "admin",
          onClick: () => void onRoleChange(member, "admin"),
        },
        {
          label: "member",
          onClick: () => void onRoleChange(member, "member"),
        },
      ],
    });

    menuItems.push({
      label: t("groupSettings.transferOwner"),
      onClick: () => void onTransferOwner(member),
    });
  }

  if (canModerateMember) {
    menuItems.push({
      label: t("groupSettings.kick"),
      variant: "danger",
      onClick: () => void onKick(member),
    });
  }

  return (
    <div className="flex flex-col gap-3 p-3 text-xs md:flex-row md:items-center md:justify-between">
      <div className="flex items-center gap-3 min-w-0">
        <Avatar
          name={member.name}
          src={
            member.avatarUrl
              ? resolveAssetUrl(member.avatarUrl)
              : isSelf && currentUser.avatar
                ? resolveAssetUrl(currentUser.avatar)
                : undefined
          }
          size="sm"
        />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="font-semibold text-foreground truncate">
              {member.nickname ? `${member.nickname} (${member.name})` : member.name}
            </p>
            {isSelf && <span className="text-[9px] text-primary font-mono font-bold uppercase px-1.5 py-0.5 border border-primary/20 bg-primary/5 rounded-sm">YOU</span>}
            {member.isMuted && <span className="text-[9px] text-red-600 font-mono font-bold uppercase px-1.5 py-0.5 border border-red-500/20 bg-red-500/5 rounded-sm">MUTED</span>}
            <span className={`text-[9px] font-mono font-bold uppercase px-1.5 py-0.5 border rounded-sm ${
              member.role === "owner" ? "text-amber-600 border-amber-500/20 bg-amber-500/5" :
              member.role === "admin" ? "text-purple-600 border-purple-500/20 bg-purple-500/5" :
              member.role === "pending" ? "text-amber-500 border-amber-500/20 bg-amber-500/5" :
              "text-text-muted border-border-secondary/40 bg-surface-muted"
            }`}>
              {member.role}
            </span>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 md:justify-end">
        {menuItems.length > 0 && (
          <Dropdown
            trigger={
              <Button
                type="button"
                variant="secondary"
                className="text-xs py-1 px-2.5 flex items-center gap-1.5 cursor-pointer"
                disabled={isBusy}
              >
                {isBusy ? "..." : t("groupSettings.manageMember") || "Manage"}
                <svg className="h-3 w-3 opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </Button>
            }
            items={menuItems}
          />
        )}
      </div>
    </div>
  );
}
