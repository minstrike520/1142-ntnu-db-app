"use client";

import React from "react";
import { usePathname, useRouter } from "next/navigation";
import { ChatProvider, useChat } from "@/context/ChatContext";
import { RoomWorkspaceProvider } from "@/context/RoomWorkspaceContext";
import Sidebar from "@/components/layout/Sidebar";
import MobileNav from "@/components/layout/MobileNav";
import { useTranslation } from "@/hooks/useTranslation";

function MainLayoutContent({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isMounted } = useChat();
  const { t } = useTranslation();
  const pathname = usePathname();
  const router = useRouter();

  React.useEffect(() => {
    if (isAuthenticated && isMounted) {
      const prefetchRoutes = () => {
        const routes = ["/friends", "/emergency", "/settings"];
        routes.forEach((route) => {
          router.prefetch(route);
        });
      };

      if (typeof window !== "undefined") {
        if ("requestIdleCallback" in window) {
          window.requestIdleCallback(() => prefetchRoutes());
        } else {
          setTimeout(prefetchRoutes, 1500);
        }
      }
    }
  }, [isAuthenticated, isMounted, router]);

  if (!isMounted || !isAuthenticated) {
    return (
      <div className="flex h-dvh w-full items-center justify-center bg-background text-foreground font-sans">
        {t("common.loading")}
      </div>
    );
  }

  // On phones only one pane fits at a time. The chat-list root (`/`) shows the
  // sidebar; every other route shows its content pane. Tablet and desktop keep
  // both panes side by side (md:flex).
  const isListRoot = pathname === "/";

  return (
    <div className="flex flex-col md:flex-row h-dvh w-full overflow-hidden bg-background text-foreground font-sans transition-colors">
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <div className={`${isListRoot ? "flex" : "hidden"} md:flex h-full w-full md:w-auto`}>
          <Sidebar />
        </div>
        <div className={`${isListRoot ? "hidden" : "flex"} md:flex flex-1 min-w-0 h-full overflow-hidden`}>
          {children}
        </div>
      </div>
      <MobileNav />
    </div>
  );
}

/**
 * RoomWorkspaceProvider sits inside the layout (not the route) so per-room
 * drafts outlive navigating to /friends, /settings or /emergency (issue #539).
 *
 * Keying it by user identity drops those drafts the moment the session ends.
 * Logging out clears the session and re-renders this subtree with the signed-out
 * branch below, but the provider itself only unmounts once the redirect to
 * /login lands — without the key, a slow or failed redirect would leave one
 * user's drafts alive for the next.
 */
function SessionScopedWorkspace({ children }: { children: React.ReactNode }) {
  const { user, isAuthenticated } = useChat();
  return (
    <RoomWorkspaceProvider key={isAuthenticated ? user.userId ?? "anonymous" : "signed-out"}>
      {children}
    </RoomWorkspaceProvider>
  );
}

export default function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <ChatProvider>
      <SessionScopedWorkspace>
        <MainLayoutContent>{children}</MainLayoutContent>
      </SessionScopedWorkspace>
    </ChatProvider>
  );
}
