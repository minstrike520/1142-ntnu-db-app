"use client";

import React, { useState } from "react";
import { ChatRoom, Member, useProfilePopover } from "@/context/ChatContext";
import { Avatar } from "@/components/ui/Avatar";
import ProfilePopover from "./ProfilePopover";
import { useTranslation } from "@/hooks/useTranslation";
import { resolveAssetUrl } from "@/lib/assets";

export default function RoomMembersPanel({
  members,
  hideHeader = false,
}: {
  room: ChatRoom;
  members: Member[];
  hideHeader?: boolean;
}) {
  const { activeProfilePopover, setActiveProfilePopover } = useProfilePopover();
  const [selectedMember, setSelectedMember] = useState<Member | null>(null);
  const [popoverTop, setPopoverTop] = useState<number>(0);
  const { t } = useTranslation();

  // Reset selectedMember during render if popover is closed or doesn't match
  const isPopoverMatch = activeProfilePopover && activeProfilePopover.instanceId === `member-${selectedMember?.userId}`;
  if (selectedMember && !isPopoverMatch) {
    setSelectedMember(null);
  }

  return (
    <div className="members-panel-root w-[280px] max-w-[85vw] lg:w-[240px] shrink-0 border-l border-border-primary bg-surface-card flex flex-col h-full select-none relative">
      {!hideHeader && (
        <div className="h-14 border-b border-border-primary px-4 flex items-center select-none shrink-0 bg-surface-muted">
          <span className="text-[10px] font-bold text-text-muted uppercase tracking-widest block">
            {t("chatroom.membersList", { count: members.length })}
          </span>
        </div>
      )}

      <div className="flex-1 overflow-y-auto divide-y divide-border-secondary/30">
        {members.map((member, index) => {
          let displayNick = member.name;
          if (member.nickname) {
            displayNick = `${member.nickname} (${member.name})`;
          }
          return (
            <div
              key={`${member.userId}-${index}`}
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const parentEl = e.currentTarget.closest(".members-panel-root");
                if (parentEl) {
                  const parentRect = parentEl.getBoundingClientRect();
                  const halfPopover = 200; // Half of estimated popover height (400px)
                  const padding = 12;      // Top/bottom margins
                  let topVal = rect.top - parentRect.top + rect.height / 2;

                  if (parentRect.height <= (halfPopover * 2 + padding * 2)) {
                    topVal = parentRect.height / 2;
                  } else {
                    if (topVal - halfPopover < padding) {
                      topVal = halfPopover + padding;
                    } else if (topVal + halfPopover > parentRect.height - padding) {
                      topVal = parentRect.height - halfPopover - padding;
                    }
                  }
                  setPopoverTop(topVal);
                }
                const instanceId = `member-${member.userId}`;
                if (activeProfilePopover?.instanceId === instanceId) {
                  setActiveProfilePopover(null);
                } else {
                  setSelectedMember(member);
                  setActiveProfilePopover({ instanceId, userId: member.userId });
                }
              }}
              className="p-3.5 flex items-center justify-between hover:bg-surface-muted/50 transition-colors cursor-pointer relative avatar-click-target"
            >
              <div className="flex items-center gap-3 min-w-0">
                <Avatar name={member.name} src={member.avatarUrl ? resolveAssetUrl(member.avatarUrl) : undefined} size="sm" />
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-foreground truncate">{displayNick}</p>
                  <p className="text-[9px] text-text-muted capitalize mt-0.5 font-mono">{member.role}</p>
                </div>
              </div>
              {member.isMuted && <MutedIcon />}
            </div>
          );
        })}
      </div>

      {selectedMember && (
        <ProfilePopover
          userId={selectedMember.userId}
          username={selectedMember.name}
          nickname={selectedMember.nickname}
          onClose={(e) => {
            e.stopPropagation();
            setActiveProfilePopover(null);
          }}
          position="custom"
          className="absolute right-full mr-3 -translate-y-1/2"
          style={{ top: `${popoverTop}px` }}
        />
      )}
    </div>
  );
}

function MutedIcon() {
  const { t } = useTranslation();
  return (
    <span title={t("chatroom.muted")} className="text-red-500 scale-90">
      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
        <path strokeLinecap="round" strokeLinejoin="round" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
      </svg>
    </span>
  );
}
