"use client";

import React, { useCallback, useState, useEffect, useLayoutEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  useChat,
  useRealtimeReady,
  useRightPanel,
  useTypingUsers,
  getAvatarForUser,
  Message,
} from "@/context/ChatContext";
import { resolveAssetUrl } from "@/lib/assets";
import { Button } from "@/components/ui/Button";
import { Dropdown } from "@/components/ui/Dropdown";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { ChatBubble } from "@/components/ui/ChatBubble";
import { useTranslation } from "@/hooks/useTranslation";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import SliderVerticalIcon from "@iconify-react/boxicons/slider-vertical";
import SearchIcon from "@iconify-react/boxicons/search";
import DotsHorizontalRoundedIcon from "@iconify-react/boxicons/dots-horizontal-rounded";
import SidebarRightIcon from "@iconify-react/boxicons/sidebar-right";
import XIcon from "@iconify-react/boxicons/x";
import PaperclipIcon from "@iconify-react/boxicons/paperclip";

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

const EVERYONE_MENTION = "everyone";

// Kept outside the component (and free of React Compiler restrictions): the
// conditional expression inside a component-level try/catch would make the
// compiler skip the whole component.
const reportActionError = (error: unknown, fallback: string) => {
  console.error(error);
  alert(error instanceof Error ? error.message : fallback);
};

const formatFileSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

// Isolated so remote typing events (which fire on every peer keystroke) only
// re-render this one element instead of the whole conversation pane.
function TypingIndicator({ roomId }: { roomId: string }) {
  const typingUsers = useTypingUsers();
  const names = typingUsers[roomId] ?? [];
  if (names.length === 0) return null;
  const label =
    names.length === 1
      ? `${names[0]} is typing...`
      : `${names.slice(0, 2).join(", ")} are typing...`;
  return (
    <div className="px-3 md:px-6 py-1 text-xs text-text-muted italic select-none">
      {label}
    </div>
  );
}

interface ReadReceiptReader {
  name: string;
  displayName?: string;
  avatarUrl: string;
}

interface MessageRowProps {
  msg: Message;
  members?: { userId: string; name: string; role: string; nickname?: string; avatarUrl?: string }[];
  showUnreadMarker: boolean;
  isRead: boolean;
  readers?: ReadReceiptReader[];
  isRoomOwner: boolean;
  isRoomAdmin: boolean;
  currentUsername: string;
  currentUserAvatar: string;
  searchHighlight?: string;
  onReply: (msg: Message) => void;
  onEdit: (msg: Message) => void;
  onRecall: (msgId: string) => void;
}

/**
 * One message row (unread marker + bubble + read receipts + hover actions).
 *
 * Wrapped in React.memo with identity-stable callbacks from Chatroom so that
 * appending one message — or any unrelated Chatroom state change — only
 * renders the rows whose props actually changed, instead of the whole list
 * (hotspot #3, issue #383). Do not pass freshly-created objects/closures from
 * the parent, or the memo boundary silently stops working; the render-count
 * assertions in tests/chat-memoization.test.tsx guard this.
 */
