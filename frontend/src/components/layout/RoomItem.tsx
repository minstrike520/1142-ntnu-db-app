"use client";

import React from "react";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { useTranslation } from "@/hooks/useTranslation";
import type { ChatRoom } from "@/context/ChatContext";

export function SectionLabel({ label }: { label: string }) {
  return (
    <span className="px-4 pt-4 pb-1 text-[10px] font-bold text-text-muted uppercase tracking-widest block">
      {label}
    </span>
  );
}

export interface RoomItemProps {
  room: ChatRoom;
  isActive: boolean;
  isDropTarget?: boolean;
  dropPlacement?: "above" | "below" | null;
  onClick: () => void;
  onDragStart?: (event: React.DragEvent<HTMLButtonElement>) => void;
  onDragEnd?: () => void;
  onDragOver?: (event: React.DragEvent<HTMLDivElement>) => void;
  onDrop?: (event: React.DragEvent<HTMLDivElement>) => void;
  avatarSrc?: string;
  noMessagesText: string;
  isPending?: boolean;
  draggable?: boolean;
}

export function RoomItem({
  room,
  isActive,
  isDropTarget,
  dropPlacement,
  onClick,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  avatarSrc,
  noMessagesText,
  isPending,
  draggable = true,
}: RoomItemProps) {
  const { t } = useTranslation();

  return (
    <div
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={`group relative flex w-full items-center gap-2.5 px-4 py-2.5 transition-all ${
        isActive ? "bg-surface-muted" : "hover:bg-surface-muted/70"
      } ${isDropTarget ? "bg-primary/5" : ""}`}
    >
      {isDropTarget && dropPlacement && (
        <div
          className={`absolute left-0 right-0 h-[3px] bg-primary z-20 pointer-events-none ${
            dropPlacement === "above" ? "top-0" : "bottom-0"
          }`}
        />
      )}
      {isActive && <span className="absolute left-0 top-0 bottom-0 w-1 bg-primary" />}
      <button
        type="button"
        onClick={onClick}
        draggable={draggable}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left select-none cursor-pointer"
      >
        <Avatar name={room.name} src={avatarSrc} size="sm" isOnline={room.isOnline} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 min-w-0 flex-1">
              <span className="text-xs font-semibold text-foreground truncate">{room.name}</span>
              {isPending && (
                <span className="text-[9px] font-bold text-amber-500 px-1.5 py-0.5 border border-amber-500/20 bg-amber-500/5 rounded-sm shrink-0 uppercase tracking-wide">
                  {t("chatroom.pendingApproval")}
                </span>
              )}
            </span>
            <span className="text-[9px] text-text-muted font-mono shrink-0">{room.lastMessageAt}</span>
          </span>
          <span className="mt-0.5 flex items-center gap-2">
            <span className="text-[10px] text-text-muted truncate flex-1">
              {isPending ? t("chatroom.pendingApproval") : (room.lastMessagePreview || noMessagesText)}
            </span>
            {room.unreadCount ? <Badge variant="danger">{room.unreadCount}</Badge> : null}
          </span>
        </span>
      </button>
      <Badge variant="default" className="scale-75 font-mono">
        {room.type === "group" ? "G" : "DM"}
      </Badge>
    </div>
  );
}
