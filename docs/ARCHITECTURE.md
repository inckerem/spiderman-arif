# SKYTHREAD Architecture

This document is the plan the code follows. It is written before the code and kept in sync with it.

## 1. Stack

- TypeScript (strict), Vite, three.js 0.186.1 (pinned), lil-gui (debug panel), Playwright 1.56.1 (tests, uses the preinstalled Chromium).
- No physics engine. A custom kinematic character controller runs against an analytic static collision world (boxes, vertical cylinders, ellipsoids, a terrain height function and water).
- Everything is generated at load time from a seed: geometry, textures (canvas 2D), sounds (WebAudio synthesis). The only file asset is `public/audio/theme.mp3`, fetched from the same origin.

## 2. Module map (`src/`)

| Folder | Responsibility |
| --- | --- |
| `config/tuning.ts` | Every gameplay constant (movement, swing, line cut, zip, wall, camera, aim, assist, recovery) with UI metadata (min/max/step) for the debug panel. Single source of truth. |
| `config/quality.ts` | Render quality presets (Low/Medium/High/Ultra): shadow size, densities, view distance, post effects. |
| `i18n/tr.ts` | All in-game UI text (Turkish). |
| `core/` | Fixed-timestep loop, seeded RNG, math helpers (critically damped springs, easing), event bus. |
| `input/` | Keyboard and mouse state, pointer lock, per-tick edge detection, mouse wheel; rebindable action bindings (`bindings.ts`: actions, defaults, validation, conflict-free assignment). |
| `physics/` | Collider storage (struct-of-arrays), uniform spatial grid, capsule resolution, raycast, sphere cast, point tests, terrain and water queries. |
| `player/` | Player simulation: state machine (ground, air, swing, zip, wall, traverse), rope constraint, crosshair targeting (plus the wide anchor search bots use), stuck detection and recovery, world-edge handling. `autopilot.ts`: bot play shared by the menu and the test drivers (input levels to `TickInput`, crosshair aiming through the wide search, the swing brain, route following) and the `Autopilot` that wanders the city (waypoints on roofs, in the park and along the waterfront, grid routes around the pond, pull lines, wall runs, dives, rooftop perches, stall recovery). Pure simulation, no rendering. |
| `camera/` | Spring-arm third-person camera with collision, FOV by speed, look-ahead, landing shake. `director.ts`: the menu's cinematic director (chase, side tracking, low angle, aerial and perch orbit shots with cuts and blends, hero framed beside the menu column) and `clearShot`, the sphere cast plus sphere resolve that keeps any camera pose out of geometry. |
| `maps/` | Map abstraction (M13). `ids.ts` is the dependency-free map id list (`manhattan`, `istanbul`; the multiplayer server imports it), `select.ts` picks the boot map (`?harita=`, then `settings.map`, then Manhattan) and builds the reload URL of a map switch. `types.ts` / `registry.ts` hold the simulation side of each map (`MapDefinition`: generator, terrain, map-specific colliders, test spots, bot routes, autopilot waypoints and legs, ring routes); `renderTypes.ts` / `renderRegistry.ts` the render side (`MapVisuals`: landmark and bridge geometry, ground, water, backdrop, minimap painter). `maps/manhattan/` is the original city (`gen.ts` is the former `world/cityGen.ts`). |
| `world/` | Shared layout types, the generic collision builder (buildings, trees, props, then `map.addColliders`), building generator helpers, trees, street dressing, geometry builder, chunked render meshes (`cityRender.ts` draws the generic parts and calls the map's visuals), sky, day-night. |
| `render/` | Renderer setup, cel materials (MeshToonMaterial patched through `onBeforeCompile`), post pipeline (MRT color+normal+depth, outline composite, speed lines, FXAA), dynamic resolution. |
| `character/` | Procedural 21-joint humanoid built from rounded primitives with projected lens and emblem decals, costumes as per-vertex colour slots, procedural animation (gait with planted-foot IK, swing, dive, zip, wall crawl, mantle, roll, release flips and corkscrews, landing crouch), web line and impact splat. |
| `fx/` | Particles and one-shot effects (dust, splash, release burst, landing ring); rain streaks around the camera (one draw call, animated on the GPU). |
| `audio/` | Music loader with crossfaded seamless loop, buses (master/music/sfx), music presence (menus and the rooftop moment only), synthesized SFX and ambience (including rain and thunder). |
| `ui/` | DOM screens (loading, main menu, controls, settings, key bindings, pause), HUD (crosshair state, speed, altitude, ring timer, cues), rotating minimap, photo mode panel, settings persistence, key captions from the player's keyboard layout (`keyLabels.ts`). |
| `life/` | Instanced traffic on a lane graph with traffic-light phases and turns, instanced pedestrians on sidewalk loops and park paths with a shader walk cycle; both stay concentrated around the player. Visual only, never collide with the player. |
| `extras/` | Ring races (3 routes, timer, best times, minimap markers). `attractMode.ts`: the menu background (its own Player and unrendered aim rig driven by the autopilot, its own animator on the shared hero mesh, the director). `rooftopMoment.ts`: the rooftop moment state machine (idle, arming, in, active, out), local to this client. |
| `debug/` | lil-gui panel (backtick), `window.__game` test API (dev builds only), in-page test drivers (fuzz, anchor availability, traversal bots, attract mode and rooftop moment, soak); the bots use the shared autopilot code. |
| `game.ts` | Composition root for the 3D game: loop, simulation, camera views (gameplay rig with the rooftop-moment orbit blend, menu attract mode, photo free camera), hero, effects, weather (rain, mood grade, overcast, lightning), rendering. |
| `app.ts` | Application shell: owns UI, audio and the game; screen flow loading → main menu → playing ↔ paused / photo mode; pointer-lock gating; settings application; HUD, minimap and audio listener updates; drives the rooftop moment and the music presence; maps simulation events to sounds. |
| `main.ts` | Boot: WebGL2 check, seed from the URL, creates the App, installs the test API in dev builds. |

Dependency direction: `config`, `core` ← `physics` ← `world` (generation produces colliders) ← `player` ← `camera` ← `character`/`render`/`fx`/`life`/`extras` ← `game` ← `app` (with `audio` and `ui`). The simulation (`physics`, `player`, world generation data) never imports rendering code, so it can be stepped headless at full speed by the test drivers.

## 2a. Maps

The game builds one map per page load; a map switch saves `settings.map` and reloads with `?harita=<id>` (other URL parameters such as `seed` stay). `Game` gets the id through `GameOptions.mapId` (`App.boot(seed, mapId)`), and every layout carries `layout.mapId`, so any code holding a layout reaches its map with `getMap(layout.mapId)` (simulation) or `getMapVisuals(layout.mapId)` (rendering) without new constructor parameters. Generic code (buildings, trees, props, traffic, pedestrians, the player) reads the generic layout fields; Manhattan-only data (avenues, streets, park rectangle, pond, islet, bridge spec) is read only inside `maps/manhattan/` and through the map hooks. A golden digest (`__game.goldenDigest()`, `tests/golden/manhattan.json`) hashes the Manhattan layout, the collider arrays and the outputs of the deterministic drivers; refactors that must not change behaviour are checked against it bit for bit.

## 3. Fixed-timestep loop

- Simulation rate 120 Hz (`dt = 1/120`). `requestAnimationFrame` feeds an accumulator with the clamped frame delta (max 0.1 s). While `acc >= dt`, the previous state is snapshotted and one tick runs. At most 12 ticks per frame; excess time is dropped (slow motion instead of a spiral of death).
- Rendering interpolates the player transform between the last two ticks with `alpha = acc / dt`. The camera is evaluated per frame from the interpolated position; mouse look is applied per frame (zero added latency) and the yaw/pitch are latched into each tick's input snapshot.
- Input edges (presses/releases) are queued and consumed by the next tick, so a click shorter than a frame is never lost.
- Test mode (`__game.setManual(true)`) stops the real-time accumulator; tests call `step(n)` which runs exactly `n` ticks. Same code path, deterministic for a given seed and input script.

## 4. Collision approach

### 4.1 Static world

All static colliders are analytic primitives stored in typed arrays:

- **Box** (axis-aligned): building tiers, parapets, podiums, rooftop HVAC, piers, bridge deck and towers, benches, parked cars, park walls, railings.
- **Vertical cylinder**: tree trunks, lamp posts, hydrants, antennas, water tanks, bridge pylons.
- **Ellipsoid** (vertical axis of revolution): tree canopies.
- **Terrain**: a height function, not geometry. Roads are at y = 0, blocks (sidewalks, plazas, park) at y = 0.15, water surface at y = -1.2 outside the island and in the pond.

Each collider carries flags: `anchorable`, `climbable` (building facades, bridge towers), `cameraBlocks` (false for thin props so the camera does not pop on lamp posts), surface type (concrete, metal, wood, grass, foliage, glass) for footsteps.

Buildings are made only of boxes whose visual surfaces match the collider within 0.3 m (cornices protrude at most 0.25 m, pilasters 0.12 m). Non-box crown shapes are built as stepped boxes so visual and proxy stay identical.

### 4.2 Spatial index

A uniform grid of 16 m cells covers the world. Each cell lists the collider ids overlapping it. Queries:

- `queryAabb` gathers candidates (deduplicated with a stamp counter).
- `raycast` walks the grid with Amanatides-Woo DDA and tests colliders cell by cell, stopping at the first confirmed hit.
- `sphereCast` is a raycast against colliders inflated by the radius (used by the camera).
- `capsuleOverlap` / `pointInside` power the fuzz checks and recovery.

### 4.3 Player capsule resolution

The player is an upright capsule (radius 0.38 m, height 1.8 m). Because it is always vertical, closest points against boxes and vertical cylinders are exact and cheap (XZ clamp plus Y interval overlap). Ellipsoids use a scaled-space radial projection, which is accurate for the near-spherical canopies.

Per tick:

1. Candidates are gathered once for the AABB of the whole tick's sweep, expanded by the radius.
2. The tick is split into `n = ceil(|v| * dt / 0.15 m)` substeps, so a substep never moves more than 0.15 m. The thinnest collider is 0.24 m and the capsule radius is 0.38 m, so tunnelling is impossible up to any speed (at 100 m/s that is 6 substeps).
3. Each substep integrates, then runs up to 4 Gauss-Seidel iterations: push out along the contact normal by the penetration depth and remove only the velocity component into the surface (tangential velocity is kept, so glancing contacts never stall).
4. Terrain is resolved last (`y >= groundHeight`). Contacts are classified (ground if `n.y > 0.65`, wall if `|n.y| < 0.35`, ceiling if `n.y < -0.6`).

Kinematic moves (zip, vault, mantle) go through the same resolver; if a kinematic path is pushed off course or blocked, it aborts into the air state with the current velocity.

### 4.4 Safety nets

- Deep penetration (> 5 cm after resolution) for several ticks, or no progress for 3 s while the player is trying to move or is airborne, triggers recovery: search upward, then a ring search, for the nearest free capsule position with support below. The visual position blends to the new position over 0.35 s (render offset decay) so there is no jolt.
- Water: feet below the water surface → splash, then respawn at the nearest sidewalk or roof.
- World edge: beyond the soft boundary a smooth acceleration turns the player back toward the island; the hard clamp is never reached in practice.

## 5. Swing model

- Rope is an inequality constraint on the rope point (feet + 2.0 m): slack when closer than the rope length, taut otherwise. When taut: project the position onto the sphere and remove only outward radial velocity.
- Arcade layer: reduced gravity while taut, tangential force from input toward the camera direction, gentle heading steering that preserves speed, soft speed cap with drag above 60 m/s, catch conversion (when the rope snaps taut, most of the removed radial speed is redirected tangentially so falling into a swing never stalls), automatic ground clearance (the rope reels in so the arc bottom stays above ground), hands alternate, good-release window on the rising part of the arc with a launch bonus and a visible cue.
- Controls: pressing the left button fires a line at the crosshair target and the line holds while the button is down; while it is held with no usable point under the crosshair, the line fires as soon as one appears. Letting go (or Space) releases with a push forward and up (`cut.up`, `cut.forward` fading out at speed) that grows over the first `cut.fullAfter` seconds on the line, so a tap does not launch; a release inside the good-release window also gets the launch bonus. The right click starts the pull line, which eases in from `zip.startSpeed` to `zip.speed` and can be cut with Space the same way.
- Attach latency: a fired line reaches the anchor in at most 60 ms, so a release followed by a new press is attached again in well under 150 ms.
- Line of sight from the hand to the anchor is checked every tick; when blocked the rope releases gracefully (no push). If the button is still held, the line fires again as soon as the crosshair finds a usable point, like any held press.

## 6. Targeting

1. Ray from the camera through the crosshair. A hit within 120 m (swing) or 80 m (pull line) of the player on an anchorable surface, facing the player, with clear line of sight from the hand becomes the anchor; swing anchors must also be at least 4 m above the feet and 12 degrees above the hand, and not a roof top.
2. When that point is not usable, rays on two rings around the crosshair (half and full `aim.magnetismDeg`, 4 and 8 rays) try again, closest ring first, so building edges and thin trunks still catch. One set of rays fills both the swing and the pull-line target. Nothing usable means no line.
3. The result drives the reticle (valid anchor highlighted with a marker at the anchor, invalid dimmed).
4. The wide search (`Targeting.plan`) examines anchorable colliders within 72 m: for each it takes the closest surface point to an ideal point placed forward and upward along the view, scores candidates by angle, distance band, height gain and surface type, and line-of-sight checks the best few. Gameplay never uses it; the menu autopilot and the test bots use it to choose where to aim before they click, and test (c) uses it to measure anchor availability.

## 7. Rendering

- Cel shading: `MeshToonMaterial` with a 3-band gradient map, patched via `onBeforeCompile` for facade windows (shared window atlas texture plus per-window lit hash), wind sway (trees), and an extra MRT output with view-space normals.
- Outlines: post-process edge detection on the depth buffer (Laplacian of inverse depth, which is zero on planes so flat surfaces never produce false edges) and the normal buffer (creases), with distance fade to prevent shimmer. Works with instancing at no extra draw calls.
- Pipeline: shadow map (one directional light, texel-snapped around the player) → MRT scene pass (color, normal, depth) → composite pass (outlines, speed lines, grading) → FXAA → screen. Render scale and dynamic resolution resize the internal targets; a smaller internal image is upscaled with bilinear filtering (by the FXAA pass, or a plain copy pass without FXAA).
- Batching: facades, roof props, street props, signs and lamp bulbs are merged per 240 m chunk into one draw call (one shared cel material, per-vertex mode selects window/plain/emissive/sign shading); ground is merged likewise. Trees (near/far LOD), cars and pedestrians use `InstancedMesh`. The hero is one rigidly skinned mesh (one draw call). Chunks are frustum culled.
- Day-night: time drives sun/moon direction, light colors, hemisphere ambient, fog, sky shader, window emission (per-window thresholds so lights come on gradually), street lamp emission and light pools. A `storm` factor lays an overcast over any hour (grey sky and fog, nearer fog, dimmer sun, swollen low clouds, no sun, moon or stars) and `flash` adds lightning; `hold` lets the rooftop moment drive the hour.
- Rain (rooftop moment): one transparent mesh of camera-facing streaks built once at load; the vertex shader moves each streak along the fall velocity and wraps it into a 38 x 30 x 38 m box around the camera, so a frame only sets a few uniforms. It writes no depth and leaves the normal buffer alone (no outlines). The composite pass adds the rainy mood grade (cooler, darker, more contrast and vignette) and lightning as uniforms of the existing program.

## 7a. Attract mode and rooftop moment

- Attract mode: in the menu view the loop ticks a second `Player` (the real simulation, separate from the game's player, so nothing it does reaches play and manual test mode never runs it) with input from the `Autopilot`, aimed through its own unrendered `CameraRig`. Each frame the hero mesh is posed from it by a second animator and the director places the game camera. Play from the main menu resets the game's hero to the spawn roof with a fresh camera; returning to the main menu resumes the attract hero where it was.
- Rooftop moment: `App` updates it every frame with `live` = playing with the pointer locked. Arming needs 20 s of play and some movement (5 m or a line) since the last spawn, respawn or new game, then the hero grounded on a building roof at least 8 m above the street, still, no input held or pressed and no ring race; after 5 s it restarts the music from the top of the track, tweens the hour through dusk to night (4 s), brings rain, overcast and the grade, lights the hero with a rim and fill, hides the HUD behind letterbox bars and blends the gameplay camera into a slow orbit (kept out of geometry by `clearShot`, turning back, rising or cutting when cramped). Line presses are dropped while the orbit shows. Input activity is counted by `Input` (keys except the music and photo keys, mouse buttons, wheel, touch, deliberate mouse travel); a change ends the moment and everything eases back to the saved hour, unless the player set the hour (hour keys, photo time slider, fast-forward), which then stays. Pause and photo mode hold it (a lightning flash goes out).

## 8. Performance budget

| Item | Budget | Plan |
| --- | --- | --- |
| Draw calls | ≤ 600 | ~150-250 typical (chunks, instancing, one-mesh character) |
| Visible triangles | ≤ 2 M | boxes plus textures for detail, low-poly instanced props |
| Simulation | ≤ 1 ms per tick | grid queries, analytic primitives, targeting at 60 Hz |
| Cold load | < 10 s | city generation < 2 s, shaders compiled during loading |
| Frame hitches | none > 40 ms | no allocation in hot loops, precompiled shaders, no runtime geometry rebuilds |

Dynamic resolution follows the cost the resolution can change, not the frame interval (which never drops below 16.7 ms on a vsync-locked 60 Hz display): the GPU time of the passes where `EXT_disjoint_timer_query_webgl2` delivers samples, otherwise the CPU time of the render call plus, for clearly late frames, the frame interval minus the previous frame's CPU work outside rendering. Simulation, traffic, crowd and animation time are left out. It lowers the internal render scale (floor: 0.75 x the CSS pixels, so 0.5 at pixel ratio 1.5) when the cost exceeds 90 % of the 16.7 ms budget and raises it back below 60 %, with hysteresis and a hold after raises that had to be undone that doubles up to 30 s and resets after a minute without a drop. The GPU timer falls back to the CPU cost after a second without samples, drops stuck queries, discards results across disjoint events and is rebuilt on WebGL context restore.

## 9. Testing

`window.__game` (dev builds) exposes: manual stepping, input injection, look control, teleport, state read-back, renderer stats, time of day, fixed camera poses for screenshots, UI visibility, and in-page drivers for the protocol in `docs/spec/05`: rope test, collision fuzz, anchor availability, traversal bots, soak, plus the character test (foot sliding, limb clipping), ring races, a headless attract-mode run and rooftop-moment frames (manual mode turns the real attract mode off). Playwright specs in `tests/` call these drivers and assert the thresholds; numbers are written to `test-results/*.json`:

- a `swing.spec.ts` rope and swing, b `fuzz.spec.ts` collision fuzz plus b2 head-on 95 m/s tunnelling check, c `anchors.spec.ts` anchor availability, d `traversal.spec.ts` traversal bots, e `soak.spec.ts` soak,
- f `character.spec.ts` planted feet and limb clipping, landing crouch and release tricks, g `ui.spec.ts` settings/costume/audio/pause/photo flow, h `rings.spec.ts` ring races, traffic and pedestrians, i `keybindings.spec.ts` rebinding and its effect in game, j `attract.spec.ts` attract mode (6 headless minutes) and the rooftop moment, plus `smoke.spec.ts` (clean console, no request leaves the origin).

## 10. Launchers

`BASLAT-Windows.bat`, `BASLAT-Mac.command` and `BASLAT-Linux.sh` start the game from a fresh clone with nothing preinstalled. Each only finds a usable Node.js and hands over to `scripts/launch.mjs`, so the behaviour is the same everywhere:

- `scripts/check-node.cjs` accepts the running Node.js when it satisfies Vite 8 (^20.19 or >=22.12) and npm is present.
- Otherwise `scripts/install-node-windows.ps1` (Windows) or `scripts/bootstrap.sh` (macOS, Linux) downloads Node.js 22.23.3 for the machine's OS and CPU into `.tools/node` and checks it against a SHA-256 pinned in the script. It is used only for this project.
- `scripts/launch.mjs` runs `npm ci` when the lockfile, OS or CPU changed since the last install (stamp in `node_modules`), builds with the Vite API when the content hash of the build inputs changed (stamp in `dist`), serves `dist/` with `vite preview` on 127.0.0.1 (port 4173 or the next free one) and opens the default browser.
- `.github/workflows/launchers.yml` runs every launcher with `--check` on Windows, macOS and Linux (x64 and ARM64), once with the runner's Node.js and once with the portable download.