const MessageRow = React.memo(function MessageRow({
  msg,
  members,
  showUnreadMarker,
  isRead,
  readers,
  isRoomOwner,
  isRoomAdmin,
  currentUsername,
  currentUserAvatar,
  searchHighlight,
  onReply,
  onEdit,
  onRecall,
}: MessageRowProps) {
  const { t } = useTranslation();

  const unreadMarker = showUnreadMarker ? (
    <div data-unread-marker="true" className="w-full flex items-center my-3 select-none">
      <div className="flex-1 border-t border-red-500/50"></div>
      <span className="px-3 text-red-500 text-xs font-semibold uppercase tracking-wider font-sans">
        {t("chatroom.newMessages")}
      </span>
      <div className="flex-1 border-t border-red-500/50"></div>
    </div>
  ) : null;

  if (msg.content.startsWith("[System] ")) {
    return (
      <>
        {unreadMarker}
        <div data-msg-id={msg.id} className="w-full flex justify-center my-2 select-none">
          <div className="bg-surface-card border border-border-secondary px-3 py-1 rounded-full text-xs text-text-muted">
            {msg.content.substring(9)}
          </div>
        </div>
      </>
    );
  }

  const senderMember = members?.find((m) => m.userId === msg.senderId);
  const displayName = senderMember?.nickname || msg.senderName;
  const isSenderOwnerOrAdmin = senderMember?.role === "owner" || senderMember?.role === "admin";
  const canAdminRecall = isRoomAdmin && !isSenderOwnerOrAdmin;
  const canRecall = Boolean(msg.isOutgoing) || isRoomOwner || canAdminRecall;

  return (
    <>
      {unreadMarker}
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
              ? currentUserAvatar
              : senderMember?.avatarUrl
              ? resolveAssetUrl(senderMember.avatarUrl)
              : undefined
          }
          isRead={isRead}
          senderId={msg.senderId || undefined}
          messageId={msg.id}
          onReply={() => onReply(msg)}
          onRecall={() => onRecall(msg.id)}
          onEdit={() => onEdit(msg)}
          canRecall={canRecall}
          canEdit={msg.isOutgoing && !msg.isRecalled}
          avatarName={
            msg.isOutgoing ? currentUsername : senderMember?.name || msg.senderName
          }
          searchHighlight={searchHighlight}
        />

        {/* Render read receipt avatars on the far right of the screen */}
        {readers && readers.length > 0 && (
          <div className="self-stretch flex gap-1 mt-1 justify-end px-0.5 select-none">
            {readers.map((reader, idx) => (
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
              onClick={() => onReply(msg)}
              className="hover:text-primary transition-colors cursor-pointer"
            >
              {t("chatroom.reply")}
            </button>
            {canRecall && (
              <button
                onClick={() => onRecall(msg.id)}
                className="hover:text-danger transition-colors cursor-pointer"
              >
                {t("chatroom.recall")}
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
});

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
    groupReadStates,
    markRoomAsRead,
  } = useChat();
  const { showRightPanel, setShowRightPanel } = useRightPanel();
  const realtimeReady = useRealtimeReady();

  const [inputText, setInputText] = useState("");
  const [mentionDraft, setMentionDraft] = useState<MentionDraft | null>(null);
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0);
  const [replyTarget, setReplyTarget] = useState<Message | null>(null);
  const [editingMessage, setEditingMessage] = useState<Message | null>(null);
  const [isModifyNickOpen, setIsModifyNickOpen] = useState(false);
  const [nickInputValue, setNickInputValue] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<File[]>([]);
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
  const handleToggleSearch = () => {
    if (isSearchOpen) {
      setIsSearchOpen(false);
      setMsgSearchQuery("");
    } else {
      setIsSearchOpen(true);
      requestAnimationFrame(() => searchInputRef.current?.focus());
    }
  };

  // Identity-stable callbacks for the memoized MessageRow list. Inline
  // closures here would invalidate every row's memo on each Chatroom render.
  const handleReplySelect = useCallback((msg: Message) => {
    setReplyTarget(msg);
  }, []);

  const handleEditSelect = useCallback((msg: Message) => {
    setEditingMessage(msg);
    setInputText(msg.content);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }, []);

  if (!activeRoom) {
    return (
      <div className="flex-1 flex items-center justify-center bg-background text-foreground font-sans">
        {t("chatroom.notFound")}
      </div>
    );
  }

  // ---- Derived message-list tables ----------------------------------------
  // Plain derivations (no useMemo): the React Compiler memoizes them against
  // their inputs now that this component compiles again (no try/finally).
  const roomMessages = messages.filter((m) => m.roomId === activeRoom.id);
  const normalizedSearchQuery = msgSearchQuery.trim().toLowerCase();
  const visibleMessages = normalizedSearchQuery
    ? roomMessages.filter(
        (m) =>
          !m.content.startsWith("[System] ") &&
          m.content.toLowerCase().includes(normalizedSearchQuery),
      )
    : roomMessages;

  // Read-receipt avatars, grouped once per read-state change instead of a
  // per-message scan over all members.
  const roomReads = groupReadStates[activeRoom.id];
  const readersByMessageId = new Map<string, ReadReceiptReader[]>();
  if (roomReads) {
    for (const [readerId, lastReadId] of Object.entries(roomReads)) {
      if (readerId === user.userId) continue;
      const member = activeRoom.members?.find((m) => m.userId === readerId);
      const reader: ReadReceiptReader = {
        name: member?.name ?? readerId,
        displayName: member?.nickname ?? member?.name ?? readerId,
        avatarUrl: member?.avatarUrl ?? "",
      };
      const readers = readersByMessageId.get(lastReadId);
      if (readers) {
        readers.push(reader);
      } else {
        readersByMessageId.set(lastReadId, [reader]);
      }
    }
  }

  // In private chats an outgoing message counts as read when it is at or
  // before the other member's last-read message.
  let otherLastReadIndex = -1;
  if (activeRoom.type === "msg") {
    const otherUserId =
      activeRoom.otherMemberId ||
      activeRoom.members?.find((m) => m.userId !== user.userId)?.userId;
    const otherLastReadId = otherUserId ? roomReads?.[otherUserId] : undefined;
    if (otherLastReadId) {
      otherLastReadIndex = roomMessages.findIndex((m) => m.id === otherLastReadId);
    }
  }
  const messageIndexById = new Map(roomMessages.map((m, i) => [m.id, i]));
  const rowIsRead = (msg: Message): boolean => {
    if (msg.isRead) return true;
    if (activeRoom.type !== "msg" || !msg.isOutgoing || otherLastReadIndex === -1) {
      return false;
    }
    const idx = messageIndexById.get(msg.id);
    return idx !== undefined && idx <= otherLastReadIndex;
  };

  const myMember = activeRoom.members?.find((m) => m.userId === user.userId);
  const isRoomOwnerForRecall = myMember?.role === "owner";
  const isRoomAdminForRecall = myMember?.role === "admin";

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
        reportActionError(error, "Failed to update message");
      }
      return;
    }

    // No `finally` here: a try/finally (or conditional expressions inside
    // try/catch) makes the React Compiler bail out of the entire component.
    try {
      if (pendingAttachments.length > 0) {
        setIsUploadingAttachment(true);
        await handleUploadAttachments(activeRoom.id, pendingAttachments, {
          content: inputText,
          replyTarget,
        });
        setPendingAttachments([]);
      } else {
        handleSendMessage(activeRoom.id, inputText, replyTarget);
      }

      handleTyping(activeRoom.id, false);
      setInputText("");
      setReplyTarget(null);
      setIsUploadingAttachment(false);
    } catch (error) {
      reportActionError(error, "Failed to send message");
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
    setPendingAttachments((prev) => [...prev, ...files]);
  };

  const handleRemovePendingAttachment = (index: number) => {
    if (isUploadingAttachment) return;
    setPendingAttachments((prev) => prev.filter((_, i) => i !== index));
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
    const nextNickname = trimmed || user.username;
    try {
      await handleModifyNickname(activeRoom.id, nextNickname);
    } catch (error) {
      reportActionError(error, "Failed to update nickname");
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
    <div
      className="flex-1 flex flex-col bg-background h-full overflow-hidden"
      // Room-level realtime readiness, the browser-observable contract the
      // full-stack lane waits on (issue #620). It joins the session-level fact
      // from `useRealtimeReady` to this room's own subscription status: the
      // server excludes `pending` members when restoring subscriptions
      // (socketServer.ts), so a pending room is rendered and its composer is
      // usable while its channel is not joined — ready for REST, not for
      // realtime.
      //
      // Pending is read from both sources because each is stale in a
      // different situation, and either one saying pending means this socket
      // is not in the room's channel. `myRole` arrives with the room summary,
      // so it is the only one available on first paint — but a live demotion
      // reaches the client as MEMBER_UPDATED, whose member reload rewrites
      // `activeRoom.members` and leaves `myRole` untouched. `currentMember`
      // is the mirror image: current across a role change, absent until the
      // members have loaded.
      //
      // Carries the room id rather than a boolean, so a waiter names the room
      // it means and cannot be satisfied by a previous room still mounted.
      // `undefined` and not `false` is load-bearing: React renders
      // `data-room-ready="false"` for a boolean, which `[data-room-ready]`
      // would still match.
      data-room-ready={
        realtimeReady && activeRoom.myRole !== "pending" && !isPending
          ? activeRoom.id
          : undefined
      }
    >
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
              <SliderVerticalIcon aria-hidden="true" className="h-3.5 w-3.5" />
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
            <SearchIcon aria-hidden="true" className="h-4 w-4" />
          </button>

          <Dropdown
            trigger={
              <button
                className="p-1.5 border border-border-secondary hover:border-border-primary rounded-sm text-text-muted hover:text-foreground transition-colors cursor-pointer"
                title={t("chatroom.chatOptions")}
              >
                <DotsHorizontalRoundedIcon aria-hidden="true" className="h-4 w-4" />
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
            <SidebarRightIcon aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Search Bar */}
      {isSearchOpen && (
        <div className="border-b border-border-primary bg-surface-card px-3 md:px-6 py-2 flex items-center gap-2 shrink-0">
          <SearchIcon aria-hidden="true" className="h-4 w-4 text-text-muted shrink-0" />
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
              {visibleMessages.length} 筆結果
            </span>
          )}
          <button
            type="button"
            onClick={handleToggleSearch}
            className="p-0.5 text-text-muted hover:text-foreground transition-colors cursor-pointer shrink-0"
          >
            <XIcon aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Chat Messages Area */}
      <div ref={scrollAreaRef} className="flex-1 overflow-y-auto p-3 md:p-6 flex flex-col gap-4">
        {visibleMessages.map((msg) => (
          <MessageRow
            key={msg.id}
            msg={msg}
            members={activeRoom.members}
            showUnreadMarker={currentRoomUnreadId === msg.id}
            isRead={rowIsRead(msg)}
            readers={readersByMessageId.get(msg.id)}
            isRoomOwner={isRoomOwnerForRecall}
            isRoomAdmin={isRoomAdminForRecall}
            currentUsername={user.username}
            currentUserAvatar={user.avatar}
            searchHighlight={msgSearchQuery.trim() || undefined}
            onReply={handleReplySelect}
            onEdit={handleEditSelect}
            onRecall={handleRecallMessage}
          />
        ))}
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
            <XIcon aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <TypingIndicator roomId={activeRoom.id} />

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
                  {pendingAttachments.map((file, idx) => (
                    <div key={idx} className="flex items-center gap-3 text-xs border-l-2 border-primary pl-2.5 py-0.5">
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
                <PaperclipIcon aria-hidden="true" className="h-4 w-4" />
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
