// SKYTHREAD launcher: installs the npm packages when needed, builds the game
// when its sources changed, serves the production build on 127.0.0.1 and opens
// the default browser. BASLAT-Windows.bat, BASLAT-Mac.command and
// BASLAT-Linux.sh start it once they have found or downloaded a suitable
// Node.js; it can also be run directly: node scripts/launch.mjs [options]
//
//   --dev        Vite dev server with hot reload instead of the production build
//   --no-open    do not open the browser
//   --rebuild    build even if the sources did not change
//   --reinstall  reinstall the npm packages
//   --check      start, verify that the page and its files are served, then exit
//   --sunucu     serve with the game server (dist-server/server.mjs) instead of
//                vite preview: the game and multiplayer rooms on one port,
//                reachable from the local network (phones on the same Wi-Fi)
//
// Console text is Turkish, like the rest of the player-facing interface.

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const nodeCheck = require('./check-node.cjs');

// Files whose content decides whether dist/ is current.
const BUILD_INPUTS = ['index.html', 'vite.config.ts', 'tsconfig.json', 'package-lock.json', 'src', 'public'];
const INSTALL_STAMP = join('node_modules', '.skythread-install');
const BUILD_STAMP = join('dist', '.skythread-build');
// The game server bundle also depends on these.
const SERVER_INPUTS = [...BUILD_INPUTS, 'server', 'vite.server.config.ts', 'tsconfig.server.json'];
const SERVER_STAMP = join('dist-server', '.skythread-build');
const PREVIEW_PORT = 4173;
const DEV_PORT = 5173;

const USAGE = `Kullanım: node scripts/launch.mjs [seçenekler]
  --dev        geliştirme sunucusu (anlık yeniden yükleme)
  --no-open    tarayıcıyı açma
  --rebuild    değişiklik olmasa da yeniden derle
  --reinstall  paketleri yeniden kur
  --check      başlat, sayfanın sunulduğunu doğrula ve çık
  --sunucu     oyun sunucusuyla başlat (çok oyunculu odalar; aynı ağdaki
               telefon ve bilgisayarlar da bağlanabilir)`;

class LaunchError extends Error {}

const say = (text = '') => console.log(text);
const seconds = (t0) => ((Date.now() - t0) / 1000).toFixed(1);

