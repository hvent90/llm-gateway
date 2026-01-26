import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const port = Number(process.env.VITE_PORT) || 5173;
const backendUrl = process.env.VITE_BACKEND_URL || "http://localhost:4000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: "clients/web",
  server: {
    host: true,
    port,
    proxy: {
      "/chat": backendUrl,
    },
    allowedHosts: [
      "mini.local"
    ]
  },
});
