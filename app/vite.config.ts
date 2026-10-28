import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

export default defineConfig({
  plugins: [react()],
  // The release workflow refuses a tag that doesn't match this, so the app,
  // the APK's versionName and the GitHub release always agree.
  define: { __APP_VERSION__: JSON.stringify(version) },
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
