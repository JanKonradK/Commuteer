import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  // The bundle includes the ~450 KB delay model, so it's larger than a typical app.
  build: { chunkSizeWarningLimit: 900 },
  server: {
    // In the browser, Irish Rail's API would be blocked by CORS, so the dev server
    // proxies it. On the phone, Capacitor's native HTTP calls the API directly.
    proxy: {
      "/irishrail": {
        target: "https://api.irishrail.ie",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/irishrail/, ""),
      },
    },
  },
  test: {
    environment: "happy-dom",
    globals: true,
  },
});
