import { defineConfig } from '@playwright/test';

// Node-only specs (no browser, no dev server): protocol, rooms, limits and the
// built game server. `npm run test:server`. The main config runs them too.
export default defineConfig({
  testDir: './tests',
  testMatch: ['server.spec.ts', 'serverE2e.spec.ts', 'combatSim.spec.ts'],
  timeout: 120 * 1000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results/artifacts-node',
});
