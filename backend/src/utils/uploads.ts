import fs from "fs";
import path from "path";

export const UPLOADS_ROOT_DIR = path.resolve(process.cwd(), "uploads");
export const ATTACHMENTS_UPLOAD_DIR = path.join(UPLOADS_ROOT_DIR, "attachments");
export const AVATARS_UPLOAD_DIR = path.join(UPLOADS_ROOT_DIR, "avatars");

export const ensureUploadDirectories = (): void => {
  for (const dir of [UPLOADS_ROOT_DIR, ATTACHMENTS_UPLOAD_DIR, AVATARS_UPLOAD_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
};
