"use client";

import React, { useEffect, useState } from "react";
import { useChat } from "@/context/ChatContext";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { useRouter } from "next/navigation";
import { useTranslation } from "@/hooks/useTranslation";
import { getUserProfile } from "@/lib/api";
import type { UserProfile } from "@shared/types";
import { resolveAssetUrl } from "@/lib/assets";

interface FriendInfoPanelProps {
  userId?: string;
  friendName: string;
  onClose?: () => void;
  showChatButton?: boolean;
  hideHeader?: boolean;
}

export default function FriendInfoPanel({
  userId,
  friendName,
  onClose,
  showChatButton = false,
  hideHeader = false,
}: FriendInfoPanelProps) {
  const { user, friends, friendRequests, emergencySettings, saveEmergencySettings, rooms, handleOpenPrivateRoom, sendFriendRequestById } = useChat();
  const router = useRouter();
  const { t } = useTranslation();

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [addFriendStatus, setAddFriendStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");

  const isSelf = userId === user.userId;
  const [prevUserId, setPrevUserId] = useState(userId);
  if (prevUserId !== userId) {
    setPrevUserId(userId);
    setProfile(null);
    setLoading(!isSelf && !!userId);
  }

  const handleCopyUid = (e: React.MouseEvent) => {
    e.stopPropagation();
    const uidToCopy = userId || friends.find((f) => f.name === friendName)?.id;
    if (!uidToCopy) return;
    navigator.clipboard.writeText(uidToCopy)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch((err) => {
        console.error("Failed to copy UID:", err);
      });
  };

  // Fetch user profile if userId is provided
  useEffect(() => {
    if (!userId || userId === user.userId) {
      return;
    }

    let active = true;
    getUserProfile(userId)
      .then((res) => {
        if (active) setProfile(res);
      })
      .catch((err) => {
        console.error("Failed to load user profile:", err);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [userId, user.userId]);

  // Fallback resolving
  const targetId = userId ?? friends.find((f) => f.name === friendName)?.id;
  const friend = targetId ? friends.find((f) => f.id === targetId) : undefined;

  const currentProfile = isSelf ? {
    userId: user.userId || "",
    name: user.username,
    bio: user.bio || "",
    avatarUrl: user.avatar || "",
  } : profile;

  const displayName = currentProfile?.name ?? friendName;
  const avatar = currentProfile?.avatarUrl ? resolveAssetUrl(currentProfile.avatarUrl) : undefined;
  const status = friend ? friend.status : "offline";
  const bio = currentProfile?.bio || t("profileCard.defaultBio");

  const isEmergency = friend ? emergencySettings.contacts.some((c) => c.contactId === friend.id) : false;
  const hasPendingRequest =
    addFriendStatus === "sent" ||
    (targetId ? friendRequests.some((r) => r.id === targetId && r.direction === "outgoing") : false);

  const handleAddFriend = async () => {
    if (!targetId || addFriendStatus !== "idle") return;
    setAddFriendStatus("sending");
    try {
      await sendFriendRequestById(targetId, profile?.name ?? friendName);
      setAddFriendStatus("sent");
    } catch {
      setAddFriendStatus("error");
      setTimeout(() => setAddFriendStatus("idle"), 3000);
    }
  };

  const handleToggleEmergency = () => {
    if (!friend) return;

    if (isEmergency) {
      void saveEmergencySettings({
        ...emergencySettings,
        contacts: emergencySettings.contacts.filter((c) => c.contactId !== friend.id),
      }).catch(console.error);
    } else {
      void saveEmergencySettings({
        ...emergencySettings,
        contacts: [
          ...emergencySettings.contacts,
          {
            id: `ec-${Date.now()}`,
            contactId: friend.id,
            name: friend.name,
            email: friend.email,
            message: t("emergency.defaultMessage"),
          },
        ],
      }).catch(console.error);
    }
  };

  const handleSendMessage = async () => {
    const activeUserId = targetId ?? "";
    if (!activeUserId) return;

    const existingRoom = rooms.find(
      (r) => r.type === "msg" && (r.members?.some((m) => m.userId === activeUserId) || r.name === displayName)
    );

    if (existingRoom && !existingRoom.isArchived) {
      router.push(`/chat/${existingRoom.id}`);
    } else {
      const newId = await handleOpenPrivateRoom(activeUserId);
      router.push(`/chat/${newId}`);
    }
  };

  return (
    <div className="w-full flex flex-col h-full select-none bg-surface-card">
      {!hideHeader && (
        <div className="h-14 border-b border-border-primary px-4 flex items-center justify-between select-none shrink-0 bg-surface-muted">
          <span className="text-[10px] font-bold text-text-muted uppercase tracking-widest block">
            {friend ? t("profileCard.friendInfo") : t("profileCard.memberInfo")}
          </span>
          {!isSelf && !friend && (
            <span className="text-[8px] font-bold text-amber-500 uppercase tracking-widest border border-amber-500/30 bg-amber-500/10 px-1 py-0.5 mr-2">
              {t("profileCard.notFriend")}
            </span>
          )}
          {onClose && (
            <button
              onClick={onClose}
              className="text-text-muted hover:text-foreground cursor-pointer p-1 hover:bg-surface-card/60 rounded-sm transition-colors"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      )}

      {loading ? (
        <div className="flex-1 flex items-center justify-center text-xs text-text-muted">
          Loading...
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-5">
          <div className="flex flex-col items-center text-center gap-3 py-2 border-b border-border-secondary/40 pb-5">
            <Avatar name={displayName} src={avatar} size="lg" isOnline={status === "online"} />
            <div className="min-w-0 w-full">
              <h4 className="text-sm font-bold text-foreground truncate">{displayName}</h4>
              {targetId && (
                <div className="relative inline-block mt-1 max-w-full">
                  <p
                    onClick={handleCopyUid}
                    title="Click to copy UID"
                    className="text-[10px] text-text-muted font-mono truncate cursor-pointer hover:text-foreground hover:underline transition-colors"
                  >
                    {targetId}
                  </p>
                  {copied && (
                    <span className="absolute left-1/2 bottom-full -translate-x-1/2 mb-1 z-10 px-2 py-0.5 text-[9px] font-bold text-white bg-zinc-800 border border-zinc-700 rounded shadow-md whitespace-nowrap">
                      Copied!
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="space-y-4 text-xs">
            <div>
              <span className="text-[10px] font-bold text-text-muted uppercase tracking-widest block mb-1">
                {t("profileCard.status")}
              </span>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className={`h-2.5 w-2.5 border border-border-primary ${status === "online" ? "bg-green-500" : "bg-zinc-500"}`} style={{ borderRadius: "0px" }} />
                <span className="text-xs text-foreground">{t(`common.${status}`)}</span>
              </div>
            </div>

            <div>
              <span className="text-[10px] font-bold text-text-muted uppercase tracking-widest block mb-1">
                {t("profileCard.bio")}
              </span>
              <p className="text-text-muted leading-relaxed whitespace-pre-wrap break-words">
                {bio}
              </p>
            </div>

            {friend && (
              <div className="flex items-center justify-between border-t border-border-secondary/40 pt-4 mt-2">
                <span className="text-xs font-semibold text-foreground">{t("profileCard.setEmergency")}</span>
                <button
                  onClick={handleToggleEmergency}
                  className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                    isEmergency ? "bg-primary" : "bg-zinc-600"
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                      isEmergency ? "translate-x-4" : "translate-x-0"
                    }`}
                  />
                </button>
              </div>
            )}
          </div>

          {showChatButton && !isSelf && (
            <Button onClick={handleSendMessage} variant="primary" className="w-full mt-2 text-xs py-2 font-bold select-none">
              {t("profileCard.sendMessage")}
            </Button>
          )}
          {!isSelf && !friend && targetId && (
            <Button
              onClick={handleAddFriend}
              variant="secondary"
              className="w-full mt-2 text-xs py-2 select-none"
              disabled={addFriendStatus === "sending" || hasPendingRequest}
            >
              {hasPendingRequest ? t("profileCard.friendRequestSent") : t("profileCard.sendFriendRequest")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
