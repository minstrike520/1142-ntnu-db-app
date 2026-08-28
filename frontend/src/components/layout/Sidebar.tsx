"use client";

import React, { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useChat } from "@/context/ChatContext";
import { useLastViewedRoomId } from "@/context/RoomWorkspaceContext";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { useTranslation } from "@/hooks/useTranslation";
import ChatList from "./ChatList";
import FriendInfoPanel from "@/components/chat/FriendInfoPanel";
import MessageDetailIcon from "@iconify-react/boxicons/message-detail";
import GroupIcon from "@iconify-react/boxicons/group";
import AlertTriangleIcon from "@iconify-react/boxicons/alert-triangle";
import CogIcon from "@iconify-react/boxicons/cog";
import LogoutIcon from "@iconify-react/boxicons/arrow-out-left-square-half-filled";
import SearchIcon from "@iconify-react/boxicons/search";
import PlusIcon from "@iconify-react/boxicons/plus";
import UserIcon from "@iconify-react/boxicons/user";
import PlusSquareIcon from "@iconify-react/boxicons/plus-square";
import JoinGroupIcon from "@iconify-react/boxicons/arrow-down-stroke-square";
import FolderPlusIcon from "@iconify-react/boxicons/folder-plus";
import { resolveAssetUrl } from "@/lib/assets";

