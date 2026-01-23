import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: "clients/web",
  server: {
    proxy: {
      "/chat": "http://localhost:3000",
    },
  },
});
