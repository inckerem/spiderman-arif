# SKYTHREAD

A single-player 3D open-world web-swinging game for desktop and mobile browsers (on phones and tablets with on-screen touch controls). Swing on lines shot from wrist launchers through a procedurally generated Manhattan-style city of about 1.5 x 1.5 km with a large tree-filled central park, a waterfront with piers and a bridge, live traffic and pedestrians, a dynamic day-night cycle, optional ring races and a photo mode. Everything is built in code: the city, the hero, the animation, the textures and every sound effect. The only asset file is the music track.

The in-game interface is in Turkish (all strings in `src/i18n/tr.ts`).

## Run

### One step (Windows, macOS, Linux)

Clone the repository and start the launcher for your system:

| System | Start |
| --- | --- |
| Windows 10/11 | double-click `BASLAT-Windows.bat` |
| macOS | double-click `BASLAT-Mac.command` (or run it in Terminal) |
| Linux | `./BASLAT-Linux.sh` |

Nothing has to be installed first. When Node.js is missing or too old, the launcher downloads a portable Node.js 22 into `.tools/` (checked against a pinned SHA-256; no admin rights, nothing installed system-wide). It then installs the npm packages, builds the game, serves it on http://127.0.0.1:4173 and opens the default browser. The first start downloads about 100 MB and takes a few minutes. Later starts take a few seconds and rebuild only when the sources changed. The launcher window keeps the game server running; close it or press Ctrl+C to stop.

Options (pass them on the command line): `--dev` (dev server with hot reload), `--no-open`, `--rebuild`, `--reinstall`, `--check` (start, check that the page is served, exit). `SKYTHREAD_NODE=portable` ignores an installed Node.js. Deleting `.tools/` removes the portable Node.js.

A downloaded ZIP (instead of a clone) can trigger a security prompt. On macOS, run `sh BASLAT-Mac.command` in Terminal, or allow the file under System Settings > Privacy & Security. On Windows, choose "More info" and then "Run anyway".

### Manual

Requirements: Node.js 22.12+ or 20.19+ (Vite 8 requires one of these; developed on 22), npm, a browser with WebGL2 (current Chrome, Edge, Firefox or Safari; on phones Chrome for Android or Safari on iOS/iPadOS).

```bash
npm install
npm run dev          # http://127.0.0.1:5173
```

Production build:

```bash
npm run build        # type-check + bundle into dist/
npm run preview      # http://127.0.0.1:4173
```

Behind the main menu the hero swings through the city on autopilot, filmed by a cinematic camera that cuts between chase, side, low-angle, aerial and orbit shots (attract mode; not playable). Click **Oyna** (Play) to start: the hero begins on the spawn roof and the game captures the mouse (pointer lock; on phones see below). Audio starts after the first click or key press. Press `Esc` to pause; **Ana Menü** in the pause menu goes back to the attract mode. URL parameter `?seed=1234` generates a different city.

## Controls

| Key | Action |
| --- | --- |
| W A S D | Move; steer while swinging |
| Mouse | Look |
| Left mouse (hold) | Fire a web line where the crosshair points (up to 120 m) and swing while the button is down; let go to release with a push forward and up. Held with nothing usable under the crosshair, the line fires the moment the crosshair finds a point |
| Right mouse | Pull line: pulls you toward the aimed point, a little faster than a swing (hop or mantle at the end) |
| Space | Jump; on a swing or pull line, cut it with the same push as letting go; wall jump |
| Shift (hold) | Sprint on the ground; cling to and climb walls |
| C or Q | Dive in the air (trades height for speed) |
| Mouse wheel | Reel the line in or out while swinging |
| M | Music on/off (music plays in the menus and in the rooftop moment only) |
| P | Photo mode (free camera: WASD, mouse, Space/C up/down, Shift fast) |
| T | Pause or resume the day-night cycle |
| Y (hold) | Fast-forward time |
| 1 / 2 / 3 / 4 | Dawn / noon / sunset / night |
| Esc | Pause menu |
| ` (backtick) | Debug and tuning panel |

These are the default keys. Every action except Esc, mouse look, the wheel, 1–4 and ` can be rebound under **Ayarlar > Tuş atamaları** (Settings > Key bindings): two keys or mouse buttons per action, saved in the browser. The controls screen and the photo panel always show the current keys, named after the player's keyboard layout (Turkish Q and F layouts included).

