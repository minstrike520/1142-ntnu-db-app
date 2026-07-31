import { getApiBaseUrl } from "./api";

export const resolveAssetUrl = (value?: string): string | undefined => {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    if (trimmed.startsWith("/")) {
      return new URL(trimmed, getApiBaseUrl()).toString();
    }

    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "blob:") {
      return parsed.toString();
    }
  } catch {
    return undefined;
  }

  return undefined;
};
