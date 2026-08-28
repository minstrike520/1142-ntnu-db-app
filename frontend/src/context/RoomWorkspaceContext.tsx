"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Message } from "@/context/ChatContext";

/**
 * Per-room composer/scroll state that must survive leaving the chat route.
 *
 * Navigating to /friends, /settings or /emergency unmounts the chat route, and
 * switching rooms re-keys <Chatroom>, so every draft the user had typed used to
 * be dropped (issue #539). This store keeps one snapshot per room for the
 * lifetime of the login session. The same session store also records the last
 * room visited, so returning from another authenticated page can reopen that
 * room instead of defaulting to the first room in the list.
 *
 * Deliberately backed by a ref-held Map rather than React state: <Chatroom>
 * writes a snapshot on every keystroke, and routing that through state would
 * re-render every consumer of the provider and break the render-count budgets
 * asserted in tests/chat-memoization.test.tsx. Laundering the ref through a
 * context with an identity-stable value also keeps <Chatroom> free of any
 * `ref.current` read during render, which the React Compiler rejects — do not
 * "simplify" this into a plain useRef inside the component.
 *
 * Lifetime is exactly one login session: the provider is keyed by user id and
 * lives inside the (main) layout, so a page reload, a logout, or a switch of
 * account drops the Map. That matches the issue's requirement that drafts,
 * scroll position and pending attachments survive navigation but not a reload.
 */
export interface RoomWorkspaceSnapshot {
  inputText: string;
  replyTarget: Message | null;
  editingMessage: Message | null;
  /**
   * Files chosen but not yet uploaded. File objects cannot be serialized, so
   * these are memory-only by construction — which is why the issue only asks
   * for them to survive navigation, not a reload.
   */
  pendingAttachments: File[];
  /** Scroll offset of the message list, or null if the room was never scrolled. */
  scrollTop: number | null;
  /** Pinned to the newest message when leaving; restores to bottom instead. */
  wasAtBottom: boolean;
  /**
   * Topmost visible message and its distance from the top of the viewport.
   * Preferred over `scrollTop` on restore: attachment images swap a fixed-size
   * skeleton for the real image after an async fetch, so raw pixel offsets
   * drift once anything above the anchor grows.
   */
  anchorMessageId: string | null;
  anchorOffset: number;
}

interface RoomWorkspaceContextType {
  readWorkspace: (roomId: string) => RoomWorkspaceSnapshot | undefined;
  writeWorkspace: (roomId: string, snapshot: Partial<RoomWorkspaceSnapshot>) => void;
  clearWorkspace: (roomId: string) => void;
  subscribeRoomUpload: (roomId: string, listener: () => void) => () => void;
  getRoomUploadStatus: (roomId: string) => boolean;
  setRoomUploadStatus: (roomId: string, uploading: boolean) => void;
  subscribeLastViewedRoom: (listener: () => void) => () => void;
  getLastViewedRoomId: () => string | null;
  rememberRoom: (roomId: string) => void;
}

const RoomWorkspaceContext = createContext<RoomWorkspaceContextType | undefined>(undefined);

/**
 * Cap on remembered rooms. Snapshots are small, but pending attachments hold
 * open file handles, so an unbounded Map would accumulate for a whole session.
 */
const MAX_REMEMBERED_ROOMS = 20;

const emptySnapshot = (): RoomWorkspaceSnapshot => ({
  inputText: "",
  replyTarget: null,
  editingMessage: null,
  pendingAttachments: [],
  scrollTop: null,
  wasAtBottom: true,
  anchorMessageId: null,
  anchorOffset: 0,
});

const isEmpty = (snapshot: RoomWorkspaceSnapshot): boolean =>
  snapshot.inputText === "" &&
  snapshot.replyTarget === null &&
  snapshot.editingMessage === null &&
  snapshot.pendingAttachments.length === 0 &&
  snapshot.scrollTop === null;

