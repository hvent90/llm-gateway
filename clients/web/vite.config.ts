import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: "clients/web",
  server: {
    proxy: {
      "/chat": "http://localhost:3000",
    },
  },
});
