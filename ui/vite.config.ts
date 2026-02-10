import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  appType: "spa",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/admin": { target: "http://127.0.0.1:8787" },
      "/health": { target: "http://127.0.0.1:8787" },
      "/api": { target: "http://127.0.0.1:8787" },
      "/v1": { target: "http://127.0.0.1:5000" },
      "/ws": { target: "http://127.0.0.1:8787", ws: true },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true
  }
});
