import { fetchAttachmentBlob } from "@/lib/api";

export type FileDownloadPlatform = "web" | "pwa" | "tauri" | "capacitor" | "unknown";
export type NativeFileDownloadPlatform = Extract<FileDownloadPlatform, "tauri" | "capacitor">;

export interface FileDownloaderAdapter {
  download(fileUrl: string, filename: string): Promise<void>;
}

type CapacitorRuntime = {
  getPlatform?: () => string;
  isNativePlatform?: () => boolean;
};

type DownloadRuntime = typeof globalThis & {
  __TAURI__?: unknown;
  __TAURI_INTERNALS__?: unknown;
  Capacitor?: CapacitorRuntime;
};

const nativeAdapters = new Map<NativeFileDownloadPlatform, FileDownloaderAdapter>();

const isCapacitorNative = (capacitor: CapacitorRuntime | undefined): boolean => {
  if (!capacitor) return false;

  try {
    if (capacitor.isNativePlatform?.()) return true;
    const platform = capacitor.getPlatform?.();
    return !!platform && platform !== "web";
  } catch {
    return false;
  }
};

const detectPlatform = (): FileDownloadPlatform => {
  const runtime = globalThis as DownloadRuntime;

  if (runtime.__TAURI_INTERNALS__ || runtime.__TAURI__) return "tauri";
  if (isCapacitorNative(runtime.Capacitor)) return "capacitor";

  if (typeof window === "undefined" || typeof document === "undefined") {
    return "unknown";
  }

  const navigatorWithStandalone =
    typeof navigator === "undefined"
      ? undefined
      : (navigator as Navigator & { standalone?: boolean });
  if (
    navigatorWithStandalone?.standalone === true ||
    window.matchMedia?.("(display-mode: standalone)").matches
  ) {
    return "pwa";
  }

  return "web";
};

const browserDownloader: FileDownloaderAdapter = {
  async download(fileUrl, filename) {
    if (
      typeof document === "undefined" ||
      typeof URL === "undefined" ||
      typeof URL.createObjectURL !== "function" ||
      typeof URL.revokeObjectURL !== "function" ||
      !document.body
    ) {
      throw new Error("File downloads are not supported in this environment");
    }

    const blob = await fetchAttachmentBlob(fileUrl);
    let downloadUrl: string | null = null;
    let link: HTMLAnchorElement | null = null;

    try {
      downloadUrl = URL.createObjectURL(blob);
      link = document.createElement("a");
      link.href = downloadUrl;
      link.download = filename;
      link.style.display = "none";
      document.body.appendChild(link);
      link.click();
    } finally {
      link?.remove();
      if (downloadUrl) {
        const objectUrl = downloadUrl;
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
      }
    }
  },
};

export class FileDownloaderBridge {
  static detectPlatform(): FileDownloadPlatform {
    return detectPlatform();
  }

  static registerAdapter(
    platform: NativeFileDownloadPlatform,
    adapter: FileDownloaderAdapter,
  ): () => void {
    nativeAdapters.set(platform, adapter);

    return () => {
      if (nativeAdapters.get(platform) === adapter) {
        nativeAdapters.delete(platform);
      }
    };
  }

  static async download(fileUrl: string, filename: string): Promise<void> {
    const platform = detectPlatform();
    const nativeAdapter =
      platform === "tauri" || platform === "capacitor"
        ? nativeAdapters.get(platform)
        : undefined;

    if (nativeAdapter) {
      await nativeAdapter.download(fileUrl, filename);
      return;
    }

    await browserDownloader.download(fileUrl, filename);
  }
}
