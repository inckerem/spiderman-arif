/** Builds and starts the real game server (dist-server/server.mjs) for Node-only specs. */
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface ServerProc {
  proc: ChildProcess;
  base: string;
  wsUrl: string;
  /** Everything the server printed so far. */
  log(): string;
  stop(): Promise<number | null>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Builds dist/ (when missing) and the server bundle (`build` false skips both). */
export function buildAll(build = true): void {
  if (!build) return;
  if (!fs.existsSync(path.join(ROOT, 'dist/index.html'))) execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });
  execSync('npm run build:server', { cwd: ROOT, stdio: 'inherit' });
}

/** Starts the built server on a free port with `args` (CLI flags) and waits until it listens. */
export async function startServerProc(args: string[]): Promise<ServerProc> {
  let log = '';
  const proc = spawn(process.execPath, ['dist-server/server.mjs', '--port=0', '--host=127.0.0.1', ...args], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '', STATIC_DIR: '', SIM: '' },
  });
  proc.stdout!.on('data', (d) => (log += d));
  proc.stderr!.on('data', (d) => (log += d));
  const t0 = Date.now();
  while (!/listening .*"port":(\d+)/.test(log)) {
    if (Date.now() - t0 > 30_000 || proc.exitCode !== null) {
      if (proc.exitCode === null) proc.kill('SIGKILL');
      throw new Error(`server did not start (it must log "listening" at level info):\n${log}`);
    }
    await sleep(50);
  }
  const port = Number(/listening .*"port":(\d+)/.exec(log)![1]);
  return {
    proc,
    base: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    log: () => log,
    stop: async () => {
      if (proc.exitCode !== null) return proc.exitCode;
      const exited = new Promise<number | null>((r) => proc.once('exit', (code) => r(code)));
      proc.kill('SIGTERM');
      const code = await Promise.race([exited, sleep(5000).then(() => null)]);
      if (proc.exitCode === null) proc.kill('SIGKILL');
      return code;
    },
  };
}
