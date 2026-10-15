import { test, expect, type Page } from '@playwright/test';
import { expectClean, saveResult } from './helpers';

// (i) Key bindings: rebinding through the bindings screen with keys and mouse
// buttons (conflicts move the key, Esc cancels, Delete empties, reserved keys
// are refused, the capturing press never clicks the button under it, arrow
// keys move between slots), the controls screen and the photo panel follow
// the bindings, the game reacts to the new keys only, bindings persist, a
// corrupt entry is sanitized (including codes named like Object.prototype
// members, which once hung the boot), and both reset buttons do what they say.

/** Collects console errors and warnings for the whole test, across reloads. */
function watchConsole(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  return problems;
}

async function load(page: Page, reload = false): Promise<void> {
  if (reload) await page.reload();
  else await page.goto('/');
  await page.waitForFunction(() => (window as any).__game?.ready === true, null, { timeout: 120_000 });
}

type Slots = [string | null, string | null];

const bindings = (page: Page): Promise<Record<string, Slots>> =>
  page.evaluate(() => (window as any).__game.app.ui.settings.bindings);

const storedBindings = (page: Page): Promise<Record<string, Slots> | null> =>
  page.evaluate(() => JSON.parse(localStorage.getItem('skythread.settings.v1') ?? '{}').bindings ?? null);

const slot = (page: Page, action: string, n: 1 | 2, key: string) =>
  page.getByRole('button', { name: `${action}, ${n}. tuş: ${key}`, exact: true });

const toast = (page: Page) => page.locator('.sk-toast-text');

const focusedName = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '');

const appState = (page: Page) => page.evaluate(() => (window as any).__game.app.state as string);

async function openBindings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Ayarlar' }).first().click();
  await page.getByRole('button', { name: 'Değiştir', exact: true }).click();
  await expect(page.locator('.sk-bd-slot').first()).toBeVisible({ timeout: 60_000 });
}

/** Middle or left mouse press over the centre of `target`, as one capture would see it. */
async function pressOver(page: Page, target: ReturnType<Page['getByRole']>, button: 'left' | 'middle'): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error('target not visible');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down({ button });
  await page.mouse.up({ button });
}

