/**
 * SKYTHREAD game server entry (built to dist-server/server.mjs by
 * `npm run build:server`). Configuration: environment variables, see
 * server/config.ts and the README deploy section.
 */
import fs from 'node:fs';
import { loadConfig } from './config';
import { createLog } from './log';
import { startServer } from './app';

function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function main(): Promise<void> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    console.error(`Configuration error: ${(e as Error).message}`);
    process.exit(2);
  }
  const log = createLog(cfg.logLevel);
  const server = await startServer(cfg, { version: readVersion(), log });
  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log.info('shutting down', { signal });
    const force = setTimeout(() => process.exit(0), 3000);
    force.unref();
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
