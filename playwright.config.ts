import { defineConfig } from "@playwright/test";

const port = process.env.CLAWSEMBLY_TEST_PORT ?? "4173";
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests",
  use: {
    baseURL,
    headless: true
  },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port}`,
    env: {
      CLAWSEMBLY_LIVE_PROVIDER_API_KEY: ""
    },
    url: baseURL,
    reuseExistingServer: false
  }
});
