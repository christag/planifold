import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests drive the built app in a real Chrome.
 * Point PW_BASE_URL at a running Piecewise (default http://localhost:3210).
 * The first run completes setup; later runs sign in with the same account.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: process.env.PW_BASE_URL ?? "http://localhost:3210",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], channel: "chrome", viewport: { width: 1440, height: 900 } } },
    { name: "mobile", use: { ...devices["Pixel 7"], channel: "chrome" }, dependencies: ["desktop"] },
  ],
});
