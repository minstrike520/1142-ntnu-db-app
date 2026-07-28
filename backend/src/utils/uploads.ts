import path from "path";

export const UPLOADS_ROOT_DIR = path.resolve(process.cwd(), "uploads");
export const ATTACHMENTS_UPLOAD_DIR = path.join(UPLOADS_ROOT_DIR, "attachments");
export const AVATARS_UPLOAD_DIR = path.join(UPLOADS_ROOT_DIR, "avatars");

export const ensureUploadDirectories = async (): Promise<void> => {
  for (const dir of [ATTACHMENTS_UPLOAD_DIR, AVATARS_UPLOAD_DIR]) {
    await Bun.write(path.join(dir, ".gitkeep"), "");
  }
};