test('i. key bindings: rebinding, conflicts, persistence and gameplay', async ({ page }) => {
  test.setTimeout(20 * 60 * 1000);
  await page.setViewportSize({ width: 1024, height: 640 });
  const problems = watchConsole(page);
  await load(page);
  await page.evaluate(() => localStorage.clear());
  await load(page, true);
  await openBindings(page);

  // --- Keyboard: W -> K on İleri ---------------------------------------------------
  await slot(page, 'İleri', 1, 'W').click();
  await expect(slot(page, 'İleri', 1, 'Tuşa bas…')).toBeVisible();
  await page.keyboard.press('KeyK');
  await expect(slot(page, 'İleri', 1, 'K')).toBeVisible();
  expect((await bindings(page)).forward).toEqual(['KeyK', 'ArrowUp']);

  // --- Conflict: K on Zıpla's empty slot is taken from İleri ---------------------------
  await slot(page, 'Zıpla / ipi kes', 2, 'boş').click();
  await page.keyboard.press('KeyK');
  await expect(toast(page)).toHaveText('K tuşu “İleri” atamasından alındı');
  let b = await bindings(page);
  expect(b.jump).toEqual(['Space', 'KeyK']);
  expect(b.forward).toEqual([null, 'ArrowUp']);
  await slot(page, 'İleri', 1, 'boş').click();
  await page.keyboard.press('KeyI');
  await slot(page, 'Fotoğraf modu', 1, 'P').click();
  await page.keyboard.press('KeyO');

  // --- Reserved keys are refused and keep the slot waiting; Esc cancels ----------------
  await slot(page, 'Dalış', 1, 'C').click();
  await page.keyboard.press('ControlLeft');
  await expect(toast(page)).toHaveText('Ctrl atanamaz');
  await page.keyboard.press('Tab');
  await expect(toast(page)).toHaveText('Tab atanamaz');
  await expect(slot(page, 'Dalış', 1, 'Tuşa bas…')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(slot(page, 'Dalış', 1, 'C')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__game.app.ui.screen)).toBe('bindings');

  // --- Delete empties a slot -----------------------------------------------------------
  await slot(page, 'Dalış', 2, 'Q').click();
  await page.keyboard.press('Delete');
  await expect(slot(page, 'Dalış', 2, 'boş')).toBeVisible();

  // --- Mouse buttons; the capturing press never clicks the reset button under it -------
  const reset = page.getByRole('button', { name: 'Varsayılanlara dön' });
  await slot(page, 'Fotoğraf modu', 2, 'boş').click();
  await pressOver(page, reset, 'middle');
  await expect(slot(page, 'Fotoğraf modu', 2, 'Orta tık')).toBeVisible();
  await slot(page, 'Müzik aç / kapat', 2, 'boş').click();
  await pressOver(page, reset, 'left');
  await expect(toast(page)).toHaveText('Sol tık tuşu “Ağ at / sallan” atamasından alındı');
  await slot(page, 'Ağ at / sallan', 1, 'boş').click();
  await pressOver(page, reset, 'left');
  b = await bindings(page);
  expect(b.swing).toEqual(['Mouse0', null]);
  expect(b.music).toEqual(['KeyM', null]);
  expect(b.photo).toEqual(['KeyO', 'Mouse1']);
  expect(b.forward).toEqual(['KeyI', 'ArrowUp']);
  expect(b.dive).toEqual(['KeyC', null]);

  // --- Keyboard only: arrows move between slots, Enter starts a capture ------------------
  await slot(page, 'İleri', 1, 'I').focus();
  await page.keyboard.press('ArrowRight');
  expect(await focusedName(page)).toBe('İleri, 2. tuş: ↑');
  await page.keyboard.press('ArrowDown');
  expect(await focusedName(page)).toBe('Geri, 2. tuş: ↓');
  await page.keyboard.press('ArrowLeft');
  expect(await focusedName(page)).toBe('Geri, 1. tuş: S');
  await slot(page, 'Zamanı hızlandır', 2, 'boş').focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('KeyJ');
  await expect(slot(page, 'Zamanı hızlandır', 2, 'J')).toBeVisible();

  // --- Stored, and the settings reset keeps key bindings -------------------------------
  b = await bindings(page);
  expect(await storedBindings(page)).toEqual(b);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Varsayılanlara dön' }).click();
  expect(await bindings(page)).toEqual(b);
  await page.keyboard.press('Escape');

  // --- Controls screen follows the bindings ---------------------------------------------
  await page.getByRole('button', { name: 'Kontroller' }).first().click();
  const keysOf = (row: string) =>
    page
      .locator('.sk-ctl-table tr', { hasText: row })
      .locator('th')
      .evaluate((th) => [...th.querySelectorAll('.sk-keys > *')].map((n) => n.textContent).join(' '));
  expect(await keysOf('Hareket')).toBe('I A S D');
  expect(await keysOf('Zıpla')).toBe('Boşluk veya K');
  expect(await keysOf('Havada dalış')).toBe('C');
  expect(await keysOf('Fotoğraf modu')).toBe('O veya Orta tık');
  await page.keyboard.press('Escape');

  // --- Reload: everything comes back from storage --------------------------------------
  await load(page, true);
  expect(await bindings(page)).toEqual(b);

  // --- Play: the game reacts to the new keys only ---------------------------------------
  await page.getByRole('button', { name: 'Oyna' }).click();
  await page.waitForFunction(() => (window as any).__game.game.playing === true, null, { timeout: 120_000 });
  const sampleWhileHeld = async (code: string) => {
    await page.keyboard.down(code);
    const r = await page.evaluate(() => {
      const input = (window as any).__game.game.input;
      const out: Record<string, unknown> = {};
      input.sample(out, 0, 0);
      return { moveY: out.moveY, jump: out.jump, forward: input.isHeld('forward') };
    });
    await page.keyboard.up(code);
    return r;
  };
  expect(await sampleWhileHeld('KeyI')).toEqual({ moveY: 1, jump: false, forward: true });
  expect(await sampleWhileHeld('KeyW')).toEqual({ moveY: 0, jump: false, forward: false });
  expect(await sampleWhileHeld('KeyK')).toEqual({ moveY: 0, jump: true, forward: false });
  const pos = () => page.evaluate(() => (window as any).__game.game.player.pos.toArray() as number[]);
  // Two simulated seconds with the real keyboard state (software GL renders too
  // slowly for the real-time loop to keep up, so the ticks are run directly).
  const p0 = await pos();
  await page.keyboard.down('KeyI');
  await page.evaluate(() => {
    const game = (window as any).__game.game;
    for (let i = 0; i < 240; i++) game.manualTick();
  });
  await page.keyboard.up('KeyI');
  const p1 = await pos();
  const walked = Math.hypot(p1[0]! - p0[0]!, p1[2]! - p0[2]!);
  expect(walked).toBeGreaterThan(2);

  // Photo mode: P no longer toggles it, O does; the panel names the bound keys.
  await page.keyboard.press('KeyP');
  await page.waitForTimeout(300);
  expect(await appState(page)).toBe('playing');
  await page.keyboard.press('KeyO');
  await page.waitForFunction(() => (window as any).__game.app.state === 'photo', null, { timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'Çık (O)' })).toBeVisible();
  await expect(page.locator('.sk-photo-hint')).toHaveText('IASD + fare: serbest kamera · Boşluk/C: yukarı/aşağı · Shift: hızlı');
  await page.keyboard.press('KeyO');
  await page.waitForFunction(() => (window as any).__game.app.state === 'playing', null, { timeout: 60_000 });

  // A mouse button bound to an action works while the pointer is locked.
  await page.mouse.click(400, 300);
  await page.waitForFunction(() => (window as any).__game.game.input.pointerLocked === true, null, { timeout: 60_000 });
  await page.mouse.down({ button: 'middle' });
  await page.mouse.up({ button: 'middle' });
  await page.waitForFunction(() => (window as any).__game.app.state === 'photo', null, { timeout: 60_000 });
  await page.keyboard.press('KeyO');
  await page.waitForFunction(() => (window as any).__game.app.state === 'playing', null, { timeout: 60_000 });

  // --- Corrupt entry: invalid, reserved and duplicate codes are dropped ------------------
  await page.evaluate(() =>
    localStorage.setItem(
      'skythread.settings.v1',
      JSON.stringify({
        bindings: {
          forward: ['Escape', 123],
          back: ['KeyW', 'Mouse9'],
          jump: 'x',
          dive: ['KeyC', 'KeyC'],
          music: ['KeyW', null],
          photo: ['__proto__', 'KeyP'],
        },
      }),
    ),
  );
  await load(page, true);
  const clean = await bindings(page);
  expect(clean.forward).toEqual([null, null]);
  expect(clean.back).toEqual(['KeyW', null]);
  expect(clean.jump).toEqual(['Space', null]);
  expect(clean.dive).toEqual(['KeyC', null]);
  expect(clean.music).toEqual([null, null]);
  expect(clean.photo).toEqual([null, 'KeyP']);
  expect(clean.left).toEqual(['KeyA', 'ArrowLeft']);
  // Codes named like Object.prototype members read as empty, and captions never
  // find inherited members (such a code used to hang the boot on the loading screen).
  await page.evaluate(() =>
    localStorage.setItem('skythread.settings.v1', JSON.stringify({ bindings: { jump: ['toString', null], zip: ['constructor', 'Mouse2'] } })),
  );
  await load(page, true);
  const proto = await bindings(page);
  expect(proto.jump).toEqual([null, null]);
  expect(proto.zip).toEqual([null, 'Mouse2']);
  await expect(page.getByRole('button', { name: 'Oyna' })).toBeVisible();
  const captions = await page.evaluate(async () => {
    const path = '/src/ui/keyLabels.ts';
    const { keyLabel } = await import(/* @vite-ignore */ path);
    return [keyLabel('toString'), keyLabel('constructor'), keyLabel('NumpadtoString')];
  });
  expect(captions).toEqual(['toString', 'constructor', 'Num toString']);

  // --- The bindings reset restores every default -----------------------------------------
  await openBindings(page);
  await page.getByRole('button', { name: 'Varsayılanlara dön' }).click();
  const defaults = await bindings(page);
  expect(defaults.forward).toEqual(['KeyW', 'ArrowUp']);
  expect(defaults.back).toEqual(['KeyS', 'ArrowDown']);
  expect(defaults.music).toEqual(['KeyM', null]);
  expect(defaults.photo).toEqual(['KeyP', null]);
  expect(await storedBindings(page)).toEqual(defaults);

  const result = { custom: b, walkedMetres: walked, sanitized: clean };
  saveResult('i-keybindings', result);
  console.log('i. keybindings', JSON.stringify({ walkedMetres: walked }));
  expectClean(problems);
});