Dive is on C/Q instead of Ctrl because Ctrl+W closes the browser tab while W is held (see `docs/DECISIONS.md`); Ctrl, Alt, Cmd/Windows, Tab and F1–F12 cannot be bound for the same reason.

Lines go exactly where the crosshair points (a ring of rays 2.5 degrees around it catches building edges and trunks); the crosshair lights up and a diamond marks the point when a line would hold there. Nothing usable under the crosshair means no line. The camera turns toward the travel direction while you fly fast and leave the mouse alone; switch this off under Ayarlar > Kamera otomatik takip.

Costumes: **Kostüm** in the main menu or the pause menu dresses the hero in one of four suits (Kırmızı-Lacivert, Kırmızı-Altın, Siyah-Altın, Siyah-Beyaz); the pick is worn at once and saved with the settings.

### Playing on a phone or tablet

Phones and tablets (a touch screen as the main pointer) get on-screen controls instead of mouse and keyboard; a laptop or desktop with a touchscreen keeps mouse and keyboard. To try the game on a phone, serve it on your network and open the address shown on the phone, in landscape:

```bash
npm run dev -- --host            # or: npm run build && npm run preview -- --host
```

The launchers serve on 127.0.0.1 only, which a phone cannot reach. On a desktop, `?dokunmatik=1` in the URL forces the touch controls on (for trying them with browser device emulation) and `?dokunmatik=0` forces them off.

Tap **Oyna**: play starts at once (there is no pointer lock on touch). On Android the game also switches to fullscreen; iPhone Safari has no fullscreen for pages, so the browser bars stay (adding the page to the home screen hides them). The game is landscape only: in portrait a "Cihazını yatay çevir" prompt covers the screen and play pauses. Switching apps also pauses. The first start on a touch device picks Low quality; change it under Ayarlar as usual.

| Control | Action |
| --- | --- |
| Left thumb, anywhere on the left side | Floating stick (appears under the thumb): push a little to walk, all the way to run, to the rim (it turns amber) to sprint; steers while swinging |
| Drag on the right side | Look (own sensitivity under Ayarlar > Dokunmatik bakış hassasiyeti; invert Y applies) |
| AĞ (hold) | Web line and swing, exactly like holding the left mouse button; let go to release with the push |
| ÇEK | Pull line (right mouse) |
| ZIPLA | Jump, cut a line, wall jump (Space) |
| DALIŞ (hold) | Dive (C/Q) |
| TIRMAN (hold) | Cling to and climb walls (Shift); also sprints on the ground |
| + / − | Reel the line in or out (shown while swinging; hold to repeat) |
| Pause (top left) | Pause menu; photo mode and the music toggle are in the pause menu |

All of these work at the same time (stick, look drag, a held AĞ and a tap on ZIPLA). The crosshair and the line aiming are the same as on desktop, with a wider catch around the crosshair (4 degrees instead of 2.5). In photo mode the stick flies the camera and a drag on the right turns it. A touch also ends the rooftop moment.

Tips: let go on the rising part of a swing while the crosshair pulses for a launch bonus ("MÜKEMMEL BIRAKIŞ!"); fire a line right after a dive to carry the speed into the swing. Fly through the first ring of a route (park, towers, waterfront) to start a timed run; best times are saved. After you have been playing for a while, stand still on a rooftop for five seconds (no keys, no race running) for the rooftop moment: the music starts from the top, the sky runs through dusk into night, rain sets in, the HUD gives way to letterbox bars and the camera circles the crouching hero. Any key, mouse button or a deliberate mouse movement brings everything back (rain off, the time of day where it was, unless you set the hour with 1-4, Y or the photo time slider); M and the photo key work without ending it, and photo mode can capture it.

## Tuning guide

Every gameplay constant lives in `src/config/tuning.ts`, grouped by system. The debug panel (backtick) edits the same object live; the simulation reads it every tick, so changes apply immediately. "Reset to defaults" restores the file values. To keep a change, copy the value into `tuning.ts`.

