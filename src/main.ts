import { App } from './app';
import { tr } from './i18n/tr';
import { resolveMapId } from './maps/select';
import { getMap } from './maps/registry';
import { loadSettings } from './ui/settings';

function fatal(message: string): void {
  const el = document.createElement('div');
  el.className = 'sk-fatal';
  el.textContent = message;
  el.style.cssText =
    'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:2rem;text-align:center;' +
    'background:#101820;color:#f4f1e8;font:600 1.2rem/1.5 system-ui,sans-serif;z-index:100';
  document.body.appendChild(el);
}

function hasWebGL2(): boolean {
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
}

async function boot(): Promise<void> {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const uiRoot = document.getElementById('ui') as HTMLElement;
  if (!hasWebGL2()) {
    fatal(tr.warnings.noWebGL);
    return;
  }
  const mapId = resolveMapId(location.search, loadSettings().map);
  const seedParam = new URLSearchParams(location.search).get('seed');
  const seed = seedParam ? Number(seedParam) | 0 : getMap(mapId).defaultSeed;
  const app = new App(canvas, uiRoot);
  await app.boot(seed, mapId);
  // Load-time marker (read by the performance check; harmless in play).
  document.body.dataset.ready = String(Math.round(performance.now()));
  if (import.meta.env.DEV) {
    const { installTestApi } = await import('./debug/testApi');
    installTestApi(app.game, app);
  }
}

boot().catch((e) => {
  console.error(e);
  // Never leave the player on a loading screen that will not finish.
  fatal(tr.warnings.bootFailed);
});
