import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// During development the React app is served on :5173 and talks to the
// FastAPI service on :8000 through this proxy. Production builds are served
// directly by the backend from frontend/dist.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
      },
    },
  },
});
