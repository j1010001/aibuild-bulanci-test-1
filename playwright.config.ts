import { defineConfig } from '@playwright/test';

// The e2e smoke test (spec §15) runs its own game server and Vite on dedicated ports, so
// it never collides with a dev setup already running on 8787 / 5173.
const SERVER_PORT = 8797;
const WEB_PORT = 5197;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${WEB_PORT}`, headless: true },
  webServer: [
    {
      command: 'npx tsx server/index.ts',
      env: { SERVER_PORT: String(SERVER_PORT) },
      url: `http://localhost:${SERVER_PORT}/health`,
      reuseExistingServer: false,
    },
    {
      command: `npx vite --port ${WEB_PORT} --strictPort`,
      env: { VITE_SERVER_URL: `ws://localhost:${SERVER_PORT}` },
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
    },
  ],
});
