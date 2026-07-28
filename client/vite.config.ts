import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // `npm run dev` in client/ proxies API calls to the Node server so the
    // React dev server and the API share an origin (no CORS, same bearer flow).
    proxy: {
      "/api": "http://127.0.0.1:8080",
    },
  },
});
