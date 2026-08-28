"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import dynamic from "next/dynamic";
import { useChat, useRightPanel } from "@/context/ChatContext";
import { useTranslation } from "@/hooks/useTranslation";
import Chatroom from "@/components/chat/Chatroom";
import RoomMembersPanel from "@/components/chat/RoomMembersPanel";
import FriendInfoPanel from "@/components/chat/FriendInfoPanel";

// GroupSettings starts hidden and most sessions never open it, so it is
// loaded on demand to keep it out of the chat route's initial client chunk.
// RoomMembersPanel renders in the default group-chat view and FriendInfoPanel
// is statically imported by the persistent Sidebar, so lazy-loading them here
// would not reduce the initial bundle.
const GroupSettings = dynamic(() => import("@/components/settings/GroupSettings"), {
  ssr: false,
  loading: () => <GroupSettingsLoading />,
});

function GroupSettingsLoading() {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex-1 flex items-center justify-center bg-background h-full text-text-muted font-sans"
    >
      {t("common.loading")}
    </div>
  );
}

export default function ChatroomPageContent() {
  const params = useParams();
  const { rooms, user } = useChat();
  const { showRightPanel, setShowRightPanel } = useRightPanel();
  const [showSettings, setShowSettings] = useState(false);

  const chatId = params?.chatId as string;
  const activeRoom = rooms.find((room) => room.id === chatId);

  useEffect(() => {
    if (activeRoom) {
      document.title = `Near | ${activeRoom.name}`;
    }
  }, [activeRoom]);

  // Reset the settings view when switching rooms (adjust state during render).
  const [prevChatId, setPrevChatId] = useState(chatId);
  if (prevChatId !== chatId) {
    setPrevChatId(chatId);
    setShowSettings(false);
  }

  if (!activeRoom) {
    return (
      <div className="flex-1 flex items-center justify-center bg-background text-foreground font-sans">
        找不到此聊天室
      </div>
    );
  }

  // Find the other member in a private (msg) chatroom
  const otherMember = activeRoom.type === "msg"
    ? activeRoom.members?.find((m) => m.userId !== user.userId)
    : undefined;

  const rightPanel =
    activeRoom.type === "group" && activeRoom.members ? (
      <RoomMembersPanel room={activeRoom} members={activeRoom.members} />
    ) : activeRoom.type === "msg" ? (
      <div className="w-[280px] max-w-[85vw] lg:w-[240px] shrink-0 border-l border-border-primary bg-surface-card h-full">
        <FriendInfoPanel userId={otherMember?.userId} friendName={activeRoom.name} />
      </div>
    ) : null;

  return (
    <div className="relative flex-1 flex h-full overflow-hidden">
      {showSettings ? (
        <GroupSettings roomId={activeRoom.id} onClose={() => setShowSettings(false)} />
      ) : (
        <Chatroom
          roomId={activeRoom.id}
          onOpenGroupSettings={activeRoom.type === "group" ? () => setShowSettings(true) : undefined}
        />
      )}

      {showRightPanel && rightPanel && (
        <>
          {/* Below lg the panel floats over the conversation as a drawer. */}
          <div
            className="fixed inset-0 z-30 bg-black/50 lg:hidden animate-fade-in"
            onClick={() => setShowRightPanel(false)}
            aria-hidden
          />
          <div className="absolute inset-y-0 right-0 z-40 flex h-full lg:relative lg:z-20 animate-slide-in-right lg:animate-none">
            {rightPanel}
          </div>
        </>
      )}
    </div>
  );
}
