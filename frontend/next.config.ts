import type { NextConfig } from "next";
import packageInfo from "../package.json";

const allowedDevOrigins = process.env.ALLOWED_DEV_ORIGINS
  ? process.env.ALLOWED_DEV_ORIGINS.split(",").map((origin) => origin.trim())
  : ["laptop.tail544a05.ts.net"];

const nextConfig: NextConfig = {
  /* config options here */
  allowedDevOrigins,
  output: 'standalone',
  reactCompiler: true,
  env: {
    NEXT_PUBLIC_APP_VERSION: packageInfo.version,
  },
};

export default nextConfig;
