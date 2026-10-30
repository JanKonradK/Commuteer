import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.jankonradk.commuteer",
  appName: "Commuteer",
  webDir: "dist",
  plugins: {
    // Route fetch() through Android's native networking: no CORS, so the app
    // can call the Irish Rail API directly without a server in between.
    CapacitorHttp: { enabled: true },
    // Light status/navigation icons on the app's black background; the web view draws
    // edge to edge and pads itself with env(safe-area-inset-*).
    SystemBars: { style: "DARK", initialViewportFitValueHint: "cover" },
  },
};

export default config;
