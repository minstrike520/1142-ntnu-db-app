import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current working directory.
  // Set the third parameter to '' to load all env regardless of the `VITE_` prefix.
  const env = loadEnv(mode, process.cwd(), '');
  
  return {
    plugins: [react(), tailwindcss()],
    server: {
      host: "0.0.0.0",
      port: 3000,
      allowedHosts: env.VITE_ALLOWED_HOST ? [env.VITE_ALLOWED_HOST] : undefined,
    },
  };
});
