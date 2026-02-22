import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const PB_PORT = Number(process.env.PROWORKBENCH_PORT || 8787);
const PB_TARGET = `http://127.0.0.1:${PB_PORT}`;

export default defineConfig({
  appType: "spa",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/admin": { target: PB_TARGET },
      "/health": { target: PB_TARGET },
      "/api": { target: PB_TARGET },
      "/plugins": { target: PB_TARGET },
      "/v1": { target: "http://127.0.0.1:5000" },
      "/ws": { target: PB_TARGET, ws: true },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true
  }
});
