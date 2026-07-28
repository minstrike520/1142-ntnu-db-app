"use client";

import React from "react";
import { usePathname, useRouter } from "next/navigation";
import { useChat } from "@/context/ChatContext";
import { useTranslation } from "@/hooks/useTranslation";
import MessageDetailIcon from "@iconify-react/boxicons/message-detail";
import GroupIcon from "@iconify-react/boxicons/group";
import AlertTriangleIcon from "@iconify-react/boxicons/alert-triangle";
import CogIcon from "@iconify-react/boxicons/cog";
import LogoutIcon from "@iconify-react/boxicons/arrow-out-left-square-half-filled";

type NavItem = {
  label: string;
  active: boolean;
  onClick: () => void;
  badge?: number;
  icon: React.ReactNode;
};

/**
 * Persistent bottom tab bar shown only on phone-sized viewports (< md).
 * On larger screens the equivalent navigation lives in the sidebar rail, so
 * this is hidden via `md:hidden` by the parent layout.
 */
export default function MobileNav() {
  const router = useRouter();
  const pathname = usePathname();
  const { friendRequests, setSelectedFriendForSidebar, handleLogout } = useChat();
  const { t } = useTranslation();

  const pendingIncoming =
    friendRequests?.filter((request) => request.direction === "incoming").length || 0;

  const items: NavItem[] = [
    {
      label: t("rail.chats"),
      active: pathname === "/" || pathname.startsWith("/chat"),
      onClick: () => router.push("/"),
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
      active: pathname === "/settings",
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
    <nav className="md:hidden shrink-0 border-t border-border-primary bg-surface-muted flex items-stretch min-h-12 h-14 pb-[env(safe-area-inset-bottom)] select-none">
      {items.map((item, idx) => (
        <button
          key={idx}
          type="button"
          onClick={item.onClick}
          aria-label={item.label}
          aria-current={item.active ? "page" : undefined}
          className={`relative flex-1 flex flex-col items-center justify-center transition-colors cursor-pointer ${
            item.active
              ? "text-primary bg-surface-card"
              : "text-text-muted hover:text-foreground active:bg-surface-card/60"
          }`}
        >
          <span className="relative">
            {item.icon}
            {!!item.badge && (
              <span className="absolute -top-1.5 -right-2 bg-red-500 text-white text-[9px] font-bold rounded-full h-4 min-w-4 flex items-center justify-center px-1">
                {item.badge}
              </span>
            )}
          </span>
          {item.active && <span className="absolute left-0 right-0 top-0 h-[3px] bg-primary" />}
        </button>
      ))}
    </nav>
  );
}