function parseArgs(argv) {
  const flags = { dev: false, open: true, rebuild: false, reinstall: false, check: false, server: false };
  for (const arg of argv) {
    if (arg === '--dev') flags.dev = true;
    else if (arg === '--no-open') flags.open = false;
    else if (arg === '--rebuild') flags.rebuild = true;
    else if (arg === '--reinstall') flags.reinstall = true;
    else if (arg === '--check') flags.check = true;
    else if (arg === '--sunucu') flags.server = true;
    else if (arg === '--help' || arg === '-h') {
      say(USAGE);
      process.exit(0);
    } else {
      throw new LaunchError(`Bilinmeyen seçenek: ${arg}\n${USAGE}`);
    }
  }
  if (flags.dev && flags.server) throw new LaunchError('--dev ve --sunucu birlikte kullanılamaz.');
  return flags;
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// Runs npm with the Node.js that runs this script.
function npm(args) {
  const cli = nodeCheck.npmCliPath();
  const result = cli
    ? spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit' })
    : spawnSync('npm', args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error) say(`npm çalıştırılamadı: ${result.error.message}`);
  return result.status ?? 1;
}

// npm ci when the lockfile, the platform or the CPU changed since the last
// install (or node_modules is missing).
function ensurePackages(force) {
  const want = `${sha256File('package-lock.json')} ${process.platform}-${process.arch}`;
  const have = existsSync(INSTALL_STAMP) ? readFileSync(INSTALL_STAMP, 'utf8').trim() : '';
  if (!force && have === want && existsSync(join('node_modules', 'vite', 'package.json'))) return;
  say('Paketler kuruluyor (ilk seferde 1-3 dakika sürebilir)...');
  const t0 = Date.now();
  // --ignore-scripts: the only install script in the tree is fsevents'
  // `node-gyp rebuild`, which would need Xcode tools on macOS; the package
  // already ships its prebuilt binary. --include keeps Vite (a dev dependency)
  // and the platform binaries even if NODE_ENV=production or an .npmrc omits them.
  const args = ['ci', '--include=dev', '--include=optional', '--ignore-scripts', '--no-audit', '--no-fund'];
  let ok = npm(args) === 0;
  if (!ok) {
    say('Kurulum tamamlanamadı, bir kez daha deneniyor...');
    ok = npm(args) === 0;
  }
  if (!ok) throw new LaunchError('npm paketleri kurulamadı. İnternet bağlantınızı kontrol edip tekrar deneyin.');
  writeFileSync(INSTALL_STAMP, `${want}\n`);
  say(`Paketler hazır (${seconds(t0)} sn).`);
}

function sourceHash(inputs = BUILD_INPUTS) {
  const hash = createHash('sha256');
  const walk = (path) => {
    if (statSync(path).isDirectory()) {
      for (const name of readdirSync(path).sort()) {
        if (!name.startsWith('.')) walk(join(path, name));
      }
    } else {
      hash.update(path.replaceAll('\\', '/')).update('\0').update(readFileSync(path)).update('\0');
    }
  };
  for (const input of inputs) if (existsSync(input)) walk(input);
  return hash.digest('hex');
}

// Production build when dist/ is missing or was built from other sources. Uses
// Vite directly: the type check of `npm run build` is a development step.
async function ensureBuild(force) {
  const hash = sourceHash();
  const current =
    existsSync(join('dist', 'index.html')) && existsSync(BUILD_STAMP) && readFileSync(BUILD_STAMP, 'utf8').trim() === hash;
  if (current && !force) return;
  say('Oyun derleniyor (10-60 saniye)...');
  const t0 = Date.now();
  const { build } = await import('vite');
  await build({ root: ROOT, logLevel: 'warn' });
  writeFileSync(BUILD_STAMP, `${hash}\n`);
  say(`Derleme tamam (${seconds(t0)} sn).`);
}

// Game server bundle (dist-server/server.mjs) when missing or built from other sources.
async function ensureServerBuild(force) {
  const hash = sourceHash(SERVER_INPUTS);
  const current = existsSync(join('dist-server', 'server.mjs')) && existsSync(SERVER_STAMP) && readFileSync(SERVER_STAMP, 'utf8').trim() === hash;
  if (current && !force) return;
  say('Oyun sunucusu derleniyor...');
  const t0 = Date.now();
  const { build } = await import('vite');
  await build({ root: ROOT, configFile: join(ROOT, 'vite.server.config.ts'), logLevel: 'warn' });
  writeFileSync(SERVER_STAMP, `${hash}\n`);
  say(`Sunucu derlemesi tamam (${seconds(t0)} sn).`);
}

// First free TCP port from `start` on all interfaces.
function freePort(start) {
  const tryPort = (port) =>
    new Promise((resolve) => {
      const probe = createServer();
      probe.once('error', () => resolve(false));
      probe.listen(port, '0.0.0.0', () => probe.close(() => resolve(true)));
    });
  return (async () => {
    for (let p = start; p < start + 50; p++) if (await tryPort(p)) return p;
    throw new LaunchError(`${start}-${start + 49} arasında boş port bulunamadı.`);
  })();
}

// IPv4 addresses other devices on the local network can use.
function lanAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

// The game server (static dist/ plus /ws rooms) on 0.0.0.0 so phones and other
// computers on the same network can join; the console shows its addresses.
async function serveGameServer() {
  const port = await freePort(PREVIEW_PORT);
  const child = spawn(
    process.execPath,
    ['dist-server/server.mjs', `--port=${port}`, '--host=0.0.0.0', '--static=dist', '--log-level=warn'],
    { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] },
  );
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const url = `http://127.0.0.1:${port}/`;
  const t0 = Date.now();
  for (;;) {
    if (child.exitCode !== null) throw new LaunchError('Oyun sunucusu başlatılamadı.');
    try {
      if ((await fetch(`${url}healthz`)).ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() - t0 > 30000) {
      child.kill();
      throw new LaunchError('Oyun sunucusu 30 saniyede yanıt vermedi.');
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return {
    url,
    lan: lanAddresses().map((a) => `http://${a}:${port}/`),
    close: () => {
      if (child.exitCode === null) child.kill('SIGTERM');
      return Promise.race([exited, new Promise((r) => setTimeout(r, 4000))]);
    },
  };
}

async function serve(dev) {
  const vite = await import('vite');
  if (dev) {
    const server = await vite.createServer({ root: ROOT, server: { host: '127.0.0.1', port: DEV_PORT, strictPort: false } });
    await server.listen();
    return { url: server.resolvedUrls?.local[0] ?? `http://127.0.0.1:${server.httpServer.address().port}/`, close: () => server.close() };
  }
  const server = await vite.preview({
    root: ROOT,
    logLevel: 'warn',
    preview: { host: '127.0.0.1', port: PREVIEW_PORT, strictPort: false, open: false },
  });
  return { url: server.resolvedUrls?.local[0] ?? `http://127.0.0.1:${server.httpServer.address().port}/`, close: () => server.close() };
}

// Fetches the page, every file it links and the music track.
async function selfCheck(url) {
  const page = await fetch(url);
  const html = await page.text();
  if (!page.ok || !html.includes('<title>SKYTHREAD</title>')) throw new LaunchError(`Sayfa sunulamadı (${page.status}).`);
  const files = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((f) => !/^(data:|https?:)/.test(f));
  files.push('audio/theme.mp3');
  for (const file of files) {
    const res = await fetch(new URL(file, url));
    await res.arrayBuffer();
    if (!res.ok) throw new LaunchError(`${file} sunulamadı (${res.status}).`);
  }
  say(`Kontrol başarılı: sayfa ve ${files.length} dosya sunuluyor.`);
}

function isWsl() {
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

// Opens the URL in the default browser. Resolves false when no opener worked.
function openBrowser(url) {
  const openers = [];
  if (process.platform === 'win32') openers.push(['rundll32.exe', ['url.dll,FileProtocolHandler', url]]);
  else if (process.platform === 'darwin') openers.push(['open', [url]]);
  else {
    if (isWsl()) openers.push(['wslview', [url]], ['explorer.exe', [url]]);
    if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
      openers.push(['xdg-open', [url]], ['gio', ['open', url]], ['sensible-browser', [url]], ['x-www-browser', [url]]);
    }
  }
  return new Promise((resolve) => {
    const attempt = (i) => {
      if (i >= openers.length) return resolve(false);
      const [command, args] = openers[i];
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        if (ok) resolve(true);
        else attempt(i + 1);
      };
      let child;
      try {
        // Detached on Unix so the browser outlives this window and Ctrl+C.
        child = spawn(command, args, { stdio: 'ignore', detached: process.platform !== 'win32', windowsHide: true });
      } catch {
        return finish(false);
      }
      child.on('error', () => finish(false));
      // explorer.exe reports exit code 1 even when it opened the page.
      child.on('exit', (code) => finish(code === 0 || command === 'explorer.exe'));
      // An opener that is still running after a few seconds has started the browser.
      setTimeout(() => {
        child.unref();
        finish(true);
      }, 4000).unref();
    };
    attempt(0);
  });
}

async function main() {
  process.chdir(ROOT);
  const flags = parseArgs(process.argv.slice(2));
  say('SKYTHREAD başlatılıyor...');
  const node = nodeCheck.check();
  if (!node.ok) throw new LaunchError(`${node.reason}. Oyunu BASLAT dosyalarından biriyle başlatın; gerekli Node.js'i kendileri indirir.`);
  say(`Node.js ${process.version} (${process.platform}-${process.arch})`);
  ensurePackages(flags.reinstall);
  if (!flags.dev) await ensureBuild(flags.rebuild);
  if (flags.server) await ensureServerBuild(flags.rebuild);
  const server = flags.server ? await serveGameServer() : await serve(flags.dev);
  if (flags.check) {
    try {
      await selfCheck(server.url);
      if (flags.server) {
        const health = await (await fetch(`${server.url}healthz`)).json();
        if (!health.ok) throw new LaunchError('Oyun sunucusu sağlıklı değil.');
        say(`Oyun sunucusu çalışıyor (protokol ${health.protocol}).`);
      }
    } finally {
      await server.close();
    }
    return;
  }
  say();
  say(`Oyun hazır: ${server.url}`);
  if (server.lan) {
    if (server.lan.length) {
      say('Aynı ağdaki telefon ve bilgisayarlar şu adresle katılabilir:');
      for (const u of server.lan) say(`  ${u}`);
    } else say('Yerel ağ adresi bulunamadı; yalnızca bu bilgisayardan bağlanılabilir.');
    say('Güvenlik duvarı sorarsa yerel ağ erişimine izin verin.');
  }
  if (flags.open) {
    const opened = await openBrowser(server.url);
    say(opened ? 'Tarayıcıda açıldı.' : 'Tarayıcı kendiliğinden açılamadı; adresi tarayıcınıza yapıştırın.');
  }
  say('En iyi deneyim için Chrome, Edge veya Firefox kullanın.');
  say("Oyunu kapatmak için bu pencereyi kapatın ya da Ctrl+C'ye basın.");
  const stop = () => {
    say('Kapatılıyor...');
    Promise.resolve(server.close()).finally(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch((err) => {
  console.error(`\nHATA: ${err instanceof LaunchError ? err.message : (err?.stack ?? err)}`);
  process.exit(1);
});
