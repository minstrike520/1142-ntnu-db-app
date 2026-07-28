"use client";

import React from "react";
import { useParams, usePathname, useRouter } from "next/navigation";
import { ChatRoom, getAvatarForUser, useChat } from "@/context/ChatContext";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { useTranslation } from "@/hooks/useTranslation";
import { resolveAssetUrl } from "@/lib/assets";

interface ChatListProps {
  searchQuery: string;
}

type FilterMode = "all" | "dm" | "group" | "unread";
type SortMode = "custom" | "unread";

export default function ChatList({ searchQuery }: ChatListProps) {
  const router = useRouter();
  const params = useParams();
  const pathname = usePathname();
  const {
    rooms,
    folders,
    user,
    friends,
    toggleFolder,
    handleDeleteFolder,
    handleRenameFolder,
    handleCategorizeRoom,
    updateRoomSorting,
    handleLeaveOrBlock,
    setRoomHidden,
  } = useChat();

  const activeRoomId = params?.chatId as string | undefined;
  const isChatPage = pathname === "/" || pathname.startsWith("/chat");
  const { t } = useTranslation();

  const [draggedRoomId, setDraggedRoomId] = React.useState<string | null>(null);
  const [dragOverFolderId, setDragOverFolderId] = React.useState<string | null>(null);
  const [dragOverUncategorized, setDragOverUncategorized] = React.useState(false);
  const [isRootDropActive, setIsRootDropActive] = React.useState(false);
  const [isUncategorizedCollapsed, setIsUncategorizedCollapsed] = React.useState(false);
  const [isHiddenCollapsed, setIsHiddenCollapsed] = React.useState(true);
  const [roomMenu, setRoomMenu] = React.useState<{ roomId: string; x: number; y: number } | null>(null);
  const [dropTargetRoomId, setDropTargetRoomId] = React.useState<string | null>(null);
  const [dropPlacement, setDropPlacement] = React.useState<"above" | "below" | null>(null);
  const [roomOrderMap, setRoomOrderMap] = React.useState<Record<string, string[]>>(() => {
    if (user?.roomOrder) {
      return user.roomOrder;
    }
    try {
      const saved = typeof window !== "undefined" ? localStorage.getItem("near:roomOrder") : null;
      if (saved) return JSON.parse(saved) as Record<string, string[]>;
    } catch {}
    return {};
  });
  const [contextMenu, setContextMenu] = React.useState<{
    folderId: string;
    folderName: string;
    x: number;
    y: number;
  } | null>(null);

  const [deleteConfirmOpen, setDeleteConfirmOpen] = React.useState(false);
  const [deleteTargetFolderId, setDeleteTargetFolderId] = React.useState<string | null>(null);

  const [renameOpen, setRenameOpen] = React.useState(false);
  const [renameTargetFolderId, setRenameTargetFolderId] = React.useState<string | null>(null);
  const [renameValue, setRenameValue] = React.useState("");

  const [alertOpen, setAlertOpen] = React.useState(false);
  const [alertTitle, setAlertTitle] = React.useState("");
  const [alertMessage, setAlertMessage] = React.useState("");

  React.useEffect(() => {
    const handleCloseMenu = () => {
      setContextMenu(null);
      setRoomMenu(null);
    };
    window.addEventListener("click", handleCloseMenu);
    return () => window.removeEventListener("click", handleCloseMenu);
  }, []);

  const [prevRoomOrder, setPrevRoomOrder] = React.useState(user?.roomOrder);
  if (prevRoomOrder !== user?.roomOrder) {
    setPrevRoomOrder(user?.roomOrder);
    if (user?.roomOrder) {
      setRoomOrderMap(user.roomOrder);
    } else {
      try {
        const saved = typeof window !== "undefined" ? localStorage.getItem("near:roomOrder") : null;
        if (saved) {
          setRoomOrderMap(JSON.parse(saved) as Record<string, string[]>);
        } else {
          setRoomOrderMap({});
        }
      } catch {
        setRoomOrderMap({});
      }
    }
  }

  const applyRoomOrder = (sectionRooms: ChatRoom[], sectionKey: string): ChatRoom[] => {
    const order = roomOrderMap[sectionKey];
    if (!order || order.length === 0) return sectionRooms;
    const posMap = new Map(order.map((id, i) => [id, i]));
    return [...sectionRooms].sort((a, b) => {
      const pa = posMap.has(a.id) ? (posMap.get(a.id) as number) : sectionRooms.length;
      const pb = posMap.has(b.id) ? (posMap.get(b.id) as number) : sectionRooms.length;
      return pa - pb;
    });
  };

  const saveRoomOrder = (sectionKey: string, orderedIds: string[]) => {
    const next = { ...roomOrderMap, [sectionKey]: orderedIds };
    setRoomOrderMap(next);
    try {
      localStorage.setItem("near:roomOrder", JSON.stringify(next));
    } catch {}
    void updateRoomSorting(next);
  };

  const handleRoomDropOnRoom = (sectionKey: string, draggedId: string, targetId: string, placement: "above" | "below") => {
    if (draggedId === targetId) return;
    const sectionRooms = sectionKey === "root"
      ? rooms.filter((r) => !r.folderId && r.id !== draggedId)
      : rooms.filter((r) => r.folderId === sectionKey && r.id !== draggedId);
    const ordered = applyRoomOrder(sectionRooms, sectionKey);
    const ids = ordered.map((r) => r.id);
    
    let insertIdx = ids.indexOf(targetId);
    if (insertIdx !== -1) {
      if (placement === "below") {
        insertIdx += 1;
      }
      ids.splice(insertIdx, 0, draggedId);
    } else {
      ids.push(draggedId);
    }
    saveRoomOrder(sectionKey, ids);
  };

  const handleRenameFolderClick = (folderId: string, currentName: string) => {
    setRenameTargetFolderId(folderId);
    setRenameValue(currentName);
    setRenameOpen(true);
  };

  const handleRenameSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!renameTargetFolderId) return;
    const trimmed = renameValue.trim();
    if (!trimmed) {
      setAlertTitle(t("folders.errorTitle"));
      setAlertMessage(t("folders.nameCannotBeEmpty"));
      setAlertOpen(true);
      return;
    }
    if (trimmed.length > 50) {
      setAlertTitle(t("folders.errorTitle"));
      setAlertMessage(t("folders.nameTooLong"));
      setAlertOpen(true);
      return;
    }
    try {
      await handleRenameFolder(renameTargetFolderId, trimmed);
      setRenameOpen(false);
    } catch (error) {
      setAlertTitle(t("folders.errorTitle"));
      setAlertMessage(error instanceof Error ? error.message : (t("folders.renameFailed")));
      setAlertOpen(true);
    }
  };

  const resetDragState = () => {
    setDraggedRoomId(null);
    setDragOverFolderId(null);
    setDragOverUncategorized(false);
    setIsRootDropActive(false);
    setDropTargetRoomId(null);
    setDropPlacement(null);
  };

  const getDroppedRoomId = (event: React.DragEvent) =>
    event.dataTransfer.getData("text/plain") || draggedRoomId;

  const handleRoomDragStart = (event: React.DragEvent, roomId: string) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", roomId);
    setDraggedRoomId(roomId);
  };

  const handleDropToRoot = (event: React.DragEvent) => {
    event.preventDefault();
    const roomId = getDroppedRoomId(event);
    if (roomId) {
      handleCategorizeRoom(roomId, null);
    }
    resetDragState();
  };

  const handleDropToFolder = (event: React.DragEvent, folderId: string) => {
    event.preventDefault();
    const roomId = getDroppedRoomId(event);
    if (roomId) {
      handleCategorizeRoom(roomId, folderId);
      const targetFolder = folders.find((folder) => folder.id === folderId);
      if (targetFolder?.collapsed) {
        toggleFolder(folderId);
      }
    }
    resetDragState();
  };

  const visibleFolders = folders.filter((folder) => {
    const folderMatches = folder.name.toLowerCase().includes(searchQuery.toLowerCase());
    const hasMatchingRooms = rooms.some(
      (room) =>
        room.folderId === folder.id &&
        !room.isHidden &&
        room.name.toLowerCase().includes(searchQuery.toLowerCase()),
    );
    return folderMatches || hasMatchingRooms;
  });

  const getFolderRooms = (folderId: string) => {
    const folder = folders.find((item) => item.id === folderId);
    const folderMatches = folder?.name.toLowerCase().includes(searchQuery.toLowerCase()) ?? false;
    if (folderMatches) {
      return rooms.filter((room) => room.folderId === folderId && !room.isHidden);
    }

    return rooms.filter(
      (room) =>
        room.folderId === folderId &&
        !room.isHidden &&
        room.name.toLowerCase().includes(searchQuery.toLowerCase()),
    );
  };

  const rootRooms = rooms.filter(
    (room) =>
      !room.folderId &&
      !room.isHidden &&
      room.name.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  const hiddenRooms = rooms.filter(
    (room) =>
      room.isHidden &&
      room.name.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  const handleDeleteFolderClick = (event: React.MouseEvent | React.BaseSyntheticEvent | MouseEvent | undefined, folderId: string) => {
    if (event) event.stopPropagation();
    setDeleteTargetFolderId(folderId);
    setDeleteConfirmOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTargetFolderId) return;
    try {
      await handleDeleteFolder(deleteTargetFolderId);
      setDeleteConfirmOpen(false);
    } catch (error) {
      console.error(error);
      setAlertTitle(t("folders.errorTitle"));
      setAlertMessage(error instanceof Error ? error.message : (t("folders.deleteFailed")));
      setAlertOpen(true);
    }
  };

  const handleToggleHidden = async (roomId: string, hidden: boolean) => {
    try {
      await setRoomHidden(roomId, hidden);
    } catch (error) {
      console.error(error);
      setAlertTitle(t("folders.errorTitle"));
      setAlertMessage(error instanceof Error ? error.message : t("folders.errorTitle"));
      setAlertOpen(true);
    }
  };

  const handleLeaveOrBlockFromMenu = async (roomId: string) => {
    const target = rooms.find((item) => item.id === roomId);
    if (!target) return;
    const action =
      target.type === "group"
        ? t("chatroom.leave")
        : target.isReadonly
          ? t("chatroom.unblock")
          : t("chatroom.block");
    if (!confirm(t("chatroom.confirmLeaveOrBlock", { action, name: target.name }))) return;
    try {
      const { isDeleted, newActiveId } = await handleLeaveOrBlock(roomId);
      if (isDeleted) {
        if (newActiveId) {
          router.push(`/chat/${newActiveId}`);
        } else if (activeRoomId === roomId) {
          router.push("/");
        }
      }
    } catch (error) {
      console.error(error);
      setAlertTitle(t("folders.errorTitle"));
      setAlertMessage(error instanceof Error ? error.message : t("folders.errorTitle"));
      setAlertOpen(true);
    }
  };

  // One-tap category filter (resets per session) and sort preset (persisted).
  const [filterMode, setFilterMode] = React.useState<FilterMode>("all");
  const [sortMode, setSortMode] = React.useState<SortMode>(() => {
    try {
      const saved = typeof window !== "undefined" ? localStorage.getItem("near:chatSort") : null;
      if (saved === "custom" || saved === "unread") return saved;
    } catch {}
    return "custom";
  });

  const changeSortMode = (mode: SortMode) => {
    setSortMode(mode);
    try {
      localStorage.setItem("near:chatSort", mode);
    } catch {}
  };

  // The grouped folder view (with drag-and-drop custom ordering) is only meaningful
  // for the default all + custom combination; any other preset renders a flat list.
  const isFlatMode = filterMode !== "all" || sortMode !== "custom";

  const resolveRoomAvatar = (room: ChatRoom): string | undefined => {
    if (room.avatarUrl) {
      return resolveAssetUrl(room.avatarUrl);
    }
    if (room.type === "msg") {
      const otherMember = room.members?.find((m) => m.userId !== user.userId);
      if (otherMember?.avatarUrl) {
        return resolveAssetUrl(otherMember.avatarUrl);
      }
      const friend = friends.find((f) => f.id === room.otherMemberId || f.name === room.name);
      if (friend?.avatarUrl) {
        return resolveAssetUrl(friend.avatarUrl);
      }
    }
    return getAvatarForUser(room.name, user.avatar, user.username);
  };

  const flatRooms = React.useMemo(() => {
    if (!isFlatMode) return [];
    const query = searchQuery.toLowerCase();
    const matchesSearch = (room: ChatRoom) => room.name.toLowerCase().includes(query);
    const matchesFilter = (room: ChatRoom) => {
      switch (filterMode) {
        case "dm":
          return room.type === "msg";
        case "group":
          return room.type === "group";
        case "unread":
          return (room.unreadCount ?? 0) > 0;
        default:
          return true;
      }
    };
    // Hidden rooms keep their own collapsed section (rendered in every mode), so
    // they must stay out of the flat list too — otherwise they'd appear twice.
    let list = rooms.filter((room) => !room.isHidden && matchesSearch(room) && matchesFilter(room));
    if (sortMode === "unread") {
      list = [...list].sort((a, b) => (b.unreadCount ?? 0) - (a.unreadCount ?? 0));
    }
    // Keep the currently open room visible even if the active filter would hide it.
    if (activeRoomId && isChatPage) {
      const active = rooms.find((room) => room.id === activeRoomId);
      if (active && matchesSearch(active) && !list.some((room) => room.id === active.id)) {
        list = [active, ...list];
      }
    }
    return list;
  }, [isFlatMode, rooms, searchQuery, filterMode, sortMode, activeRoomId, isChatPage]);

  const filterOptions: { value: FilterMode; label: string }[] = [
    { value: "all", label: t("chatFilter.filterAll") },
    { value: "dm", label: t("chatFilter.filterDm") },
    { value: "group", label: t("chatFilter.filterGroup") },
    { value: "unread", label: t("chatFilter.filterUnread") },
  ];

  return (
    <>
      <SectionLabel label={t("sidebar.chats")} />

      <div className="px-4 pb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1 flex-wrap">
          {filterOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setFilterMode(option.value)}
              className={`px-2 py-0.5 rounded-sm text-[10px] font-semibold border transition-colors ${
                filterMode === option.value
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border-secondary text-text-muted hover:text-foreground hover:border-border-primary"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => changeSortMode(sortMode === "custom" ? "unread" : "custom")}
          title={t("chatFilter.sortLabel")}
          className="shrink-0 flex items-center gap-1 px-2 py-0.5 rounded-sm text-[10px] font-semibold border border-border-secondary text-text-muted hover:text-foreground hover:border-border-primary transition-colors"
        >
          <span className="rotate-90 leading-none">{"⇅"}</span>
          {sortMode === "unread" ? t("chatFilter.sortUnread") : t("chatFilter.sortCustom")}
        </button>
      </div>

      {isFlatMode && (
        flatRooms.length > 0 ? (
          <div className="flex flex-col">
            {flatRooms.map((room) => (
              <RoomItem
                key={room.id}
                room={room}
                isActive={room.id === activeRoomId && isChatPage}
                draggable={false}
                onClick={() => router.push(`/chat/${room.id}`)}
                avatarSrc={resolveRoomAvatar(room)}
                noMessagesText={t("sidebar.noMessages")}
                isPending={room.myRole === "pending"}
              />
            ))}
          </div>
        ) : (
          <div className="px-4 py-8 text-center text-[11px] text-text-muted">
            {t("chatFilter.emptyResult")}
          </div>
        )
      )}

      {!isFlatMode && rootRooms.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setIsUncategorizedCollapsed((current) => !current)}
            onDragOver={(event) => {
              if (!draggedRoomId) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setDragOverUncategorized(true);
            }}
            onDragLeave={() => setDragOverUncategorized(false)}
            onDrop={(event) => {
              event.preventDefault();
              const roomId = getDroppedRoomId(event);
              if (roomId) {
                handleCategorizeRoom(roomId, null);
                if (isUncategorizedCollapsed) {
                  setIsUncategorizedCollapsed(false);
                }
              }
              resetDragState();
            }}
            className={`w-full px-4 py-2 flex items-center justify-between text-xs font-semibold text-foreground hover:bg-surface-muted transition-colors ${
              dragOverUncategorized ? "bg-primary/10 text-primary" : ""
            }`}
          >
            <span className="flex items-center gap-2">
              <span className={isUncategorizedCollapsed ? "" : "rotate-90"}>{">"}</span>
              {t("chatroom.noCategory")}
            </span>
            <Badge variant="default" className="scale-90">
              {rootRooms.length}
            </Badge>
          </button>

          {!isUncategorizedCollapsed && (
            <div
              onDragOver={(event) => {
                if (!draggedRoomId) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setIsRootDropActive(true);
              }}
              onDragLeave={() => setIsRootDropActive(false)}
              onDrop={handleDropToRoot}
              className={`pl-4 border-l border-border-secondary/40 ml-5 transition-colors ${
                isRootDropActive ? "bg-primary/5 outline-1 outline-primary/40 outline-offset-1" : ""
              }`}
            >
              {applyRoomOrder(rootRooms, "root").map((room) => {
                const isPending = room.myRole === "pending";
                return (
                  <RoomItem
                    key={room.id}
                    room={room}
                    isActive={room.id === activeRoomId && isChatPage}
                    isDropTarget={dropTargetRoomId === room.id}
                    dropPlacement={dropTargetRoomId === room.id ? dropPlacement : null}
                    onClick={() => router.push(`/chat/${room.id}`)}
                    onDragStart={(event) => handleRoomDragStart(event, room.id)}
                    onDragEnd={resetDragState}
                    onDragOver={(event) => {
                      if (!draggedRoomId || draggedRoomId === room.id) return;
                      event.preventDefault();
                      event.stopPropagation();
                      const rect = event.currentTarget.getBoundingClientRect();
                      const relativeY = event.clientY - rect.top;
                      const placement = relativeY < rect.height / 2 ? "above" : "below";
                      setDropTargetRoomId(room.id);
                      setDropPlacement(placement);
                    }}
                    onDrop={async (event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      const drId = getDroppedRoomId(event);
                      if (!drId || drId === room.id) { resetDragState(); return; }
                      const draggedRoom = rooms.find((r) => r.id === drId);
                      if (draggedRoom && draggedRoom.folderId) {
                        await handleCategorizeRoom(drId, null);
                      }
                      handleRoomDropOnRoom("root", drId, room.id, dropPlacement || "above");
                      resetDragState();
                    }}
                    avatarSrc={(() => {
                      if (room.avatarUrl) {
                        return resolveAssetUrl(room.avatarUrl);
                      }
                      if (room.type === "msg") {
                        const otherMember = room.members?.find((m) => m.userId !== user.userId);
                        if (otherMember?.avatarUrl) {
                          return resolveAssetUrl(otherMember.avatarUrl);
                        }
                        const friend = friends.find((f) => f.id === room.otherMemberId || f.name === room.name);
                        if (friend?.avatarUrl) {
                          return resolveAssetUrl(friend.avatarUrl);
                        }
                      }
                      return getAvatarForUser(room.name, user.avatar, user.username);
                    })()}
                    noMessagesText={t("sidebar.noMessages")}
                    isPending={isPending}
                    onOpenMenu={(x, y) => setRoomMenu({ roomId: room.id, x, y })}
                  />
                );
              })}
            </div>
          )}
        </div>
      )}

      {!isFlatMode && visibleFolders.length > 0 && (
        <div className="flex flex-col gap-0.5 pb-2">
          {visibleFolders.map((folder) => {
            const folderRooms = getFolderRooms(folder.id);
            return (
              <div key={folder.id}>
                <div
                  onDragOver={(event) => {
                    if (!draggedRoomId) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    setDragOverFolderId(folder.id);
                  }}
                  onDragLeave={() => setDragOverFolderId(null)}
                  onDrop={(event) => handleDropToFolder(event, folder.id)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setContextMenu({
                      folderId: folder.id,
                      folderName: folder.name,
                      x: event.clientX,
                      y: event.clientY,
                    });
                  }}
                  className={`group w-full px-4 py-2 flex items-center justify-between text-xs font-semibold text-foreground hover:bg-surface-muted transition-colors select-none ${
                    dragOverFolderId === folder.id ? "bg-primary/10 text-primary" : ""
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => toggleFolder(folder.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <span className={folder.collapsed ? "" : "rotate-90"}>{">"}</span>
                    <span className="truncate">{folder.name}</span>
                  </button>

                  <span className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      aria-label="Folder actions"
                      onClick={(event) => {
                        event.stopPropagation();
                        const rect = event.currentTarget.getBoundingClientRect();
                        setContextMenu({
                          folderId: folder.id,
                          folderName: folder.name,
                          x: rect.right - 120,
                          y: rect.bottom + 4,
                        });
                      }}
                      className="rounded-sm border border-transparent px-1.5 py-0.5 text-xs text-text-muted opacity-0 transition-all hover:border-border-primary hover:text-foreground group-hover:opacity-100 focus:opacity-100"
                    >
                      ...
                    </button>

                    <Badge variant="default" className="scale-90">
                      {folderRooms.length}
                    </Badge>
                  </span>
                </div>

                {!folder.collapsed && (
                  <div className="pl-4 border-l border-border-secondary/40 ml-5">
                    {applyRoomOrder(folderRooms, folder.id).map((room) => {
                      const isPending = room.myRole === "pending";
                      return (
                        <RoomItem
                          key={room.id}
                          room={room}
                          isActive={room.id === activeRoomId && isChatPage}
                          isDropTarget={dropTargetRoomId === room.id}
                          dropPlacement={dropTargetRoomId === room.id ? dropPlacement : null}
                          onClick={() => router.push(`/chat/${room.id}`)}
                          onDragStart={(event) => handleRoomDragStart(event, room.id)}
                          onDragEnd={resetDragState}
                          onDragOver={(event) => {
                            if (!draggedRoomId || draggedRoomId === room.id) return;
                            event.preventDefault();
                            event.stopPropagation();
                            const rect = event.currentTarget.getBoundingClientRect();
                            const relativeY = event.clientY - rect.top;
                            const placement = relativeY < rect.height / 2 ? "above" : "below";
                            setDropTargetRoomId(room.id);
                            setDropPlacement(placement);
                          }}
                          onDrop={async (event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            const drId = getDroppedRoomId(event);
                            if (!drId || drId === room.id) { resetDragState(); return; }
                            const draggedRoom = rooms.find((r) => r.id === drId);
                            if (draggedRoom && draggedRoom.folderId !== folder.id) {
                              await handleCategorizeRoom(drId, folder.id);
                            }
                            handleRoomDropOnRoom(folder.id, drId, room.id, dropPlacement || "above");
                            resetDragState();
                          }}
                          avatarSrc={(() => {
                            if (room.avatarUrl) {
                              return resolveAssetUrl(room.avatarUrl);
                            }
                            if (room.type === "msg") {
                              const otherMember = room.members?.find((m) => m.userId !== user.userId);
                              if (otherMember?.avatarUrl) {
                                return resolveAssetUrl(otherMember.avatarUrl);
                              }
                              const friend = friends.find((f) => f.id === room.otherMemberId || f.name === room.name);
                              if (friend?.avatarUrl) {
                                return resolveAssetUrl(friend.avatarUrl);
                              }
                            }
                            return getAvatarForUser(room.name, user.avatar, user.username);
                          })()}
                          noMessagesText={t("sidebar.noMessages")}
                          isPending={isPending}
                          onOpenMenu={(x, y) => setRoomMenu({ roomId: room.id, x, y })}
                        />
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {hiddenRooms.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setIsHiddenCollapsed((current) => !current)}
            className="w-full px-4 py-2 flex items-center justify-between text-xs font-semibold text-foreground hover:bg-surface-muted transition-colors"
          >
            <span className="flex items-center gap-2">
              <span className={isHiddenCollapsed ? "" : "rotate-90"}>{">"}</span>
              {t("sidebar.hiddenChats")}
            </span>
            <Badge variant="default" className="scale-90">
              {hiddenRooms.length}
            </Badge>
          </button>

          {!isHiddenCollapsed && (
            <div className="pl-4 border-l border-border-secondary/40 ml-5">
              {hiddenRooms.map((room) => {
                const isPending = room.myRole === "pending";
                return (
                  <RoomItem
                    key={room.id}
                    room={room}
                    isActive={room.id === activeRoomId && isChatPage}
                    onClick={() => router.push(`/chat/${room.id}`)}
                    onDragStart={() => {}}
                    onDragEnd={() => {}}
                    onOpenMenu={(x, y) => setRoomMenu({ roomId: room.id, x, y })}
                    avatarSrc={(() => {
                      if (room.avatarUrl) {
                        return resolveAssetUrl(room.avatarUrl);
                      }
                      if (room.type === "msg") {
                        const otherMember = room.members?.find((m) => m.userId !== user.userId);
                        if (otherMember?.avatarUrl) {
                          return resolveAssetUrl(otherMember.avatarUrl);
                        }
                        const friend = friends.find((f) => f.id === room.otherMemberId || f.name === room.name);
                        if (friend?.avatarUrl) {
                          return resolveAssetUrl(friend.avatarUrl);
                        }
                      }
                      return getAvatarForUser(room.name, user.avatar, user.username);
                    })()}
                    noMessagesText={t("sidebar.noMessages")}
                    isPending={isPending}
                  />
                );
              })}
            </div>
          )}
        </div>
      )}

      {roomMenu && (() => {
        const menuRoom = rooms.find((item) => item.id === roomMenu.roomId);
        if (!menuRoom) return null;
        return (
          <div
            style={{
              position: "fixed",
              top: roomMenu.y,
              left: roomMenu.x,
            }}
            className="bg-surface-card border border-border-primary rounded-sm shadow-md py-1 z-50 min-w-[140px]"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => {
                setRoomMenu(null);
                void handleToggleHidden(menuRoom.id, !menuRoom.isHidden);
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-surface-muted text-foreground transition-colors font-normal text-xs block"
            >
              {menuRoom.isHidden ? t("sidebar.unhideChat") : t("sidebar.hideChat")}
            </button>
            {menuRoom.myRole !== "owner" && (
              <button
                type="button"
                onClick={() => {
                  setRoomMenu(null);
                  void handleLeaveOrBlockFromMenu(menuRoom.id);
                }}
                className="w-full text-left px-3 py-1.5 hover:bg-surface-muted text-red-600 transition-colors font-normal text-xs block"
              >
                {menuRoom.type === "group"
                  ? t("chatroom.leave")
                  : menuRoom.isReadonly
                    ? t("chatroom.unblock")
                    : t("chatroom.block")}
              </button>
            )}
          </div>
        );
      })()}

      {contextMenu && (
        <div
          style={{
            position: "fixed",
            top: contextMenu.y,
            left: contextMenu.x,
          }}
          className="bg-surface-card border border-border-primary rounded-sm shadow-md py-1 z-50 min-w-[120px]"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              setContextMenu(null);
              void handleRenameFolderClick(contextMenu.folderId, contextMenu.folderName);
            }}
            className="w-full text-left px-3 py-1.5 hover:bg-surface-muted text-foreground transition-colors font-normal text-xs block"
          >
            {t("folders.rename")}
          </button>
          <button
            type="button"
            onClick={(event) => {
              setContextMenu(null);
              void handleDeleteFolderClick(event as unknown as React.MouseEvent, contextMenu.folderId);
            }}
            className="w-full text-left px-3 py-1.5 hover:bg-surface-muted text-red-600 transition-colors font-normal text-xs block"
          >
            {t("folders.delete")}
          </button>
        </div>
      )}

      {deleteConfirmOpen && (
        <Modal
          isOpen={deleteConfirmOpen}
          onClose={() => setDeleteConfirmOpen(false)}
          title={t("folders.confirmDelete")}
        >
          <div className="flex flex-col gap-4">
            <p className="text-sm text-text-muted">
              {t("folders.deleteConfirmDesc")}
            </p>
            <div className="flex justify-end gap-2.5">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setDeleteConfirmOpen(false)}
              >
                {t("folders.cancel")}
              </Button>
              <Button
                type="button"
                variant="primary"
                className="bg-red-600 hover:bg-red-700 active:bg-red-800 border-none"
                onClick={handleDeleteConfirm}
              >
                {t("folders.deleteAction")}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {renameOpen && (
        <Modal
          isOpen={renameOpen}
          onClose={() => setRenameOpen(false)}
          title={t("folders.rename")}
        >
          <form onSubmit={handleRenameSubmit} className="flex flex-col gap-4">
            <Input
              label={t("folders.nameLabel")}
              type="text"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              required
              autoFocus
            />
            <div className="flex justify-end gap-2.5">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setRenameOpen(false)}
              >
                {t("folders.cancel")}
              </Button>
              <Button
                type="submit"
                variant="primary"
              >
                {t("folders.save")}
              </Button>
            </div>
          </form>
        </Modal>
      )}

      {alertOpen && (
        <Modal
          isOpen={alertOpen}
          onClose={() => setAlertOpen(false)}
          title={alertTitle}
        >
          <div className="flex flex-col gap-4">
            <p className="text-sm text-text-muted">{alertMessage}</p>
            <div className="flex justify-end">
              <Button
                type="button"
                variant="primary"
                onClick={() => setAlertOpen(false)}
              >
                {t("folders.confirmAction")}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

function SectionLabel({ label }: { label: string }) {
  return (
    <span className="px-4 pt-4 pb-1 text-[10px] font-bold text-text-muted uppercase tracking-widest block">
      {label}
    </span>
  );
}

function RoomItem({
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
  onOpenMenu,
  draggable = true,
}: {
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
  onOpenMenu?: (x: number, y: number) => void;
  draggable?: boolean;
}) {
  const { t } = useTranslation();

  return (
    <div
      onDragOver={onDragOver}
      onDrop={onDrop}
      onContextMenu={(event) => {
        if (!onOpenMenu) return;
        event.preventDefault();
        onOpenMenu(event.clientX, event.clientY);
      }}
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
      {onOpenMenu && (
        <button
          type="button"
          aria-label="Room actions"
          onClick={(event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            onOpenMenu(rect.right - 140, rect.bottom + 4);
          }}
          className="rounded-sm border border-transparent px-1.5 py-0.5 text-xs text-text-muted opacity-0 transition-all hover:border-border-primary hover:text-foreground group-hover:opacity-100 focus:opacity-100 shrink-0"
        >
          ...
        </button>
      )}
      <Badge variant="default" className="scale-75 font-mono">
        {room.type === "group" ? "G" : "DM"}
      </Badge>
    </div>
  );
}
