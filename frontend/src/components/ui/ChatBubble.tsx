import React, { useEffect, useState } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import { cn } from "@/lib/utils";
import { Avatar } from "./Avatar";
import ProfilePopover from "../chat/ProfilePopover";
import { downloadAttachment, fetchAttachmentBlobUrl } from "@/lib/api";
import { useChat } from "@/context/ChatContext";

export interface Attachment {
  filename: string;
  filetype: string;
  url?: string;
}

export interface ChatBubbleProps {
  content: string;
  senderName: string;
  timestamp: string;
  isOutgoing?: boolean;
  isHighEmphasis?: boolean;
  isRecalled?: boolean;
  replyTo?: {
    senderName: string;
    content: string;
  };
  attachments?: Attachment[];
  senderAvatar?: string;
  isRead?: boolean;
  onReply?: () => void;
  onRecall?: () => void;
  onEdit?: () => void;
  canRecall?: boolean;
  canEdit?: boolean;
  senderId?: string;
  messageId?: string;
  avatarName?: string;
  searchHighlight?: string;
}

const highlightText = (text: string, query: string): React.ReactNode => {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  if (!lowerText.includes(lowerQuery)) return text;
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let idx = lowerText.indexOf(lowerQuery);
  while (idx !== -1) {
    if (idx > last) nodes.push(text.slice(last, idx));
    nodes.push(
      <mark key={idx} className="bg-amber-300/60 dark:bg-amber-600/50 text-foreground not-italic rounded-[2px] px-0.5">
        {text.slice(idx, idx + query.length)}
      </mark>,
    );
    last = idx + query.length;
    idx = lowerText.indexOf(lowerQuery, last);
  }
  if (last < text.length) nodes.push(text.slice(last));
  return <>{nodes}</>;
};

const renderMentionContent = (
  content: string,
  isOutgoing: boolean,
  isHighEmphasis: boolean,
  searchHighlight?: string,
) => {
  const parts = content.split(/(@[^\s@]+)/g);
  const mentionClass = isOutgoing && isHighEmphasis
    ? "rounded px-1 py-0.5 bg-white/15 text-white font-semibold"
    : "rounded px-1 py-0.5 bg-primary/10 text-primary font-semibold";

  return parts.map((part, index) =>
    part.startsWith("@") ? (
      <span key={`${part}-${index}`} className={mentionClass}>
        {part}
      </span>
    ) : (
      <React.Fragment key={`${part}-${index}`}>
        {searchHighlight ? highlightText(part, searchHighlight) : part}
      </React.Fragment>
    ),
  );
};

function ImageAttachmentPreview({
  file,
  isOutgoing,
  isHighEmphasis,
  onDownload,
  isDownloading,
}: {
  file: Attachment;
  isOutgoing: boolean;
  isHighEmphasis: boolean;
  onDownload: () => void;
  isDownloading: boolean;
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(!!file.url);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    if (!file.url) {
      setIsLoading(false);
      return;
    }
    let objectUrl: string | null = null;
    setIsLoading(true);
    setHasError(false);
    fetchAttachmentBlobUrl(file.url)
      .then((url) => {
        objectUrl = url;
        setBlobUrl(url);
      })
      .catch(() => setHasError(true))
      .finally(() => setIsLoading(false));
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file.url]);

  const fallbackClassName = cn(
    "flex w-full items-center gap-2.5 p-2 border rounded-sm text-xs cursor-pointer select-none transition-colors text-left disabled:cursor-wait disabled:opacity-70",
    isOutgoing && isHighEmphasis
      ? "bg-white/10 border-white/20 hover:bg-white/20 text-white"
      : "bg-surface-card border-border-secondary hover:border-border-primary text-foreground",
  );
  const labelClass = cn(
    "text-[9px] uppercase tracking-wider font-mono mt-0.5 truncate",
    isOutgoing && isHighEmphasis ? "text-white/60" : "text-text-muted",
  );
  const clipIcon = (
    <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
    </svg>
  );

  if (isLoading) {
    return (
      <div
        className={cn(
          "rounded-sm w-48 h-32 animate-pulse",
          isOutgoing && isHighEmphasis ? "bg-white/20" : "bg-surface-muted",
        )}
      />
    );
  }

  if (hasError || !blobUrl) {
    return (
      <button
        type="button"
        onClick={onDownload}
        disabled={isDownloading}
        className={fallbackClassName}
        title={isDownloading ? "Downloading attachment" : "Download attachment"}
      >
        {clipIcon}
        <div className="flex-1 min-w-0">
          <p className="font-medium truncate leading-tight">{file.filename}</p>
          <p className={labelClass}>{file.filetype}</p>
        </div>
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <img
        src={blobUrl}
        alt={file.filename}
        className="max-w-full max-h-64 rounded-sm object-contain cursor-pointer"
        onClick={onDownload}
        title="Click to download"
      />
      <p className={cn("text-[9px] font-mono truncate", isOutgoing && isHighEmphasis ? "text-white/60" : "text-text-muted")}>
        {file.filename}
      </p>
    </div>
  );
}

