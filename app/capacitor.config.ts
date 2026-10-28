import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.jankonradk.commuteer",
  appName: "Commuteer",
  webDir: "dist",
  plugins: {
    // Route fetch() through Android's native networking: no CORS, so the app
    // can call the Irish Rail API directly without a server in between.
    CapacitorHttp: { enabled: true },
  },
};

export default config;
