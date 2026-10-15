import { defineConfig } from '@playwright/test';

// SKYTHREAD_DEV_PORT overrides the dev server port (default 5173) so several checkouts can run at once.
const PORT = Number(process.env.SKYTHREAD_DEV_PORT) || 5173;

// Tests drive the dev build through window.__game. Software GL in a sandbox is
// not representative of real GPU frame rates, so the suite measures simulation
// time, draw calls, triangles and memory instead of FPS.
export default defineConfig({
  testDir: './tests',
  timeout: 30 * 60 * 1000,
  expect: { timeout: 60 * 1000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results/artifacts',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1280, height: 720 },
    launchOptions: {
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--ignore-gpu-blocklist',
        '--autoplay-policy=no-user-gesture-required',
        '--enable-precise-memory-info',
        '--js-flags=--expose-gc',
      ],
    },
  },
  webServer: {
    command: 'npm run dev',
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: true,
    timeout: 120 * 1000,
  },
});
