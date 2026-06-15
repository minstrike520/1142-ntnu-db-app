"use client";

import React, { useRef, useEffect, useState } from "react";
import { useChat } from "@/context/ChatContext";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { useRouter } from "next/navigation";
import { useTranslation } from "@/hooks/useTranslation";
import { getUserProfile } from "@/lib/api";
import type { UserProfile } from "@shared/types";
import { resolveAssetUrl } from "@/lib/assets";

interface ProfilePopoverProps {
  userId: string;
  username: string;
  nickname?: string;
  onClose: (e: React.MouseEvent) => void;
  position?: "left" | "right" | "bottom" | "custom";
  style?: React.CSSProperties;
  className?: string;
}

export default function ProfilePopover({
  userId,
  username,
  nickname,
  onClose,
  position = "right",
  style,
  className,
}: ProfilePopoverProps) {
  const {
    user,
    friends,
    friendRequests,
    rooms,
    handleOpenPrivateRoom,
    emergencySettings,
    saveEmergencySettings,
    sendFriendRequestById,
  } = useChat();
  const router = useRouter();
  const popoverRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [addFriendStatus, setAddFriendStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");

  const handleCopyUid = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(userId)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch((err) => {
        console.error("Failed to copy UID:", err);
      });
  };

  // Close popover if clicked outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        const target = event.target as HTMLElement;
        if (target.closest(".avatar-click-target")) {
          return;
        }
        onClose(event as unknown as React.MouseEvent);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [onClose]);

  const isSelf = userId === user.userId;
  const [prevUserId, setPrevUserId] = useState(userId);
  if (prevUserId !== userId) {
    setPrevUserId(userId);
    setProfile(null);
    setLoading(!isSelf);
  }

  // Fetch user profile on mount / userId change
  useEffect(() => {
    if (userId === user.userId) {
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

  const friend = friends.find((f) => f.id === userId);

  const currentProfile = isSelf ? {
    userId: user.userId || "",
    name: user.username,
    bio: user.bio || "",
    avatarUrl: user.avatar || "",
  } : profile;

  const displayName = currentProfile?.name ?? username;
  const displayAvatar = currentProfile?.avatarUrl ? resolveAssetUrl(currentProfile.avatarUrl) : undefined;
  const status = isSelf ? "online" : friend ? friend.status : "offline";
  const bio = isSelf
    ? user.bio || t("profileCard.defaultBio")
    : profile?.bio || t("profileCard.defaultBio");

  const isEmergency = friend ? emergencySettings.contacts.some((c) => c.contactId === friend.id) : false;
  const hasPendingRequest =
    addFriendStatus === "sent" ||
    friendRequests.some((r) => r.id === userId && r.direction === "outgoing");

  const handleAddFriend = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (addFriendStatus !== "idle") return;
    setAddFriendStatus("sending");
    try {
      await sendFriendRequestById(userId, profile?.name ?? username);
      setAddFriendStatus("sent");
    } catch {
      setAddFriendStatus("error");
      setTimeout(() => setAddFriendStatus("idle"), 3000);
    }
  };

  const handleToggleEmergency = (e: React.MouseEvent) => {
    e.stopPropagation();
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

  const handleSendMessage = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isSelf) return;

    const existingRoom = rooms.find(
      (r) => r.type === "msg" && (r.members?.some((m) => m.userId === userId) || r.name === username)
    );

    if (existingRoom && !existingRoom.isArchived) {
      router.push(`/chat/${existingRoom.id}`);
    } else {
      const targetId = friend?.id ?? userId;
      const newId = await handleOpenPrivateRoom(targetId);
      router.push(`/chat/${newId}`);
    }
    onClose(e);
  };

  const positionClasses = {
    left: "absolute right-full top-1/2 -translate-y-1/2 mr-3",
    right: "absolute left-full top-0 ml-3",
    bottom: "absolute left-0 top-full mt-2",
    custom: "",
  };

  return (
    <div
      ref={popoverRef}
      onClick={(e) => e.stopPropagation()}
      style={style}
      className={`${positionClasses[position]} ${className || ""} z-[100] w-[240px] bg-surface-card/95 border border-border-primary rounded-sm shadow-xl p-4 text-left select-none text-foreground backdrop-blur-md transition-all duration-150`}
    >
      <div className="flex justify-between items-start mb-2">
        <span className="text-[9px] font-bold text-text-muted uppercase tracking-widest">
          {isSelf ? t("profileCard.myInfo") : friend ? t("profileCard.friendInfo") : t("profileCard.memberInfo")}
        </span>
        {!isSelf && !friend && (
          <span className="text-[8px] font-bold text-amber-500 uppercase tracking-widest border border-amber-500/30 bg-amber-500/10 px-1 py-0.5 shrink-0">
            {t("profileCard.notFriend")}
          </span>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-6 text-xs text-text-muted">
          Loading...
        </div>
      ) : (
        <>
          <div className="flex flex-col items-center text-center gap-2 py-2">
            <Avatar name={displayName} src={displayAvatar} size="md" isOnline={status === "online"} />
            <div className="min-w-0 w-full">
              <h4 className="text-xs font-bold text-foreground truncate">
                {nickname && nickname !== displayName ? `${displayName} (${nickname})` : displayName}
              </h4>
              <div className="relative inline-block mt-0.5 max-w-full">
                <p
                  onClick={handleCopyUid}
                  title="Click to copy UID"
                  className="text-[9px] text-text-muted font-mono truncate cursor-pointer hover:text-foreground hover:underline transition-colors"
                >
                  {userId}
                </p>
                {copied && (
                  <span className="absolute left-1/2 bottom-full -translate-x-1/2 mb-1 z-[110] px-1.5 py-0.5 text-[8px] font-bold text-white bg-zinc-800 border border-zinc-700 rounded shadow-md whitespace-nowrap">
                    Copied!
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="space-y-3 pt-2 border-t border-border-secondary/40 text-xs">
            <div>
              <span className="text-[9px] font-bold text-text-muted uppercase tracking-widest block mb-0.5">
                {t("profileCard.status")}
              </span>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className={`h-2.5 w-2.5 border border-border-primary ${status === "online" ? "bg-green-500" : "bg-zinc-500"}`} />
                <span className="text-[11px] text-foreground leading-none">{t(`common.${status}`)}</span>
              </div>
            </div>

            <div>
              <span className="text-[9px] font-bold text-text-muted uppercase tracking-widest block mb-0.5">
                {t("profileCard.bio")}
              </span>
              <p className="text-[11px] text-text-muted leading-relaxed whitespace-pre-wrap break-words">{bio}</p>
            </div>

            {friend && (
              <div className="flex items-center justify-between border-t border-border-secondary/40 pt-2.5 mt-1">
                <span className="text-[11px] font-semibold text-foreground">{t("profileCard.setEmergency")}</span>
                <button
                  onClick={handleToggleEmergency}
                  type="button"
                  className={`relative inline-flex h-4 w-8 shrink-0 cursor-pointer rounded-full border border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                    isEmergency ? "bg-primary" : "bg-zinc-600"
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                      isEmergency ? "translate-x-3.5" : "translate-x-0"
                    }`}
                  />
                </button>
              </div>
            )}
          </div>

          {!isSelf && (
            <Button onClick={handleSendMessage} variant="primary" className="w-full mt-3 text-[11px] py-1.5 font-bold">
              {t("profileCard.sendMessage")}
            </Button>
          )}
          {!isSelf && !friend && (
            <Button
              onClick={handleAddFriend}
              variant="secondary"
              className="w-full mt-2 text-[11px] py-1.5"
              disabled={addFriendStatus === "sending" || hasPendingRequest}
            >
              {hasPendingRequest
                ? t("profileCard.friendRequestSent")
                : addFriendStatus === "error"
                  ? t("profileCard.sendFriendRequest")
                  : t("profileCard.sendFriendRequest")}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
