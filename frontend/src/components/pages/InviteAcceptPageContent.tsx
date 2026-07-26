"use client";

import React, { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useParams, useRouter } from "next/navigation";
import Image from "next/image";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { getActiveAccessToken, getRoomInvitePreview, joinRoomByCode, refreshTokens } from "@/lib/api";
import { getServerLocale, getStoredLocale, subscribeToLocale, translate } from "@/lib/i18n";
import type { RoomInvitePreview } from "@shared/types";

// This page renders outside the `(main)` route group (like `login`/`register`) so a
// signed-out visitor can reach it and be redirected to `/login?redirect=...` without
// mounting the full chat app shell. `useTranslation` is unavailable here because it
// depends on `ChatProvider`, so the persisted locale is read directly instead.
type Status = "checking" | "loading" | "ready" | "joining" | "pending" | "error";

export default function InviteAcceptPageContent() {
  const params = useParams<{ code: string }>();
  const router = useRouter();
  const code = Array.isArray(params.code) ? params.code[0] : params.code;

  const [status, setStatus] = useState<Status>("checking");
  const [preview, setPreview] = useState<RoomInvitePreview | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [token, setToken] = useState<string | null>(null);
  // The server has no access to the visitor's stored language, so it renders the
  // default locale and React re-renders with the real one right after hydration.
  // Reading localStorage directly in a `useState` initializer would instead make
  // the server and client markup disagree.
  const locale = useSyncExternalStore(subscribeToLocale, getStoredLocale, getServerLocale);
  const t = useCallback(
    (key: string, replacements?: Record<string, string | number>) =>
      translate(locale, `inviteAccept.${key}`, replacements),
    [locale],
  );

  useEffect(() => {
    document.title = "Near | Group Invite";
  }, []);

  useEffect(() => {
    if (!code) return;
    let cancelled = false;

    void (async () => {
      let activeToken = getActiveAccessToken();
      if (!activeToken) {
        try {
          activeToken = (await refreshTokens()).token;
        } catch {
          if (!cancelled) {
            window.location.replace(`/login?redirect=${encodeURIComponent(`/invite/${code}`)}`);
          }
          return;
        }
      }
      if (cancelled) return;
      setToken(activeToken);
      setStatus("loading");

      try {
        const result = await getRoomInvitePreview(activeToken, code);
        if (cancelled) return;
        setPreview(result);
        // A pending member has a membership row but cannot use the room yet, so
        // show the awaiting-approval state rather than sending them into it.
        setStatus(result.isPending ? "pending" : "ready");
      } catch (err) {
        if (cancelled) return;
        setErrorMessage(err instanceof Error ? err.message : t("invalidInvite"));
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [code, t]);

  const handleAccept = useCallback(async () => {
    if (!token || !code || !preview) return;
    setStatus("joining");
    try {
      const room = await joinRoomByCode(token, code);
      // Branch on the join response, not the preview: an admin may have toggled
      // requireApproval since the preview was fetched, and the response carries
      // the setting that actually decided our role.
      if (room.requireApproval) {
        setStatus("pending");
      } else {
        router.push(`/chat/${room.roomId}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      // Preview and accept aren't atomic (e.g. joined from another tab in between) —
      // treat "already a member" as success rather than surfacing a hard error.
      if (message.toLowerCase().includes("already a member")) {
        // That concurrent join is still only pending on an approval-required
        // room, so keep the waiting state instead of opening an unusable room.
        if (preview.requireApproval) {
          setStatus("pending");
        } else {
          router.push(`/chat/${preview.roomId}`);
        }
        return;
      }
      setErrorMessage(message || t("joinFailed"));
      setStatus("ready");
    }
  }, [token, code, preview, router, t]);

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center p-4 bg-background transition-colors overflow-y-auto">
      <div className="w-full max-w-sm border border-border-primary rounded-sm bg-surface-card p-8 flex flex-col items-center">
        <div className="size-16 bg-surface-muted rounded-sm flex items-center justify-center mb-6 overflow-hidden">
          <Image src="/near.png" alt="Near logo" width={128} height={128} className="object-contain size-full" />
        </div>

        {(status === "checking" || status === "loading") && (
          <p className="text-sm text-text-muted font-sans">{t("loading")}</p>
        )}

        {status === "error" && (
          <>
            <p className="text-sm text-red-600 font-sans text-center mb-6">{errorMessage}</p>
            <Button variant="secondary" className="w-full" onClick={() => router.push("/")}>
              {t("backToNear")}
            </Button>
          </>
        )}

        {status === "pending" && (
          <>
            <p className="text-sm text-foreground font-sans text-center mb-6">
              {t("pendingApproval", { name: preview?.name ?? t("group") })}
            </p>
            <Button variant="secondary" className="w-full" onClick={() => router.push("/")}>
              {t("backToNear")}
            </Button>
          </>
        )}

        {(status === "ready" || status === "joining") && preview && (
          <>
            <Avatar name={preview.name ?? t("group")} src={preview.avatarUrl} size="lg" className="mb-4" />
            <h1 className="text-lg font-bold text-foreground mb-1 text-center font-sans">
              {preview.name ?? t("group")}
            </h1>
            <p className="text-xs text-text-muted select-none font-sans mb-8 text-center">
              {preview.isMember ? t("alreadyMember") : t("invited")}
            </p>

            {errorMessage && (
              <p className="text-xs text-red-600 font-sans text-center mb-4">{errorMessage}</p>
            )}

            {preview.isMember ? (
              <Button variant="primary" className="w-full" onClick={() => router.push(`/chat/${preview.roomId}`)}>
                {t("openChat")}
              </Button>
            ) : (
              <div className="w-full flex gap-3">
                <Button
                  variant="secondary"
                  className="flex-1"
                  disabled={status === "joining"}
                  onClick={() => router.push("/")}
                >
                  {t("cancel")}
                </Button>
                <Button
                  variant="primary"
                  className="flex-1"
                  disabled={status === "joining"}
                  onClick={handleAccept}
                >
                  {status === "joining" ? t("joining") : t("accept")}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