export function RoomWorkspaceProvider({ children }: { children: React.ReactNode }) {
  const workspacesRef = useRef<Map<string, RoomWorkspaceSnapshot>>(new Map());
  const uploadingRoomIdsRef = useRef(new Set<string>());
  const roomUploadListenersRef = useRef(new Map<string, Set<() => void>>());
  const lastViewedRoomIdRef = useRef<string | null>(null);
  const lastViewedRoomListenersRef = useRef(new Set<() => void>());
  // Mirrors "some room holds unsent files" into render-visible state so the
  // beforeunload listener is only registered when it can actually fire. An
  // always-on beforeunload handler makes the page ineligible for bfcache.
  const [hasPendingAttachments, setHasPendingAttachments] = useState(false);

  const syncPendingFlag = useCallback(() => {
    let pending = false;
    for (const snapshot of workspacesRef.current.values()) {
      if (snapshot.pendingAttachments.length > 0) {
        pending = true;
        break;
      }
    }
    setHasPendingAttachments((current) => (current === pending ? current : pending));
  }, []);

  const readWorkspace = useCallback(
    (roomId: string) => workspacesRef.current.get(roomId),
    [],
  );

  const writeWorkspace = useCallback(
    (roomId: string, snapshot: Partial<RoomWorkspaceSnapshot>) => {
      const workspaces = workspacesRef.current;
      const merged = { ...(workspaces.get(roomId) ?? emptySnapshot()), ...snapshot };

      if (isEmpty(merged)) {
        // Nothing worth remembering: drop the entry instead of keeping one per
        // room the user has ever opened.
        workspaces.delete(roomId);
      } else {
        // Re-insert so Map iteration order stays least-recently-written first.
        workspaces.delete(roomId);
        workspaces.set(roomId, merged);
        while (workspaces.size > MAX_REMEMBERED_ROOMS) {
          const oldest = workspaces.keys().next();
          if (oldest.done) break;
          workspaces.delete(oldest.value);
        }
      }

      syncPendingFlag();
    },
    [syncPendingFlag],
  );

  const clearWorkspace = useCallback(
    (roomId: string) => {
      workspacesRef.current.delete(roomId);
      syncPendingFlag();
    },
    [syncPendingFlag],
  );

  const subscribeRoomUpload = useCallback((roomId: string, listener: () => void) => {
    let listeners = roomUploadListenersRef.current.get(roomId);
    if (!listeners) {
      listeners = new Set();
      roomUploadListenersRef.current.set(roomId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) roomUploadListenersRef.current.delete(roomId);
    };
  }, []);

  const getRoomUploadStatus = useCallback(
    (roomId: string) => uploadingRoomIdsRef.current.has(roomId),
    [],
  );

  const setRoomUploadStatus = useCallback((roomId: string, uploading: boolean) => {
    const uploadingRoomIds = uploadingRoomIdsRef.current;
    const currentlyUploading = uploadingRoomIds.has(roomId);
    if (currentlyUploading === uploading) return;

    if (uploading) {
      uploadingRoomIds.add(roomId);
    } else {
      uploadingRoomIds.delete(roomId);
    }

    for (const listener of roomUploadListenersRef.current.get(roomId) ?? []) listener();
  }, []);

  const subscribeLastViewedRoom = useCallback((listener: () => void) => {
    lastViewedRoomListenersRef.current.add(listener);
    return () => lastViewedRoomListenersRef.current.delete(listener);
  }, []);

  const getLastViewedRoomId = useCallback(() => lastViewedRoomIdRef.current, []);

  const rememberRoom = useCallback((roomId: string) => {
    if (lastViewedRoomIdRef.current === roomId) return;
    lastViewedRoomIdRef.current = roomId;
    for (const listener of lastViewedRoomListenersRef.current) listener();
  }, []);

  // Pending attachments only live in memory, so a reload silently loses them.
  // Registered here rather than in <Chatroom> so the warning still fires while
  // the user is on /friends or /settings with a draft left behind.
  useEffect(() => {
    if (!hasPendingAttachments) return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      // Browsers show their own generic wording; a custom string is ignored.
      // Both calls are needed for cross-browser support, matching the existing
      // guards in ProfileSettings.tsx and GroupSettings.tsx.
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasPendingAttachments]);

  // Identity-stable: the callbacks close over a ref, never over state.
  const value = useMemo<RoomWorkspaceContextType>(
    () => ({
      readWorkspace,
      writeWorkspace,
      clearWorkspace,
      subscribeRoomUpload,
      getRoomUploadStatus,
      setRoomUploadStatus,
      subscribeLastViewedRoom,
      getLastViewedRoomId,
      rememberRoom,
    }),
    [
      readWorkspace,
      writeWorkspace,
      clearWorkspace,
      subscribeRoomUpload,
      getRoomUploadStatus,
      setRoomUploadStatus,
      subscribeLastViewedRoom,
      getLastViewedRoomId,
      rememberRoom,
    ],
  );

  return (
    <RoomWorkspaceContext.Provider value={value}>
      {children}
    </RoomWorkspaceContext.Provider>
  );
}

/** Per-room composer drafts, pending attachments and scroll offset. */
export function useRoomWorkspace() {
  const context = useContext(RoomWorkspaceContext);
  if (context === undefined) {
    throw new Error("useRoomWorkspace must be used within a RoomWorkspaceProvider");
  }
  return context;
}

export function useLastViewedRoomId(): string | null {
  const { subscribeLastViewedRoom, getLastViewedRoomId } = useRoomWorkspace();
  return useSyncExternalStore(subscribeLastViewedRoom, getLastViewedRoomId, getLastViewedRoomId);
}

export function useRoomUploadStatus(roomId: string): boolean {
  const { subscribeRoomUpload, getRoomUploadStatus } = useRoomWorkspace();
  const subscribe = useCallback(
    (listener: () => void) => subscribeRoomUpload(roomId, listener),
    [roomId, subscribeRoomUpload],
  );
  const getSnapshot = useCallback(
    () => getRoomUploadStatus(roomId),
    [roomId, getRoomUploadStatus],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
