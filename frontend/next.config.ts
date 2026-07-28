import type { NextConfig } from "next";
import packageInfo from "../package.json";
import { execSync } from "child_process";

let buildVersion = packageInfo.version;
try {
  const gitSha = execSync("git rev-parse --short HEAD").toString().trim();
  buildVersion = `${packageInfo.version}-${gitSha}`;
} catch {
  // Fallback to package.json version if git is not available
}

const allowedDevOrigins = process.env.ALLOWED_DEV_ORIGINS
  ? process.env.ALLOWED_DEV_ORIGINS.split(",").map((origin) => origin.trim())
  : ["laptop.tail544a05.ts.net"];

const nextConfig: NextConfig = {
  /* config options here */
  allowedDevOrigins,
  output: "standalone",
  reactCompiler: true,
  env: {
    NEXT_PUBLIC_APP_VERSION: buildVersion,
  },
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          {
            key: "Content-Type",
            value: "application/javascript; charset=utf-8",
          },
          {
            key: "Cache-Control",
            value: "no-cache, no-store, must-revalidate",
          },
          {
            key: "Content-Security-Policy",
            value: "default-src 'self'; script-src 'self'",
          },
          {
            key: "Service-Worker-Allowed",
            value: "/",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
