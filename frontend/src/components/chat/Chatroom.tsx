"use client";

import React, { useState, useEffect, useLayoutEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useChat, getAvatarForUser, Message } from "@/context/ChatContext";
import { resolveAssetUrl } from "@/lib/assets";
import { Button } from "@/components/ui/Button";
import { Dropdown } from "@/components/ui/Dropdown";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { ChatBubble } from "@/components/ui/ChatBubble";
import { useTranslation } from "@/hooks/useTranslation";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Icon } from "@iconify/react";

interface ChatroomProps {
  roomId: string;
  onOpenGroupSettings?: () => void;
}

interface MentionDraft {
  start: number;
  end: number;
  query: string;
}

interface MentionCandidate {
  key: string;
  label: string;
  token: string;
  detail: string;
}

interface PendingAttachment {
  file: File;
  previewUrl: string | null;
}

const revokePendingAttachments = (attachments: PendingAttachment[]) => {
  attachments.forEach((attachment) => {
    if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
  });
};

const EVERYONE_MENTION = "everyone";

const formatFileSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const getMentionDraft = (value: string, cursorPosition: number): MentionDraft | null => {
  const beforeCursor = value.slice(0, cursorPosition);
  const match = beforeCursor.match(/(?:^|\s)@([^\s@]*)$/);

  if (!match) return null;

  const start = beforeCursor.lastIndexOf("@");
  if (start < 0) return null;

  return {
    start,
    end: cursorPosition,
    query: match[1] ?? "",
  };
};

