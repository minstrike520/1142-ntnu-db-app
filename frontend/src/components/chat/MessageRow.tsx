import React from "react";
import { ChatBubble } from "@/components/ui/ChatBubble";
import { useTranslation } from "@/hooks/useTranslation";
import { resolveAssetUrl } from "@/lib/assets";
import type { Message } from "@/context/ChatContext";

export interface ReadReceiptReader {
  name: string;
  displayName?: string;
  avatarUrl: string;
}

export interface MessageRowProps {
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
export const MessageRow = React.memo(function MessageRow({
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
