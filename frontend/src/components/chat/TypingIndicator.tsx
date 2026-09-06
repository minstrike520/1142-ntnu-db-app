"use client";

import React from "react";
import { useTypingUsers } from "@/context/ChatContext";

// Isolated so remote typing events (which fire on every peer keystroke) only
// re-render this one element instead of the whole conversation pane.
export function TypingIndicator({ roomId }: { roomId: string }) {
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