export function ChatBubble({
  content,
  senderName,
  timestamp,
  isOutgoing = false,
  isHighEmphasis = false,
  isRecalled = false,
  replyTo,
  attachments = [],
  senderAvatar,
  onReply,
  onRecall,
  onEdit,
  canRecall = false,
  canEdit = false,
  senderId,
  messageId,
  avatarName,
  searchHighlight,
}: ChatBubbleProps) {
  const { t } = useTranslation();
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties>({});
  const [downloadingUrl, setDownloadingUrl] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState("");

  const { activeProfilePopover, setActiveProfilePopover } = useChat();
  const showPopover = messageId ? activeProfilePopover?.instanceId === messageId : false;

  useEffect(() => {
    if (!menuPosition) return;
    const close = () => setMenuPosition(null);
    window.addEventListener("click", close);
    window.addEventListener("keydown", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [menuPosition]);

  const handleTogglePopover = (event: React.MouseEvent) => {
    if (!senderId) {
      console.warn("No senderId provided to ChatBubble, cannot open profile popover");
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const scrollEl = event.currentTarget.closest(".overflow-y-auto");

    if (scrollEl) {
      const parentRect = scrollEl.getBoundingClientRect();
      const relativeTop = rect.top - parentRect.top + rect.height / 2;
      const halfPopover = 200;
      const padding = 12;
      let topVal = relativeTop;

      if (parentRect.height <= halfPopover * 2 + padding * 2) {
        topVal = parentRect.height / 2;
      } else if (topVal - halfPopover < padding) {
        topVal = halfPopover + padding;
      } else if (topVal + halfPopover > parentRect.height - padding) {
        topVal = parentRect.height - halfPopover - padding;
      }

      const offsetTop = topVal - relativeTop;
      setPopoverStyle({
        top: `calc(50% + ${offsetTop}px)`,
        transform: "translateY(-50%)",
      });
    }

    if (messageId) {
      if (activeProfilePopover?.instanceId === messageId) {
        setActiveProfilePopover(null);
      } else {
        setActiveProfilePopover({ instanceId: messageId, userId: senderId });
      }
    }
  };

  const handleCopy = async () => {
    if (!content || isRecalled) return;
    await navigator.clipboard?.writeText(content);
    setMenuPosition(null);
  };

  const handleDownloadAttachment = async (file: Attachment) => {
    if (!file.url || downloadingUrl) return;

    setDownloadError("");
    setDownloadingUrl(file.url);

    try {
      await downloadAttachment(file.url, file.filename);
    } catch (error) {
      console.error(error);
      setDownloadError(error instanceof Error ? error.message : "Failed to download attachment");
    } finally {
      setDownloadingUrl(null);
    }
  };

  const menuItemClass =
    "w-full px-3 py-2 text-left text-xs hover:bg-surface-muted disabled:cursor-not-allowed disabled:text-text-muted disabled:hover:bg-transparent";

  return (
    <div
      className={cn(
        "flex gap-2 max-w-[85%] font-sans",
        isOutgoing ? "self-end flex-row-reverse" : "self-start flex-row",
      )}
    >
      {!isOutgoing && (
        <div
          className={cn(
            "shrink-0 mt-1 relative cursor-pointer avatar-click-target",
            showPopover && "z-20"
          )}
          onClick={handleTogglePopover}
        >
          <Avatar name={avatarName || senderName} src={senderAvatar} size="sm" />
          {showPopover && (
            <ProfilePopover
              userId={senderId || ""}
              username={senderName}
              onClose={(event) => {
                event.stopPropagation();
                setActiveProfilePopover(null);
              }}
              position="custom"
              className="absolute left-full ml-3"
              style={popoverStyle}
            />
          )}
        </div>
      )}

      <div className={cn("flex flex-col gap-1", isOutgoing ? "items-end" : "items-start")}>
        {!isOutgoing && (
          <span
            onClick={handleTogglePopover}
            className="text-xs font-semibold text-text-muted select-none cursor-pointer hover:underline avatar-click-target"
          >
            {senderName}
          </span>
        )}

        <div className="flex items-end gap-1.5">
          {isOutgoing && (
            <div className="flex flex-col items-end text-[10px] text-text-muted font-mono leading-none select-none mb-0.5">
              <span>{timestamp}</span>
            </div>
          )}

          <div
            onContextMenu={(event) => {
              event.preventDefault();
              if (!isRecalled) {
                setMenuPosition({ x: event.clientX, y: event.clientY });
              }
            }}
            className={cn(
              "border rounded-sm p-3 relative flex flex-col gap-2 max-w-md md:max-w-lg",
              isOutgoing
                ? isHighEmphasis
                  ? "bg-primary border-primary text-white"
                  : "bg-surface-muted border-border-primary text-foreground"
                : "bg-surface-card border-border-primary text-foreground",
            )}
          >
            {replyTo && (
              <div
                className={cn(
                  "border-l-2 pl-2 text-xs mb-1 select-none",
                  isOutgoing && isHighEmphasis
                    ? "border-white/50 text-white/80"
                    : "border-primary text-text-muted",
                )}
              >
                <span className="font-bold block">{replyTo.senderName}</span>
                <span className="line-clamp-1">{replyTo.content}</span>
              </div>
            )}

            <div
              className={cn(
                "text-sm break-words whitespace-pre-wrap",
                isRecalled && "italic text-text-muted/70",
              )}
            >
              {isRecalled ? t("chatroom.messageRecalled") : renderMentionContent(content, isOutgoing, isHighEmphasis, searchHighlight)}
            </div>

            {attachments.length > 0 && (
              <div className="flex flex-col gap-1.5 mt-1 border-t border-border-secondary/40 pt-2">
                {attachments.map((file, idx) => {
                  const isImage = file.filetype?.startsWith("image/");

                  if (isImage) {
                    return (
                      <ImageAttachmentPreview
                        key={idx}
                        file={file}
                        isOutgoing={isOutgoing}
                        isHighEmphasis={isHighEmphasis}
                        onDownload={() => void handleDownloadAttachment(file)}
                        isDownloading={downloadingUrl === file.url}
                      />
                    );
                  }

                  const fileContent = (
                    <>
                      <svg
                        className="h-4 w-4 shrink-0"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"
                        />
                      </svg>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate leading-tight">{file.filename}</p>
                        <p
                          className={cn(
                            "text-[9px] uppercase tracking-wider font-mono mt-0.5",
                            isOutgoing && isHighEmphasis ? "text-white/60" : "text-text-muted",
                          )}
                        >
                          {file.filetype}
                        </p>
                      </div>
                    </>
                  );

                  const className = cn(
                    "flex w-full items-center gap-2.5 p-2 border rounded-sm text-xs cursor-pointer select-none transition-colors",
                    isOutgoing && isHighEmphasis
                      ? "bg-white/10 border-white/20 hover:bg-white/20 text-white"
                      : "bg-surface-card border-border-secondary hover:border-border-primary text-foreground",
                  );

                  return file.url ? (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => void handleDownloadAttachment(file)}
                      disabled={downloadingUrl === file.url}
                      className={cn(
                        className,
                        "text-left disabled:cursor-wait disabled:opacity-70",
                      )}
                      title={downloadingUrl === file.url ? t("chatroom.downloadingAttachment") : t("chatroom.downloadAttachment")}
                    >
                      {fileContent}
                    </button>
                  ) : (
                    <div key={idx} className={className}>
                      {fileContent}
                    </div>
                  );
                })}
                {downloadError && (
                  <p className="text-[10px] text-danger select-none">
                    {downloadError}
                  </p>
                )}
              </div>
            )}
          </div>

          {menuPosition && (
            <div
              className="fixed z-50 min-w-32 border border-border-primary bg-surface-card text-foreground shadow-lg rounded-sm overflow-hidden"
              style={{ left: menuPosition.x, top: menuPosition.y }}
              onClick={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                className={menuItemClass}
                onClick={() => {
                  onReply?.();
                  setMenuPosition(null);
                }}
              >
                {t("chatroom.replyMessage")}
              </button>
              <button
                type="button"
                className={menuItemClass}
                disabled={!canEdit}
                onClick={() => {
                  onEdit?.();
                  setMenuPosition(null);
                }}
              >
                {t("chatroom.editMessage")}
              </button>
              <button
                type="button"
                className={menuItemClass}
                disabled={!canRecall}
                onClick={() => {
                  onRecall?.();
                  setMenuPosition(null);
                }}
              >
                {t("chatroom.recallMessage")}
              </button>
              <button type="button" className={menuItemClass} onClick={handleCopy}>
                {t("chatroom.copyText")}
              </button>
            </div>
          )}

          {!isOutgoing && (
            <span className="text-[10px] text-text-muted font-mono leading-none select-none mb-0.5">
              {timestamp}
            </span>
          )}
        </div>

      </div>
    </div>
  );
}