| Group | What it shapes | Start with |
| --- | --- | --- |
| `swing` | Pendulum and arcade layer | `gravityScale` (lighter or heavier arcs), `pumpAccel` / `pumpMaxSpeed` (how much W adds), `steerRate`, `catchEfficiency` (speed kept when the rope snaps taut), `minRope` / `maxRope` / `attachLengthFactor`, the good-release window (`goodReleaseMinDeg` / `goodReleaseMaxDeg`) and its launch bonus (`goodReleaseBonus`, `goodReleaseUp`) |
| `aim`, `assist` | Crosshair aim; the wide anchor search the test bots use to pick where to look | `magnetismDeg`; `range`, `idealDistance`, `maxAimAngleDeg`, score weights |
| `air` | Flight | `gravity`, `drag`, `softCap` / `capDrag` (soft speed cap around 60 m/s), air control |
| `cut`, `boost`, `dive` | The push when you let go of a line (or cut it with Space), scaled by the time spent on it; the air boost after a zip hop; dive gravity and steering | `cut.up`, `cut.forward`, `cut.fullAfter`, `window`, `gravityMul` |
| `zip` | Pull line | `speed` (34 m/s), `startSpeed`, `accel` (ease-in), `cooldown`, `maxRange`, end hop and mantle reach |
| `wall` | Cling, crawl, wall run, wall jump | `crawlSpeed`, `wallRunMax` |
| `ground` | Running and parkour | `runSpeed`, `sprintSpeed`, `jumpSpeed`, vault and mantle limits, `hardLandingSpeed`, roll |
| `camera` | Spring-arm camera | `armGround` / `armAir` / `armFast`, `shoulder`, FOV range by speed, follow stiffness (`airFollowFreq`, `airVelSmooth`, `lagStiffen`), auto-follow (`autoYawRate`, `autoYawDelay`), look-ahead, shake |
| `recovery` | Stuck detection and safe recovery | `stuckTime`, `deepPenetration`, `blendTime` |
| `world`, `time` | Water level, soft boundary, day length and start hour | `softBoundaryAccel`, `dayLengthMinutes` |
| `moment` | Rooftop moment: trigger, time-lapse, rain, fades, orbit camera, lightning | `idleSeconds`, `minPlaySeconds`, `minTravel`, `minRoofHeight`, `nightHour`, `toNightSeconds`, `orbitRadius` |

Render quality presets (shadow map, view distance, traffic and crowd density, rain streaks, FXAA, pixel-ratio cap) are in `src/config/quality.ts`; the in-game settings screen picks one and persists the choice.

## Tests

The suite drives the dev build headless (Playwright + Chromium with SwiftShader) through `window.__game`, a deterministic test API that exists only in dev builds.

```bash
npm test                         # whole suite (starts the dev server if needed)
npx playwright test tests/soak.spec.ts   # 30 simulated minutes (long)
npm run test:quick               # smoke test only
```