export default function Sidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const {
    rooms,
    folders,
    user,
    handleCreateRoom,
    handleCreateFolder,
    handleJoinByInviteCode,
    handleLogout,
    friendRequests,
    selectedFriendForSidebar,
    setSelectedFriendForSidebar,
    hasUnsavedChanges,
  } = useChat();
  const lastViewedRoomId = useLastViewedRoomId();

  const [searchQuery, setSearchQuery] = useState("");
  const isSettingsPage = pathname === "/settings";
  const isChatPage = pathname === "/" || pathname.startsWith("/chat");
  const [isActionsModalOpen, setIsActionsModalOpen] = useState(false);
  const [actionsView, setActionsView] = useState<"menu" | "createGroup" | "createFolder" | "joinGroup">("menu");
  const [joinInviteCode, setJoinInviteCode] = useState("");
  const [joinError, setJoinError] = useState("");
  const [newRoomName, setNewRoomName] = useState("");
  const [newRoomFolder, setNewRoomFolder] = useState("");
  const [newFolderName, setNewFolderName] = useState("");

  const { t } = useTranslation();

  const handleCreateRoomSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRoomName.trim()) return;

    try {
      // Force roomType to "group"
      const newId = await handleCreateRoom(newRoomName, "group", newRoomFolder);
      setNewRoomName("");
      setNewRoomFolder("");
      setIsActionsModalOpen(false);
      setActionsView("menu");

      if (newId) {
        router.push(`/chat/${newId}`);
      }
    } catch (error) {
      console.error(error);
      alert(error instanceof Error ? error.message : "Failed to create room");
    }
  };

  const handleCreateFolderSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newFolderName.trim()) return;

    try {
      await handleCreateFolder(newFolderName);
      setNewFolderName("");
      setIsActionsModalOpen(false);
      setActionsView("menu");
    } catch (error) {
      console.error(error);
      alert(error instanceof Error ? error.message : "Failed to create folder");
    }
  };



  const handleJoinRoomSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!joinInviteCode.trim()) return;
    setJoinError("");
    try {
      const newId = await handleJoinByInviteCode(joinInviteCode);
      setJoinInviteCode("");
      setIsActionsModalOpen(false);
      setActionsView("menu");
      router.push(`/chat/${newId}`);
    } catch (error) {
      setJoinError(error instanceof Error ? error.message : t("sidebar.joinFailed"));
    }
  };

  const pendingIncoming = friendRequests?.filter((request) => request.direction === "incoming").length || 0;
  const lastChat = rooms.find((room) => room.id === lastViewedRoomId);
  const chatPath = lastChat ? `/chat/${lastChat.id}` : rooms[0] ? `/chat/${rooms[0].id}` : "/";

  const menuItems = [
    {
      label: t("rail.chats"),
      active: pathname === "/" || pathname.startsWith("/chat"),
      onClick: () => router.push(chatPath),
      icon: <MessageDetailIcon aria-hidden="true" className="h-5 w-5 shrink-0" />,
    },
    {
      label: t("rail.friends"),
      active: pathname === "/friends",
      onClick: () => {
        setSelectedFriendForSidebar(null);
        router.push("/friends");
      },
      badge: pendingIncoming,
      icon: <GroupIcon aria-hidden="true" className="h-5 w-5 shrink-0" />,
    },
    {
      label: t("rail.emergency"),
      active: pathname === "/emergency",
      onClick: () => router.push("/emergency"),
      icon: <AlertTriangleIcon aria-hidden="true" className="h-5 w-5 shrink-0" />,
    },
    {
      label: t("sidebar.settings"),
      active: isSettingsPage,
      onClick: () => router.push("/settings"),
      icon: <CogIcon aria-hidden="true" className="h-5 w-5 shrink-0" />,
    },
    {
      label: t("sidebar.logout"),
      active: false,
      onClick: handleLogout,
      icon: <LogoutIcon aria-hidden="true" className="h-5 w-5 shrink-0" />,
    },
  ];

  return (
    <div 
      className="relative w-full md:w-[260px] lg:w-[300px] shrink-0 border-r border-border-primary bg-surface-card flex flex-col h-full"
      onClickCapture={(e) => {
        if (hasUnsavedChanges) {
          e.stopPropagation();
          e.preventDefault();
          window.dispatchEvent(new CustomEvent("trigger-unsaved-alert"));
        }
      }}
    >
      {isChatPage ? (
        <div className="h-14 border-b border-border-primary px-4 flex items-center justify-between select-none shrink-0 gap-2">
          {/* Search bar */}
          <div className="flex-1 relative">
            <span className="absolute inset-y-0 left-0 flex items-center pl-2 text-text-muted">
              <SearchIcon aria-hidden="true" className="h-3.5 w-3.5" />
            </span>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t("sidebar.searchChatsPlaceholder")}
              className="w-full bg-surface-muted border border-border-secondary hover:border-border-primary focus:border-primary focus:outline-none rounded-sm pl-7 pr-2 py-1.5 text-xs text-foreground transition-colors placeholder:text-text-muted/65"
            />
          </div>
          {/* Action buttons */}
          <div className="flex gap-1 shrink-0">
            <IconButton
              label={t("sidebar.actions")}
              icon={<PlusIcon aria-hidden="true" className="h-4 w-4" />}
              onClick={() => {
                setJoinInviteCode("");
                setJoinError("");
                setNewRoomName("");
                setNewRoomFolder("");
                setNewFolderName("");
                setActionsView("menu");
                setIsActionsModalOpen(true);
              }}
            />
          </div>
        </div>
      ) : pathname === "/friends" && selectedFriendForSidebar ? (
        <div className="h-14 border-b border-border-primary px-4 flex items-center justify-between select-none shrink-0 bg-surface-muted">
          <span className="text-[10px] font-bold text-text-muted uppercase tracking-widest block">
            {t("profileCard.friendInfo")}
          </span>
        </div>
      ) : (
        <div className="h-14 border-b border-border-primary px-4 flex items-center justify-between select-none shrink-0" />
      )}
 
      <div className="flex-1 overflow-y-auto select-none flex flex-col">
        {isChatPage ? (
          <ChatList searchQuery={searchQuery} />
        ) : pathname === "/friends" ? (
          selectedFriendForSidebar ? (
            <FriendInfoPanel
              userId={selectedFriendForSidebar.id}
              friendName={selectedFriendForSidebar.name}
              showChatButton={true}
              hideHeader={true}
            />
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-text-muted text-xs text-center p-4">
              <UserIcon aria-hidden="true" className="h-10 w-10 text-text-muted/30 mb-2" />
              <p>{t("profileCard.selectPrompt")}</p>
            </div>
          )
        ) : null}
      </div>

      <div className="border-t border-border-primary bg-surface-muted select-none shrink-0 flex flex-col">
        <div className="p-4 flex items-center gap-3">
          <Avatar name={user.username} src={user.avatar ? resolveAssetUrl(user.avatar) : undefined} size="sm" isOnline />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-bold text-foreground truncate leading-tight">{user.username}</p>
            <p className="text-[10px] text-text-muted truncate font-mono mt-0.5">{user.email}</p>
          </div>
        </div>
        <div className="hidden md:flex items-stretch border-t border-border-secondary/40 h-12 bg-surface-muted">
          {menuItems.map((item, idx) => (
            <div key={idx} className="relative group flex flex-col items-stretch flex-1">
              <button
                type="button"
                onClick={item.onClick}
                aria-label={item.label}
                className={`w-full h-full flex items-center justify-center transition-all duration-200 relative cursor-pointer ${
                  item.active
                    ? "text-primary bg-surface-card"
                    : "text-text-muted hover:text-foreground hover:bg-surface-card/60"
                }`}
              >
                {item.icon}
                {!!item.badge && (
                  <span className="absolute top-2 right-2 bg-red-500 text-white text-[9px] font-bold rounded-full h-4 min-w-4 flex items-center justify-center px-1">
                    {item.badge}
                  </span>
                )}
                {/* Bottom active indicator line */}
                {item.active && <span className="absolute left-0 right-0 bottom-0 h-[3px] bg-primary" />}
              </button>
              {/* Tooltip */}
              <div className="pointer-events-none absolute bottom-full mb-2.5 left-1/2 -translate-x-1/2 scale-90 opacity-0 group-hover:scale-100 group-hover:opacity-100 transition-all duration-150 bg-slate-950 text-white text-[10px] font-semibold px-2 py-1 rounded shadow-lg whitespace-nowrap z-50">
                {item.label}
                <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-slate-950" />
              </div>
            </div>
          ))}
        </div>
      </div>

      <Modal
        isOpen={isActionsModalOpen}
        onClose={() => {
          setIsActionsModalOpen(false);
          setActionsView("menu");
        }}
        title={
          actionsView === "menu"
            ? t("sidebar.actions")
            : actionsView === "createGroup"
            ? t("sidebar.createGroup")
            : actionsView === "createFolder"
            ? t("sidebar.createFolder")
            : t("sidebar.joinGroup")
        }
      >
        {actionsView === "menu" && (
          <div className="border border-border-primary rounded-sm bg-surface-card overflow-hidden flex flex-col">
            {/* Create Group Card */}
            <button
              type="button"
              onClick={() => {
                setNewRoomName("");
                setNewRoomFolder("");
                setActionsView("createGroup");
              }}
              className="flex items-center gap-4 p-4 border-b border-border-primary hover:bg-surface-muted transition-all cursor-pointer text-left w-full group select-none rounded-none"
            >
              <PlusSquareIcon aria-hidden="true" className="h-6 w-6 text-text-muted group-hover:text-primary transition-colors shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold text-foreground leading-snug">{t("sidebar.createGroup")}</p>
                <p className="text-xs text-text-muted mt-1 leading-normal">{t("sidebar.createGroupDesc")}</p>
              </div>
            </button>

            {/* Join Group Card */}
            <button
              type="button"
              onClick={() => {
                setJoinInviteCode("");
                setJoinError("");
                setActionsView("joinGroup");
              }}
              className="flex items-center gap-4 p-4 border-b border-border-primary hover:bg-surface-muted transition-all cursor-pointer text-left w-full group select-none rounded-none"
            >
              <JoinGroupIcon aria-hidden="true" className="h-6 w-6 text-text-muted group-hover:text-primary transition-colors shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold text-foreground leading-snug">{t("sidebar.joinGroup")}</p>
                <p className="text-xs text-text-muted mt-1 leading-normal">{t("sidebar.joinGroupDesc")}</p>
              </div>
            </button>

            {/* Create Folder Card */}
            <button
              type="button"
              onClick={() => {
                setNewFolderName("");
                setActionsView("createFolder");
              }}
              className="flex items-center gap-4 p-4 hover:bg-surface-muted transition-all cursor-pointer text-left w-full group select-none rounded-none"
            >
              <FolderPlusIcon aria-hidden="true" className="h-6 w-6 text-text-muted group-hover:text-primary transition-colors shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold text-foreground leading-snug">{t("sidebar.createFolder")}</p>
                <p className="text-xs text-text-muted mt-1 leading-normal">{t("sidebar.createFolderDesc")}</p>
              </div>
            </button>
          </div>
        )}

        {actionsView === "createGroup" && (
          <form onSubmit={handleCreateRoomSubmit} className="flex flex-col gap-5">
            <Input
              label={t("sidebar.chatName")}
              value={newRoomName}
              onChange={(event) => setNewRoomName(event.target.value)}
              required
              placeholder={t("sidebar.chatNamePlaceholder")}
            />
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-bold uppercase tracking-wider text-text-muted">{t("sidebar.folder")}</span>
              <select
                value={newRoomFolder}
                onChange={(event) => setNewRoomFolder(event.target.value)}
                className="bg-surface-card border border-border-secondary hover:border-border-primary focus:border-primary focus:outline-none rounded-sm px-3 py-2.5 text-sm text-foreground transition-colors"
              >
                <option value="">{t("sidebar.rootChats")}</option>
                {folders.map((folder) => (
                  <option key={folder.id} value={folder.id}>
                    {folder.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="border-t border-border-primary pt-5 flex items-center justify-end gap-3">
              <Button type="button" variant="secondary" onClick={() => setActionsView("menu")}>
                {t("sidebar.back")}
              </Button>
              <Button type="submit" variant="primary">
                {t("sidebar.create")}
              </Button>
            </div>
          </form>
        )}

        {actionsView === "createFolder" && (
          <form onSubmit={handleCreateFolderSubmit} className="flex flex-col gap-5">
            <Input
              label={t("sidebar.folderName")}
              value={newFolderName}
              onChange={(event) => setNewFolderName(event.target.value)}
              required
              placeholder={t("sidebar.folderNamePlaceholder")}
            />
            <div className="border-t border-border-primary pt-5 flex items-center justify-end gap-3">
              <Button type="button" variant="secondary" onClick={() => setActionsView("menu")}>
                {t("sidebar.back")}
              </Button>
              <Button type="submit" variant="primary">
                {t("sidebar.create")}
              </Button>
            </div>
          </form>
        )}

        {actionsView === "joinGroup" && (
          <form onSubmit={handleJoinRoomSubmit} className="flex flex-col gap-5">
            <Input
              label={t("sidebar.inviteCode")}
              value={joinInviteCode}
              onChange={(e) => setJoinInviteCode(e.target.value)}
              required
              placeholder={t("sidebar.inviteCodePlaceholder")}
            />
            {joinError && <p className="text-xs text-red-600">{joinError}</p>}
            <div className="border-t border-border-primary pt-5 flex items-center justify-end gap-3">
              <Button type="button" variant="secondary" onClick={() => setActionsView("menu")}>
                {t("sidebar.back")}
              </Button>
              <Button type="submit" variant="primary">
                {t("sidebar.join")}
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}

function IconButton({
  label,
  onClick,
  icon,
}: {
  label: string;
  onClick: () => void;
  icon: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className="p-1 text-text-muted hover:text-foreground border border-transparent hover:border-border-primary rounded-sm transition-colors cursor-pointer flex items-center justify-center shrink-0"
    >
      {icon}
    </button>
  );
}
