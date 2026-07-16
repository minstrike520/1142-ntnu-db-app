import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Near Chat",
    short_name: "Near",
    description: "Near Chat Application",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#faf9fe",
    theme_color: "#007aff",
    icons: [
      {
        src: "/icons/icon-192x192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512x512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
    ],
  };
}