| Test | Checks |
| --- | --- |
| a `swing.spec.ts` | Pendulum from 45 degrees: energy drift, period, no NaN, catch conversion, re-attach latency; line controls (holding fires at the crosshair and keeps the line, letting go releases with a push, a tap gives none, Space cuts, holding at open sky does nothing, the pull line eases in and cuts); line edge cases (pause or lost focus while held lets go, a click shorter than a frame fires, Space while a line from the ground is in flight jumps and keeps it, one from a wall is cut); camera auto-follow |
| b `fuzz.spec.ts` | 12 simulated minutes of random input over 6 seeds: never inside geometry, below ground, out of bounds, NaN or stuck, camera never inside geometry; head-on 95 m/s impacts never tunnel |
| c `anchors.spec.ts` | Anchor availability from 500 street, rooftop and park positions (>= 95 %) |
| d `traversal.spec.ts` | Corner-to-corner city bot and tree-to-tree park bot spend < 10 % of the time on the ground |
| e `soak.spec.ts` | 30 simulated minutes of mixed play (including attract mode and a rooftop-moment cycle with rain every minute): clean console, no heap growth trend, no GPU resource growth |
| f `character.spec.ts` | Planted feet never slide, limbs stay out of geometry (including the hard-landing crouch), bones stay finite; strong releases do air tricks, which end on landing |
| g `ui.spec.ts` | Settings round trip and corrupt storage, costume picker (worn at once, arrow keys, saved across reloads), audio unlock and music decode (music in the menu, none in play, a restart from the top leaves no extra sources), mute, pause on lock loss, resume, photo PNG export; g2: dynamic resolution drops under load to 0.75 x the CSS pixels (0.5 scale at pixel ratio 1.5), returns to full at 60 Hz, and backs off to 30 s on a marginal machine |
| h `rings.spec.ts` | Ring routes clear and reachable, race logic and best times; traffic on roads with stops and turns; pedestrians off the carriageway |
| i `keybindings.spec.ts` | Rebinding with keys and mouse buttons (conflicts, cancel, clear, reserved keys, no click-through, arrow-key navigation), controls screen and photo panel follow the bindings, the game reacts to the new keys only, persistence and corrupt storage (including codes named like `toString`) |
| j `attract.spec.ts` | j1: the menu autopilot runs 6 simulated minutes headless: never stuck, in water, below ground, inside geometry or NaN, little ground time, long distance, swings, pull lines, wall runs and perches; the cinematic camera never inside geometry with the hero in frame. j2: the rooftop moment never starts right after a new game on the spawn roof, then starts only after 5 s still on a roof (not on the street, not while moving, not during a race), brings music, night, rain, letterbox and the orbit camera, holds while paused (a flash goes out) and through M and mouse jitter, and a key, a deliberate mouse movement or a click (firing no line) restores the music, rain, HUD and the exact hour, while an hour key keeps its hour |
| k `touch.spec.ts` | Mobile emulation (844x390, touch, DPR 2): touch mode and Low quality on the first run, Oyna plays without pointer lock, half a stick push walks at half run speed, a full push runs and the rim sprints, a right-side drag turns the camera (invert Y applies), AĞ held keeps a line while the stick, a look drag and a DALIŞ tap happen at once and letting go releases it, ZIPLA, DALIŞ and TIRMAN work, the pause button and Devam Et, portrait shows the rotate prompt and pauses, menus (main, settings, controls, costume, pause) have no horizontal overflow, every button inside the screen and at least 44 px tall at 844x390 and 740x360; k2: a desktop gets no touch controls, `?dokunmatik=1` forces them |
| `smoke.spec.ts` | Page loads with a clean console and no request leaves the origin |

Numbers from each run are written to `test-results/*.json`. Software GL in a sandbox does not represent real GPU frame rates, so the suite measures simulation time per tick, draw calls, triangles and memory instead of FPS.

## Project layout

```
BASLAT-*            one-step launchers (Windows .bat, macOS .command, Linux .sh)
scripts/            launcher logic: Node.js check and portable download, install, build, serve
src/
  app.ts            screen flow, settings, HUD/minimap/audio updates
  game.ts           composition root: loop, simulation, camera views, rendering
  config/           tuning.ts (all gameplay constants), quality.ts (render presets)
  core/             fixed-step loop, seeded RNG, math helpers
  input/            keyboard and mouse state, rebindable key bindings, on-screen touch controls
  physics/          analytic collision world (boxes, cylinders, ellipsoids, terrain, water), grid, raycasts
  player/           player state machine, rope constraint, targeting with assist, autopilot (bot play shared by the menu and the test bots)
  camera/           spring-arm camera with collision, cinematic director (menu)
  world/            city generator, collision proxies, chunked city visuals, sky, day-night
  render/           cel materials, outline post-process, FXAA, dynamic resolution
  character/        procedural humanoid and costumes, animator (gait IK, poses, tricks, limb collision), web line
  fx/               particles, rain streaks
  life/             traffic and pedestrians
  extras/           ring races, attract mode, rooftop moment
  audio/            music loop and synthesized SFX and ambience
  ui/               menus, HUD, minimap, settings persistence, photo panel
  i18n/tr.ts        all in-game text (Turkish)
  debug/            tuning panel, test API and in-page test drivers
docs/               spec, architecture, milestones, decisions
tests/              Playwright specs a-j, smoke, soak
public/audio/       theme.mp3 (the user's music track)
```

See `docs/ARCHITECTURE.md` for the design (loop, collision, swing model, rendering, budgets) and `docs/DECISIONS.md` for every judgement call.
