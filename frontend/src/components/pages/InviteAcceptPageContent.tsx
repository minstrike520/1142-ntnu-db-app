"use client";

import React, { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Image from "next/image";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { getActiveAccessToken, getRoomInvitePreview, joinRoomByCode, refreshTokens } from "@/lib/api";
import type { RoomInvitePreview } from "@shared/types";

// This page intentionally mirrors the pre-auth `login`/`register` pages: it renders
// outside the `(main)` route group (no `ChatProvider`, no i18n) so it can be visited
// by a signed-out visitor and redirect them to `/login?redirect=...` without ever
// mounting the full chat app shell.
type Status = "checking" | "loading" | "ready" | "joining" | "pending" | "error";

export default function InviteAcceptPageContent() {
  const params = useParams<{ code: string }>();
  const router = useRouter();
  const code = Array.isArray(params.code) ? params.code[0] : params.code;

  const [status, setStatus] = useState<Status>("checking");
  const [preview, setPreview] = useState<RoomInvitePreview | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [token, setToken] = useState<string | null>(null);

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
        setStatus("ready");
      } catch (err) {
        if (cancelled) return;
        setErrorMessage(
          err instanceof Error ? err.message : "This invite link is invalid or has expired.",
        );
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [code]);

  const handleAccept = useCallback(async () => {
    if (!token || !code || !preview) return;
    setStatus("joining");
    try {
      const room = await joinRoomByCode(token, code);
      if (preview.requireApproval) {
        setStatus("pending");
      } else {
        router.push(`/chat/${room.roomId}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      // Preview and accept aren't atomic (e.g. joined from another tab in between) —
      // treat "already a member" as success rather than surfacing a hard error.
      if (message.toLowerCase().includes("already a member")) {
        router.push(`/chat/${preview.roomId}`);
        return;
      }
      setErrorMessage(message || "Failed to join this room.");
      setStatus("ready");
    }
  }, [token, code, preview, router]);

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center p-4 bg-background transition-colors overflow-y-auto">
      <div className="w-full max-w-sm border border-border-primary rounded-sm bg-surface-card p-8 flex flex-col items-center">
        <div className="size-16 bg-surface-muted rounded-sm flex items-center justify-center mb-6 overflow-hidden">
          <Image src="/near.png" alt="Near logo" width={128} height={128} className="object-contain size-full" />
        </div>

        {(status === "checking" || status === "loading") && (
          <p className="text-sm text-text-muted font-sans">Loading invite...</p>
        )}

        {status === "error" && (
          <>
            <p className="text-sm text-red-600 font-sans text-center mb-6">{errorMessage}</p>
            <Button variant="secondary" className="w-full" onClick={() => router.push("/")}>
              Back to Near
            </Button>
          </>
        )}

        {status === "pending" && (
          <>
            <p className="text-sm text-foreground font-sans text-center mb-6">
              Your request to join {preview?.name ?? "this group"} has been sent. You&apos;ll be able to
              open it once an admin approves your request.
            </p>
            <Button variant="secondary" className="w-full" onClick={() => router.push("/")}>
              Back to Near
            </Button>
          </>
        )}

        {(status === "ready" || status === "joining") && preview && (
          <>
            <Avatar name={preview.name ?? "Group"} src={preview.avatarUrl} size="lg" className="mb-4" />
            <h1 className="text-lg font-bold text-foreground mb-1 text-center font-sans">
              {preview.name ?? "Group"}
            </h1>
            <p className="text-xs text-text-muted select-none font-sans mb-8 text-center">
              {preview.isMember
                ? "You're already a member of this group."
                : "You've been invited to join this group."}
            </p>

            {errorMessage && (
              <p className="text-xs text-red-600 font-sans text-center mb-4">{errorMessage}</p>
            )}

            {preview.isMember ? (
              <Button variant="primary" className="w-full" onClick={() => router.push(`/chat/${preview.roomId}`)}>
                Open Chat
              </Button>
            ) : (
              <div className="w-full flex gap-3">
                <Button
                  variant="secondary"
                  className="flex-1"
                  disabled={status === "joining"}
                  onClick={() => router.push("/")}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  className="flex-1"
                  disabled={status === "joining"}
                  onClick={handleAccept}
                >
                  {status === "joining" ? "Joining..." : "Accept"}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
