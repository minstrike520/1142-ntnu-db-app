import { getApiBaseUrl } from "./api";

export const resolveAssetUrl = (value?: string): string | undefined => {
  if (!value) {
    return undefined;
  }

  if (
    value.startsWith("http://") ||
    value.startsWith("https://") ||
    value.startsWith("blob:") ||
    value.startsWith("data:")
  ) {
    return value;
  }

  if (value.startsWith("/")) {
    return `${getApiBaseUrl()}${value}`;
  }

  return value;
};
