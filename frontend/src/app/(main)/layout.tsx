"use client";

import React from "react";
import { usePathname, useRouter } from "next/navigation";
import { ChatProvider, useChat } from "@/context/ChatContext";
import Sidebar from "@/components/layout/Sidebar";
import MobileNav from "@/components/layout/MobileNav";
import { useTranslation } from "@/hooks/useTranslation";
import { useActiveAccessToken } from "@/hooks/useActiveAccessToken";
import { ApiError, getAdminHealth } from "@/lib/api";

function MainLayoutContent({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isMounted, user } = useChat();
  const { t } = useTranslation();
  const pathname = usePathname();
  const router = useRouter();
  const [adminAccess, setAdminAccess] = React.useState<{
    token: string;
    sessionKey: string;
    allowed: boolean;
  } | null>(null);
  const activeToken = useActiveAccessToken();
  const sessionKey = user.userId ?? "anonymous";

  React.useEffect(() => {
    if (!isMounted || !isAuthenticated) return;

    if (!activeToken) return;

    let cancelled = false;
    void getAdminHealth(activeToken)
      .then(() => {
        if (!cancelled) setAdminAccess({ token: activeToken, sessionKey, allowed: true });
      })
      .catch((error: unknown) => {
        if (!cancelled) setAdminAccess({ token: activeToken, sessionKey, allowed: false });
        if (!(error instanceof ApiError && (error.status === 401 || error.status === 403))) {
          console.error("Failed to verify admin navigation access:", error);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeToken, isAuthenticated, isMounted, sessionKey]);

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
  const showAdminNavigation =
    isMounted &&
    isAuthenticated &&
    adminAccess?.allowed === true &&
    adminAccess.token === activeToken &&
    adminAccess.sessionKey === sessionKey;

  return (
    <div className="flex flex-col md:flex-row h-dvh w-full overflow-hidden bg-background text-foreground font-sans transition-colors">
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <div className={`${isListRoot ? "flex" : "hidden"} md:flex h-full w-full md:w-auto`}>
          <Sidebar isAdmin={showAdminNavigation} />
        </div>
        <div className={`${isListRoot ? "hidden" : "flex"} md:flex flex-1 min-w-0 h-full overflow-hidden`}>
          {children}
        </div>
      </div>
      <MobileNav isAdmin={showAdminNavigation} />
    </div>
  );
}

export default function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <ChatProvider>
      <MainLayoutContent>{children}</MainLayoutContent>
    </ChatProvider>
  );
}