export default function Chatroom({ roomId, onOpenGroupSettings }: ChatroomProps) {
  const router = useRouter();
  const {
    rooms,
    messages,
    user,
    friends,
    activeRoomNicknames,
    handleSendMessage,
    handleTyping,
    handleUploadAttachments,
    handleRecallMessage,
    handleUpdateMessage,
    handleModifyNickname,
    handleLeaveOrBlock,
    getReadAvatarsForMessage,
    showRightPanel,
    setShowRightPanel,
    typingUsers,
    groupReadStates,
    markRoomAsRead,
  } = useChat();

  const [inputText, setInputText] = useState("");
  const [mentionDraft, setMentionDraft] = useState<MentionDraft | null>(null);
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0);
  const [replyTarget, setReplyTarget] = useState<Message | null>(null);
  const [editingMessage, setEditingMessage] = useState<Message | null>(null);
  const [isModifyNickOpen, setIsModifyNickOpen] = useState(false);
  const [nickInputValue, setNickInputValue] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [isUploadingAttachment, setIsUploadingAttachment] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [msgSearchQuery, setMsgSearchQuery] = useState("");
  const messageEndRef = useRef<HTMLDivElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const { t } = useTranslation();
  const [isMultiLine, setIsMultiLine] = useState(false);
  const [currentRoomUnreadId, setCurrentRoomUnreadId] = useState<string | null>(null);
  const [hasInitializedUnread, setHasInitializedUnread] = useState(false);
  const maxMessageLength = Number(process.env.NEXT_PUBLIC_MAX_MESSAGE_LENGTH || 1000);

  const activeRoom = rooms.find((r) => r.id === roomId);
  const currentMember = activeRoom?.members?.find((m) => m.userId === user.userId || m.name === user.username);
  const isReadOnlyRoom = Boolean(activeRoom?.isArchived || activeRoom?.isReadonly);
  const isPending = Boolean(currentMember?.role === "pending");
  const isOwner = activeRoom?.type === "group" && currentMember?.role === "owner";
  const mentionQuery = mentionDraft?.query.toLowerCase() ?? "";
  const memberMentionCandidates: MentionCandidate[] = mentionDraft
    ? (activeRoom?.members ?? [])
        .filter((member) => member.userId !== user.userId)
        .filter((member) =>
          mentionQuery
            ? member.name.toLowerCase().startsWith(mentionQuery)
            : true,
        )
        .map((member) => ({
          key: member.userId,
          label: member.name,
          token: member.name,
          detail: `@${member.name}`,
        }))
    : [];

  const mentionCandidates: MentionCandidate[] = mentionDraft
    ? [
        ...(EVERYONE_MENTION.startsWith(mentionQuery)
          ? [{
              key: "__everyone__",
              label: t("chatroom.everyoneMention"),
              token: EVERYONE_MENTION,
              detail: "@everyone",
            }]
          : []),
        ...memberMentionCandidates,
      ]
    : [];

  const mentionResetKey = `${roomId}|${mentionDraft ? `q:${mentionDraft.query}` : "none"}`;
  const [prevMentionResetKey, setPrevMentionResetKey] = useState(mentionResetKey);
  if (prevMentionResetKey !== mentionResetKey) {
    setPrevMentionResetKey(mentionResetKey);
    setSelectedMentionIndex(0);
  }

  const [prevRoomId, setPrevRoomId] = useState(roomId);
  if (prevRoomId !== roomId) {
    setPrevRoomId(roomId);
    setIsSearchOpen(false);
    setMsgSearchQuery("");
    revokePendingAttachments(pendingAttachments);
    setPendingAttachments([]);
    setIsUploadingAttachment(false);
    setInputText("");
    setReplyTarget(null);
    setHasInitializedUnread(false);
    setCurrentRoomUnreadId(null);
  }

  // Track whether the user is at the bottom of the message list
  useEffect(() => {
    const el = scrollAreaRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      if (atBottom && !isAtBottomRef.current) {
        isAtBottomRef.current = true;
        markRoomAsRead(roomId);
      } else if (!atBottom) {
        isAtBottomRef.current = false;
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [roomId, markRoomAsRead]);

  // Track user interactions to mark room as read when at the bottom
  useEffect(() => {
    const el = scrollAreaRef.current;
    if (!el) return;

    const handleInteraction = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      if (atBottom) {
        markRoomAsRead(roomId);
      }
    };

    window.addEventListener("click", handleInteraction, { passive: true });
    window.addEventListener("keydown", handleInteraction, { passive: true });

    return () => {
      window.removeEventListener("click", handleInteraction);
      window.removeEventListener("keydown", handleInteraction);
    };
  }, [roomId, markRoomAsRead]);

  // Initialize unread message ID for the current session (once per roomId entry)
  useEffect(() => {
    if (hasInitializedUnread) return;

    const room = rooms.find((r) => r.id === roomId);
    if (!room) return;

    const roomMsgs = messages.filter((m) => m.roomId === roomId);
    const hasMessagesExpected = !!(room.lastMessagePreview || room.lastMessageAt);

    if (hasMessagesExpected && roomMsgs.length === 0) {
      return;
    }

    const myLastReadId =
      groupReadStates[roomId]?.[user.userId ?? ""] ??
      room.lastReadId ??
      room.members?.find((m) => m.userId === user.userId)?.lastReadId ??
      null;

    const sortedMsgs = [...roomMsgs].sort((a, b) => {
      const timeDiff = new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime();
      if (timeDiff !== 0) return timeDiff;
      return a.id.localeCompare(b.id);
    });

    let initialUnreadId: string | null = null;
    if (myLastReadId) {
      const lastReadIdx = sortedMsgs.findIndex((m) => m.id === myLastReadId);
      const firstUnreadMsg = sortedMsgs.slice(lastReadIdx >= 0 ? lastReadIdx + 1 : 0).find((m) => m.senderId !== user.userId);
      initialUnreadId = firstUnreadMsg?.id ?? null;
    } else if (room.unreadCount && room.unreadCount > 0) {
      const firstUnreadMsg = sortedMsgs.find((m) => m.senderId !== user.userId);
      initialUnreadId = firstUnreadMsg?.id ?? null;
    }

    setTimeout(() => {
      setCurrentRoomUnreadId(initialUnreadId);
      setHasInitializedUnread(true);
    }, 0);
  }, [roomId, messages, rooms, groupReadStates, user.userId, hasInitializedUnread]);

  const lastScrolledRoomIdRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const room = rooms.find((r) => r.id === roomId);
    if (!room) return;

    if (lastScrolledRoomIdRef.current !== roomId) {
      if (!hasInitializedUnread) {
        return;
      }

      lastScrolledRoomIdRef.current = roomId;

      if (currentRoomUnreadId) {
        const marker = scrollAreaRef.current?.querySelector("[data-unread-marker='true']");
        const target = marker || scrollAreaRef.current?.querySelector(`[data-msg-id="${currentRoomUnreadId}"]`);
        if (target) {
          target.scrollIntoView({ behavior: "auto", block: "center" });
          
          // Check if scrolling actually put us at the bottom
          const el = scrollAreaRef.current;
          const atBottom = el ? el.scrollHeight - el.scrollTop - el.clientHeight < 80 : false;
          if (atBottom) {
            isAtBottomRef.current = true;
          } else {
            isAtBottomRef.current = false;
          }
        } else {
          messageEndRef.current?.scrollIntoView({ behavior: "auto" });
          isAtBottomRef.current = true;
        }
      } else {
        messageEndRef.current?.scrollIntoView({ behavior: "auto" });
        isAtBottomRef.current = true;
        markRoomAsRead(roomId);
      }
    } else if (isAtBottomRef.current) {
      // Same room, new messages — auto-scroll only if already at bottom
      messageEndRef.current?.scrollIntoView({ behavior: "smooth" });
      markRoomAsRead(roomId);
    }
  }, [roomId, rooms, markRoomAsRead, currentRoomUnreadId, hasInitializedUnread]);



  // Auto-resize the textarea height based on content
  useEffect(() => {
    const textarea = inputRef.current;
    if (!textarea) return;

    textarea.style.height = "auto";
    const maxHeight = window.innerHeight * 0.5;
    if (textarea.scrollHeight > maxHeight) {
      textarea.style.height = `${maxHeight}px`;
      textarea.style.overflowY = "auto";
    } else {
      textarea.style.height = `${textarea.scrollHeight}px`;
      textarea.style.overflowY = "hidden";
    }
    setIsMultiLine(inputText.includes("\n") || textarea.scrollHeight > 48);
  }, [inputText]);
  const pendingAttachmentsRef = useRef(pendingAttachments);
  pendingAttachmentsRef.current = pendingAttachments;
  useEffect(() => {
    return () => revokePendingAttachments(pendingAttachmentsRef.current);
  }, []);

  const handleToggleSearch = () => {
    if (isSearchOpen) {
      setIsSearchOpen(false);
      setMsgSearchQuery("");
    } else {
      setIsSearchOpen(true);
      requestAnimationFrame(() => searchInputRef.current?.focus());
    }
  };

  if (!activeRoom) {
    return (
      <div className="flex-1 flex items-center justify-center bg-background text-foreground font-sans">
        {t("chatroom.notFound")}
      </div>
    );
  }

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isUploadingAttachment) return;
    if (!inputText.trim() && pendingAttachments.length === 0) return;

    if (editingMessage) {
      try {
        handleUpdateMessage(activeRoom.id, editingMessage.id, inputText);
        setEditingMessage(null);
        setInputText("");
      } catch (error) {
        console.error(error);
        alert(error instanceof Error ? error.message : "Failed to update message");
      }
      return;
    }

    try {
      if (pendingAttachments.length > 0) {
        setIsUploadingAttachment(true);
        await handleUploadAttachments(
          activeRoom.id,
          pendingAttachments.map((p) => p.file),
          { content: inputText, replyTarget },
        );
        revokePendingAttachments(pendingAttachments);
        setPendingAttachments([]);
      } else {
        handleSendMessage(activeRoom.id, inputText, replyTarget);
      }

      handleTyping(activeRoom.id, false);
      setInputText("");
      setReplyTarget(null);
    } catch (error) {
      console.error(error);
      alert(error instanceof Error ? error.message : "Failed to send message");
    } finally {
      setIsUploadingAttachment(false);
    }
  };

  const handleAttach = () => {
    fileInputRef.current?.click();
  };

  const handleFileSelected = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files ? Array.from(event.target.files) : [];
    event.target.value = "";
    if (files.length === 0) return;
    const newAttachments: PendingAttachment[] = files.map((file) => ({
      file,
      previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
    }));
    setPendingAttachments((prev) => [...prev, ...newAttachments]);
  };

  const handleRemovePendingAttachment = (index: number) => {
    if (isUploadingAttachment) return;
    setPendingAttachments((prev) => {
      const removed = prev[index];
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter((_, i) => i !== index);
    });
  };

  const handleModifyNick = () => {
    if (!activeRoom) return;
    const currentNick = activeRoomNicknames[activeRoom.id] || user.username;
    setNickInputValue(currentNick);
    setIsModifyNickOpen(true);
  };

  const handleModifyNickSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeRoom) return;
    const trimmed = nickInputValue.trim();
    try {
      await handleModifyNickname(activeRoom.id, trimmed || user.username);
    } catch (error) {
      console.error(error);
      alert(error instanceof Error ? error.message : "Failed to update nickname");
    }
    setIsModifyNickOpen(false);
  };

  const handleLeaveOrBlockAction = async () => {
    const action =
      activeRoom.type === "group"
        ? t("chatroom.leave")
        : activeRoom.isReadonly
          ? t("chatroom.unblock")
          : t("chatroom.block");
    if (confirm(t("chatroom.confirmLeaveOrBlock", { action, name: activeRoom.name }))) {
      const { isDeleted, newActiveId } = await handleLeaveOrBlock(activeRoom.id);
      if (isDeleted) {
        if (newActiveId) {
          router.push(`/chat/${newActiveId}`);
        } else {
          router.push("/");
        }
      }
    }
  };

  const handleMentionSelect = (mentionToken: string) => {
    if (!mentionDraft) return;

    const nextText =
      `${inputText.slice(0, mentionDraft.start)}@${mentionToken} ${inputText.slice(mentionDraft.end)}`;
    const nextCursorPosition = mentionDraft.start + mentionToken.length + 2;

    setInputText(nextText);
    setMentionDraft(null);

    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(nextCursorPosition, nextCursorPosition);
    });
  };

  const handleMentionKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    if (!mentionDraft || mentionCandidates.length === 0) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedMentionIndex((current) => (current + 1) % mentionCandidates.length);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedMentionIndex((current) =>
        current === 0 ? mentionCandidates.length - 1 : current - 1,
      );
      return;
    }

    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      handleMentionSelect(mentionCandidates[selectedMentionIndex]?.token ?? mentionCandidates[0].token);
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      setMentionDraft(null);
    }
  };

  return (
    <div className="flex-1 flex flex-col bg-background h-full overflow-hidden">
      {/* Chat Panel Header */}
      <div className="h-14 border-b border-border-primary px-3 md:px-6 flex items-center justify-between select-none shrink-0 bg-surface-card z-10 gap-2">
        <div className="flex items-center gap-1 md:gap-3 min-w-0">
        <button
          type="button"
          onClick={() => router.push("/")}
          aria-label={t("settingsHeader.backToChat")}
          className="md:hidden shrink-0 p-1.5 -ml-1 text-text-muted hover:text-foreground rounded-sm transition-colors cursor-pointer"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div className="flex items-center gap-3 relative min-w-0">
          <Avatar
            name={activeRoom.name}
            src={(() => {
              if (activeRoom.avatarUrl) {
                return resolveAssetUrl(activeRoom.avatarUrl);
              }
              if (activeRoom.type === "msg") {
                const otherMember = activeRoom.members?.find((m) => m.userId !== user.userId);
                if (otherMember?.avatarUrl) {
                  return resolveAssetUrl(otherMember.avatarUrl);
                }
                const friend = friends.find((f) => f.id === activeRoom.otherMemberId || f.name === activeRoom.name);
                if (friend?.avatarUrl) {
                  return resolveAssetUrl(friend.avatarUrl);
                }
              }
              return getAvatarForUser(activeRoom.name, user.avatar, user.username);
            })()}
            size="sm"
            isOnline={activeRoom.isOnline}
          />
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-sm font-bold text-foreground truncate max-w-50">
                {activeRoom.name}
              </h1>
              {isPending && (
                <Badge className="bg-amber-500/10 border-amber-500 text-amber-500 normal-case shrink-0">
                  {t("chatroom.pendingApproval")}
                </Badge>
              )}
              {isReadOnlyRoom && <Badge variant="danger">{t("chatroom.readOnly")}</Badge>}
            </div>
            {activeRoom.type === "group" && (
              <span className="text-[10px] text-text-muted font-mono leading-none">
                {t("chatroom.groupChatInfo", { count: activeRoom.members?.length || 0 })}
              </span>
            )}
          </div>
        </div>
        </div>

        {/* Header Action Elements */}
        <div className="flex items-center gap-2 md:gap-3 shrink-0">
          {/* Group Settings Button */}
          {activeRoom.type === "group" && onOpenGroupSettings && !isPending && (
            <Button
              variant="secondary"
              onClick={onOpenGroupSettings}
              className="py-1 px-3 text-xs flex items-center gap-1.5"
            >
              <Icon icon="boxicons:slider-vertical" className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{t("chatroom.groupSettings")}</span>
            </Button>
          )}

          <button
            onClick={handleToggleSearch}
            className={`p-1.5 border rounded-sm transition-colors cursor-pointer ${
              isSearchOpen
                ? "bg-primary/10 border-primary/30 text-primary"
                : "border-border-secondary hover:border-border-primary text-text-muted hover:text-foreground"
            }`}
            title={isSearchOpen ? t("chatroom.closeSearch") : t("chatroom.searchMessages")}
          >
            <Icon icon="boxicons:search" className="h-4 w-4" />
          </button>

          <Dropdown
            trigger={
              <button
                className="p-1.5 border border-border-secondary hover:border-border-primary rounded-sm text-text-muted hover:text-foreground transition-colors cursor-pointer"
                title={t("chatroom.chatOptions")}
              >
                <Icon icon="bx:dots-horizontal-rounded" className="h-4 w-4" />
              </button>
            }
            items={[
              { label: t("chatroom.modifyNickname"), onClick: handleModifyNick },
              {
                label:
                  activeRoom.type === "group"
                    ? isOwner
                      ? t("chatroom.ownerCannotLeave")
                      : t("chatroom.leaveGroup")
                    : activeRoom.isReadonly
                      ? t("chatroom.unblock")
                      : t("chatroom.blockContact"),
                onClick: isOwner ? undefined : handleLeaveOrBlockAction,
                disabled: isOwner,
                variant: activeRoom.isReadonly ? "default" : "danger",
              },
            ]}
          />

          <button
            onClick={() => setShowRightPanel(!showRightPanel)}
            className={`p-1.5 border rounded-sm transition-colors cursor-pointer ${
              showRightPanel
                ? "bg-primary/10 border-primary/30 text-primary"
                : "border-border-secondary hover:border-border-primary text-text-muted hover:text-foreground"
            }`}
            title={showRightPanel ? t("chatroom.hideInfoPanel") : t("chatroom.showInfoPanel")}
          >
            <Icon icon="boxicons:sidebar-right" className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Search Bar */}
      {isSearchOpen && (
        <div className="border-b border-border-primary bg-surface-card px-3 md:px-6 py-2 flex items-center gap-2 shrink-0">
          <Icon icon="boxicons:search" className="h-4 w-4 text-text-muted shrink-0" />
          <input
            ref={searchInputRef}
            type="text"
            value={msgSearchQuery}
            onChange={(e) => setMsgSearchQuery(e.target.value)}
            placeholder="搜尋訊息..."
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-text-muted outline-none"
            onKeyDown={(e) => { if (e.key === "Escape") handleToggleSearch(); }}
          />
          {msgSearchQuery.trim() && (
            <span className="text-[10px] text-text-muted font-mono shrink-0">
              {messages.filter((m) => m.roomId === activeRoom.id && !m.content.startsWith("[System] ") && m.content.toLowerCase().includes(msgSearchQuery.toLowerCase().trim())).length} 筆結果
            </span>
          )}
          <button
            type="button"
            onClick={handleToggleSearch}
            className="p-0.5 text-text-muted hover:text-foreground transition-colors cursor-pointer shrink-0"
          >
            <Icon icon="boxicons:x" className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Chat Messages Area */}
      <div ref={scrollAreaRef} className="flex-1 overflow-y-auto p-3 md:p-6 flex flex-col gap-4">
        {messages
          .filter((m) => {
            if (m.roomId !== activeRoom.id) return false;
            const q = msgSearchQuery.trim().toLowerCase();
            if (!q) return true;
            return !m.content.startsWith("[System] ") && m.content.toLowerCase().includes(q);
          })
          .map((msg) => {
            if (msg.content.startsWith("[System] ")) {
              return (
                <React.Fragment key={msg.id}>
                  {currentRoomUnreadId === msg.id && (
                    <div data-unread-marker="true" className="w-full flex items-center my-3 select-none">
                      <div className="flex-1 border-t border-red-500/50"></div>
                      <span className="px-3 text-red-500 text-xs font-semibold uppercase tracking-wider font-sans">
                        {t("chatroom.newMessages")}
                      </span>
                      <div className="flex-1 border-t border-red-500/50"></div>
                    </div>
                  )}
                  <div
                    data-msg-id={msg.id}
                    className="w-full flex justify-center my-2 select-none"
                  >
                    <div className="bg-surface-card border border-border-secondary px-3 py-1 rounded-full text-xs text-text-muted">
                      {msg.content.substring(9)}
                    </div>
                  </div>
                </React.Fragment>
              );
            }

            const senderMember = activeRoom.members?.find((m) => m.userId === msg.senderId);
            const displayName = senderMember?.nickname || msg.senderName;

            // Calculate isRead for private chats
            let isRead = msg.isRead || false;
            if (activeRoom.type === "msg" && msg.isOutgoing) {
              const otherUserId = activeRoom.otherMemberId || activeRoom.members?.find((m) => m.userId !== user.userId)?.userId;
              if (otherUserId) {
                const otherLastReadId = groupReadStates[activeRoom.id]?.[otherUserId];
                if (otherLastReadId) {
                  const roomMessages = messages.filter((m) => m.roomId === activeRoom.id);
                  const msgIndex = roomMessages.findIndex((m) => m.id === msg.id);
                  const lastReadIndex = roomMessages.findIndex((m) => m.id === otherLastReadId);
                  isRead = lastReadIndex !== -1 && msgIndex !== -1 && msgIndex <= lastReadIndex;
                }
              }
            }

            const currentMember = activeRoom.members?.find((m) => m.userId === user.userId);
            const isRoomOwner = currentMember?.role === "owner";
            const isRoomAdmin = currentMember?.role === "admin";
            const isSenderOwnerOrAdmin = senderMember?.role === "owner" || senderMember?.role === "admin";
            const canAdminRecall = isRoomAdmin && !isSenderOwnerOrAdmin;
            const canRecall = Boolean(msg.isOutgoing) || isRoomOwner || canAdminRecall;

            return (
              <React.Fragment key={msg.id}>
                {currentRoomUnreadId === msg.id && (
                  <div data-unread-marker="true" className="w-full flex items-center my-3 select-none">
                    <div className="flex-1 border-t border-red-500/50"></div>
                    <span className="px-3 text-red-500 text-xs font-semibold uppercase tracking-wider font-sans">
                      {t("chatroom.newMessages")}
                    </span>
                    <div className="flex-1 border-t border-red-500/50"></div>
                  </div>
                )}
                <div
                  data-msg-id={msg.id}
                  className={`group/msg flex flex-col ${msg.isOutgoing ? "items-end" : "items-start"}`}
                >
                  <ChatBubble
                    content={msg.content}
                    senderName={displayName}
                    timestamp={msg.timestamp}
                    isOutgoing={msg.isOutgoing}
                    isHighEmphasis={msg.isOutgoing}
                    isRecalled={msg.isRecalled}
                    replyTo={msg.replyTo || undefined}
                    attachments={msg.attachments}
                    senderAvatar={
                      msg.isOutgoing
                        ? user.avatar
                        : senderMember?.avatarUrl
                        ? resolveAssetUrl(senderMember.avatarUrl)
                        : undefined
                    }
                    isRead={isRead}
                    senderId={msg.senderId || undefined}
                    messageId={msg.id}
                    onReply={() => setReplyTarget(msg)}
                    onRecall={() => handleRecallMessage(msg.id)}
                    onEdit={() => {
                      setEditingMessage(msg);
                      setInputText(msg.content);
                      requestAnimationFrame(() => {
                        inputRef.current?.focus();
                      });
                    }}
                    canRecall={canRecall}
                    canEdit={msg.isOutgoing && !msg.isRecalled}
                    avatarName={
                      msg.isOutgoing
                        ? user.username
                        : senderMember?.name || msg.senderName
                    }
                    searchHighlight={msgSearchQuery.trim() || undefined}
                  />

                  {/* Render read receipt avatars on the far right of the screen */}
                  {((activeRoom.type === "group" || activeRoom.type === "msg") &&
                    getReadAvatarsForMessage(activeRoom, msg).length > 0) && (
                    <div className="self-stretch flex gap-1 mt-1 justify-end px-0.5 select-none">
                      {getReadAvatarsForMessage(activeRoom, msg).map((reader, idx) => (
                        <div
                          key={idx}
                          className="h-4.5 w-4.5 border border-border-primary bg-surface-muted rounded-sm overflow-hidden flex items-center justify-center"
                          title={reader.displayName || reader.name}
                        >
                          {reader.avatarUrl ? (
                            /* eslint-disable-next-line @next/next/no-img-element */
                            <img src={resolveAssetUrl(reader.avatarUrl)} alt={reader.name} className="h-full w-full object-cover" />
                          ) : (
                            <span className="text-[8px] font-bold leading-none">
                              {reader.name
                                .split(" ")
                                .map((n) => n[0])
                                .join("")
                                .slice(0, 2)
                                .toUpperCase() || "U"}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {!msg.isRecalled && (
                    <div className="opacity-0 group-hover/msg:opacity-100 flex gap-2.5 mt-1 select-none text-[10px] text-text-muted transition-opacity">
                      <button
                        onClick={() => setReplyTarget(msg)}
                        className="hover:text-primary transition-colors cursor-pointer"
                      >
                        {t("chatroom.reply")}
                      </button>
                      {canRecall && (
                        <button
                          onClick={() => handleRecallMessage(msg.id)}
                          className="hover:text-danger transition-colors cursor-pointer"
                        >
                          {t("chatroom.recall")}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </React.Fragment>
            );
          })}
        <div ref={messageEndRef} />
      </div>

      {replyTarget && (
        <div className="bg-surface-muted border-t border-border-primary px-3 md:px-6 py-2 flex items-center justify-between text-xs select-none">
          <div className="flex-1 min-w-0 border-l-2 border-primary pl-2">
            <span className="font-bold text-foreground block">{t("chatroom.replyTo", { name: activeRoom.members?.find((m) => m.userId === replyTarget.senderId)?.nickname || replyTarget.senderName })}</span>
            <p className="text-text-muted truncate mt-0.5">
              {replyTarget.content || replyTarget.attachments?.[0]?.filename}
            </p>
          </div>
          <button
            onClick={() => setReplyTarget(null)}
            className="text-text-muted hover:text-foreground cursor-pointer p-0.5 border border-transparent hover:border-border-primary rounded-sm ml-4"
          >
            <Icon icon="boxicons:x" className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {(() => {
        const names = typingUsers[activeRoom.id] ?? [];
        if (names.length === 0) return null;
        const label = names.length === 1
          ? `${names[0]} is typing...`
          : `${names.slice(0, 2).join(", ")} are typing...`;
        return (
          <div className="px-3 md:px-6 py-1 text-xs text-text-muted italic select-none">
            {label}
          </div>
        );
      })()}

      {/* Input Box Area */}
      <div className="border-t border-border-primary bg-surface-card px-3 py-3 md:px-6 md:py-4 shrink-0">
        {isPending ? (
          <div className="w-full text-center py-2.5 bg-amber-500/10 text-xs text-amber-600 font-medium select-none border border-dashed border-amber-500/30 rounded-sm">
            {t("chatroom.pendingApprovalBanner")}
          </div>
        ) : isReadOnlyRoom ? (
          <div className="w-full text-center py-2.5 bg-surface-muted text-xs text-text-muted uppercase tracking-wider select-none border border-dashed border-border-secondary rounded-sm">
            {t("chatroom.readOnlyOrBlocked")}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleFileSelected}
            />
            {pendingAttachments.length > 0 && (
              <div className="bg-surface-muted border border-border-primary px-4 py-3 flex flex-col gap-2 select-none rounded-sm">
                <span className="text-[10px] font-bold text-text-muted uppercase tracking-widest px-1">
                  {t("chatroom.attachmentPreview")} ({pendingAttachments.length})
                </span>
                <div className="flex flex-col gap-2.5 max-h-40 overflow-y-auto pr-1">
                  {pendingAttachments.map(({ file, previewUrl }, idx) => (
                    <div key={idx} className="flex items-center gap-3 text-xs border-l-2 border-primary pl-2.5 py-0.5">
                      <div className="h-10 w-10 shrink-0 rounded-sm border border-border-secondary bg-surface-card overflow-hidden flex items-center justify-center">
                        {previewUrl ? (
                          /* eslint-disable-next-line @next/next/no-img-element */
                          <img src={previewUrl} alt={file.name} className="h-full w-full object-cover" />
                        ) : (
                          <svg className="h-4 w-4 text-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                          </svg>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-foreground truncate font-semibold">{file.name}</p>
                        <p className="text-text-muted text-[10px] font-mono truncate mt-0.5">
                          {file.type || "application/octet-stream"} · {formatFileSize(file.size)}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleRemovePendingAttachment(idx)}
                        disabled={isUploadingAttachment}
                        className="text-text-muted hover:text-foreground cursor-pointer p-0.5 border border-transparent hover:border-border-primary rounded-sm disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                        title={t("chatroom.cancel")}
                      >
                        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <form onSubmit={handleSend} className="flex gap-2 md:gap-4 items-end">
              <button
                type="button"
                onClick={handleAttach}
                title={t("chatroom.uploadAttachment")}
                className="p-2.5 border border-border-secondary hover:border-border-primary rounded-sm text-text-muted hover:text-foreground transition-colors cursor-pointer shrink-0 mb-0.5"
              >
                <Icon icon="boxicons:paperclip" className="h-4 w-4" />
              </button>
              <div className="relative flex-1">
                {editingMessage && (
                  <div className="flex items-center justify-between bg-primary/10 border-l-4 border-primary px-3 py-1.5 text-xs text-foreground select-none rounded-sm mb-2">
                    <span className="flex items-center gap-1.5 truncate">
                      {t("chatroom.editingMessageBanner")}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingMessage(null);
                        setInputText("");
                      }}
                      className="text-text-muted hover:text-foreground cursor-pointer font-bold px-1"
                    >
                      {t("chatroom.cancel")}
                    </button>
                  </div>
                )}
                {mentionCandidates.length > 0 && (
                  <div className="absolute bottom-full left-0 right-0 mb-2 max-h-48 overflow-y-auto rounded-sm border border-border-primary bg-surface-card shadow-lg">
                    {mentionCandidates.map((candidate) => (
                      <button
                        key={candidate.key}
                        type="button"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => handleMentionSelect(candidate.token)}
                        className={`flex w-full items-center justify-between gap-3 border-b border-border-secondary/40 px-3 py-2 text-left text-xs text-foreground transition-colors last:border-b-0 ${
                          mentionCandidates[selectedMentionIndex]?.key === candidate.key
                            ? "bg-primary/10 text-primary"
                            : "hover:bg-surface-muted"
                        }`}
                      >
                        <span className="truncate font-semibold">{candidate.label}</span>
                        <span className="shrink-0 text-[10px] uppercase tracking-wider text-text-muted">
                          {candidate.detail}
                        </span>
                      </button>
                    ))}
                  </div>
                )}

                <textarea
                  ref={inputRef}
                  placeholder={t("chatroom.inputPlaceholder")}
                  value={inputText}
                  rows={1}
                  onChange={(e) => {
                    const nextText = e.target.value;
                    const nextCursorPosition = e.target.selectionStart ?? nextText.length;

                    setInputText(nextText);
                    setMentionDraft(getMentionDraft(nextText, nextCursorPosition));
                    handleTyping(activeRoom.id, nextText.length > 0);
                  }}
                  onClick={(e) => {
                    const nextCursorPosition = e.currentTarget.selectionStart ?? inputText.length;
                    setMentionDraft(getMentionDraft(inputText, nextCursorPosition));
                  }}
                  onKeyUp={(e) => {
                    const nextCursorPosition = e.currentTarget.selectionStart ?? inputText.length;
                    setMentionDraft(getMentionDraft(inputText, nextCursorPosition));
                  }}
                  onBlur={() => {
                    handleTyping(activeRoom.id, false);
                    setMentionDraft(null);
                  }}
                  onKeyDown={(e) => {
                    if (mentionDraft && mentionCandidates.length > 0) {
                      handleMentionKeyDown(e);
                      if (e.defaultPrevented) return;
                    }

                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void handleSend(e);
                    } else if (e.key === "Escape" && editingMessage) {
                      e.preventDefault();
                      setEditingMessage(null);
                      setInputText("");
                    }
                  }}
                  maxLength={maxMessageLength}
                  className="block w-full bg-surface-card border border-border-secondary hover:border-border-primary focus:border-primary focus:outline-none rounded-sm px-3.5 py-2.5 text-sm text-foreground transition-colors resize-none min-h-[38px] max-h-[50vh] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-zinc-300 hover:[&::-webkit-scrollbar-thumb]:bg-zinc-400 dark:[&::-webkit-scrollbar-thumb]:bg-zinc-700 dark:hover:[&::-webkit-scrollbar-thumb]:bg-zinc-600 [&::-webkit-scrollbar-thumb]:rounded-sm"
                />
              </div>

              {isMultiLine && (
                <span className="text-[11px] text-text-muted shrink-0 select-none pb-2.5 w-[70px] text-right">
                  ({inputText.length}/{maxMessageLength})
                </span>
              )}
              <Button
                type="submit"
                variant="primary"
                disabled={isUploadingAttachment}
                className="py-2.5 px-4 md:px-5 shrink-0 select-none"
              >
                {isUploadingAttachment ? "Uploading..." : t("chatroom.send")}
              </Button>
            </form>
          </div>
        )}
      </div>

      <Modal
        isOpen={isModifyNickOpen}
        onClose={() => setIsModifyNickOpen(false)}
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
              onClick={() => setIsModifyNickOpen(false)}
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
