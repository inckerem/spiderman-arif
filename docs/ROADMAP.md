# SKYTHREAD Roadmap (M8-M13)

The next phase after M7. M1-M7 shipped a single-player desktop game; this phase fixes the review findings and image quality, adds an attract mode and a rooftop moment, mobile controls, combat with enemies, rooms-based multiplayer with Docker deployment, and a second map (Istanbul). Milestone rows and gates also live in `docs/MILESTONES.md`.

## Working method

- The main conversation only orchestrates. All code is written by subagents; model and effort are chosen per task (small fixes low effort, sim/netcode/map refactor high).
- Order is fixed: M8 → M9 → M10 → M11 → M12 → M13. A milestone starts only when the previous one is committed.
- Every milestone ends with `npm run typecheck`, `npm run build` and the full Playwright suite (a-i plus the new specs) passing, then a commit and push to branch `claude/optimistic-meitner-699dlz`.
- New tests follow the existing pattern: in-page drivers reached through `window.__game` (dev builds), Playwright specs assert thresholds and write numbers to `test-results/*.json`.
- `docs/ARCHITECTURE.md`, `docs/DECISIONS.md` and the README are updated in the milestone that changes the behaviour they describe.

## Decisions

Recorded as the user decided them.

### General
- Milestone order: M8 bug fixes + graininess, M9 attract mode + rooftop moment, M10 mobile, M11 combat and enemies, M12 multiplayer + rooms + Docker, M13 Istanbul map.
- UI stays Turkish; all new strings go to `src/i18n/tr.ts`. Docs stay English.

### M8 Bug fixes and graininess
- Fix every code-review finding: swing line stays attached after pause, pointer-lock loss or photo mode (`Input.clearAll` drops the release edge); a corrupt binding code such as `"toString"` freezes boot (`keyLabel` resolves it through the object prototype); Space during line flight cancels both the jump and the line; a swing click shorter than one frame is dropped; the release trick replays after land + jump in the animator; docs mismatches.
- Fix every graininess cause: dynamic resolution never scales back up on 60 Hz displays (it measures frame-to-frame time and only raises below 13.4 ms; floor 0.5); z-fighting between roof top and cornice top on most buildings (`buildingsGeo.ts`); PCF shadow per-pixel noise at radius 2.2 without TAA; `pixelRatioCap` 1 on Low/Medium blurs on HiDPI; Low preset nearest-filter upscale; outline speckle at mid distance; wall band-edge speckle at exactly 12:00.

### M9 Attract mode and rooftop moment
- Main menu background becomes an autopilot: the hero swings around the city by itself, filmed by a cinematic camera. Not playable; it is only the background behind the menus.
- The autopilot reuses the traversal-bot logic from `src/debug/testDrivers.ts`; it must ship in production builds, so the needed parts move out of `debug/`.
- Rooftop moment: standing still on a rooftop for 5 s starts it. `public/audio/theme.mp3` fades in, the sky transitions to night over a few seconds, rain starts (particles/streaks, wet look), the HUD fades out, cinematic letterbox bars appear and the camera orbits slowly.
- Any input ends it: music fades out, rain stops, time of day returns to its previous value.
- Outside the moment no music plays in game (SFX and ambience only). Menu music behaviour may stay.
- In multiplayer the night and rain are local to that player only.

### M10 Mobile
- Touch devices get on-screen controls: left virtual joystick (analog movement), drag on the right half to look, bottom-right buttons Web (hold), Pull, Jump, Dive, Attack (active from M11), and a pause button.
- `TickInput` gets analog movement axes.
- Crosshair and the existing aim assist stay.
- Landscape only; portrait shows a rotate prompt.
- No pointer lock on touch (iOS has none); the play flow in `app.ts`, gated on pointer lock today, must not require it on touch.
- Mobile auto-picks Low quality.
- Viewport meta (`viewport-fit=cover`, no zoom), `touch-action` rules, `dvh` units, menus usable at phone sizes; controls and key-binding screens adapted or hidden on touch.

### M11 Combat and enemies
- Context-sensitive left click: with an enemy under/near the crosshair or close by, it performs punch/kick combos with an auto-lunge to the target (free-flow style); with no enemy it fires the web line as today.
- Right click on an enemy: web-yank (pull the enemy to you) or web-pin (immobilize).
- Dodge on a key (for example Space while an attack is incoming, shown by a telegraph).
- Enemies spawn through crime events: at intervals a robbery/gang event starts at a city point, marked on the minimap; the player travels there and clears it. A few roaming enemies exist in between.
- Roster: street thugs (melee/bats), gunmen (ranged, can shoot a swinging player, dodgeable), heavy/shielded brutes, drones (flying, aerial combat), and bosses inspired by classic villains (a rhino-like charging brute, a vulture-like flyer, a scorpion-tailed fighter) with original names and designs. No trademarked names.
- Player health, damage, death → respawn on a nearby roof after a few seconds, health regeneration.
- The combat simulation is a pure module (no DOM or three.js rendering imports) that runs locally in single player and on the Node server in M12.
- New HUD: health bar, enemy health, combo counter, event marker. Mobile Attack button wired.

### M12 Multiplayer, rooms, Docker
- Identity: username only. No login or accounts. Remembered in localStorage; uniqueness per room by a `#2` suffix; basic profanity filter.
- Movement is client-authoritative: each client simulates its own hero (no swing latency) and sends its state at ~20 Hz; the server relays it and sanity-checks speed and teleports.
- Combat is server-authoritative: enemies, crime events, health and hits run on the server (Node.js, same pure sim modules, world generated from the same seed).
- Day-night clock is shared per room, driven by the server.
- Max 16 players per room. When a public room is full, a second public room of that map opens automatically.
- Each map has its own public room: everyone who picks that map in the menu is together.
- Private rooms: 6-character code plus shareable invite link (for example `?oda=K7P2QX`). The creator picks the map and can enable PvP. PvP exists only in private rooms; public rooms are co-op only.
- Remote players are rendered with their own rig, animator and web line, driven by replicated state plus events, with name tags and an interpolation buffer.
- Single player stays available and is the fallback when the server is unreachable.
- Transport: WebSocket (`ws` library).
- Docker: one container; the Node server serves the built static files and the WebSocket on one port (8080). Multi-stage Dockerfile, `docker-compose.yml`, and an example Nginx server block for a subdomain (TLS terminated at Nginx, WebSocket upgrade headers, placeholder domain; the user has not given one).

### M13 Istanbul map
- Second map, selectable in the menu, about 1.5 x 1.5 km like the current one.
- "Compressed real geography": real relative positions, shortened distances, buildings at real size.
- Layout: Historic Peninsula in the southwest (Hagia Sophia, Blue Mosque/Sultanahmet, Topkapı Palace, Süleymaniye); the Golden Horn in the middle with the Galata Bridge; Galata/Karaköy/Beyoğlu to the north with the Galata Tower; the Bosphorus to the east with Ortaköy Mosque and the 15 Temmuz Şehitler (Bosphorus) Bridge up the strait; Üsküdar and the Maiden's Tower on the Asian shore.
- Realistic low-rise neighbourhoods (4-8 floors) on hills (Beyoğlu, Sultanahmet); a Levent-style skyscraper cluster in one corner.
- Swing anchors: minarets, domes, towers, bridge cables, plane and cypress trees, ship masts, the skyscrapers.
- Nice to have: ferries on the water, seagulls, trams.
- M13 first introduces a map abstraction and refactors Manhattan onto it, then adds Istanbul. Tests c (anchors) and d (traversal) must pass on Istanbul too.

## M8 Bug fixes and graininess

**Scope.** Correctness fixes from the code review plus every identified cause of grainy or blurry images. No new features.

**Design outline.**

| Issue | Module | Fix direction |
| --- | --- | --- |
| Line stays attached after pause / lock loss / photo mode | `input/input.ts`, `app.ts` | `clearAll` emits pending release edges (swing, zip, held keys) before clearing, or the app releases the rope explicitly on leaving play |
| `"toString"` binding freezes boot | `ui/keyLabels.ts`, `input/bindings.ts` | own-property lookups (`Object.hasOwn` / `Map`), validate codes against a whitelist |
| Space in line flight cancels jump and line | `player/player.ts` | Space during line flight only cancels the pending line; jump is consumed once |
| Sub-frame click dropped | `input/input.ts` | queue press+release pairs so a tick sees `swingPressed` and `swingReleased` in order |
| Release trick replays after land + jump | `character/animator.ts` | clear trick state on landing; tricks start only from a fresh release event |
| Dynamic resolution stuck low at 60 Hz | `render/postfx.ts`, `game.ts` | measure GPU/CPU work time (not vsync-bound frame interval); raise when headroom exists at the display refresh; review floor 0.5 |
| Roof/cornice z-fighting | `world/render/buildingsGeo.ts` | offset or merge coplanar tops; never emit two coplanar faces |
| PCF shadow noise | `render/`, `config/quality.ts` | smaller radius or stable (non-noisy) filter kernel per preset |
| HiDPI blur on Low/Medium | `config/quality.ts` | raise `pixelRatioCap` where budget allows |
| Low preset nearest upscale | `render/postfx.ts` | linear upscale |
| Outline speckle mid distance | `render/postfx.ts` | depth-relative thresholds, earlier fade |
| Wall band-edge speckle at 12:00 | `render/materials.ts` | bias the toon band lookup so N·L at a band edge cannot flicker |
| Docs mismatches | `docs/`, README | sync with code |

**Tests to add.**
- Extend g/i: pause, lock loss and photo mode while a line is held end with no rope; a corrupt stored binding (`toString`, `__proto__`, `constructor`) boots and reads as empty.
- Line controls: a press+release inside one frame attaches and releases; Space during line flight does not jump and cancels only the line.
- f: land + jump after a trick release shows no trick replay.
- Render driver: dynamic-resolution scale returns to max after a load spike at a simulated 60 Hz; a pixel-diff check over two frames of a static roof view reports no z-fight flicker at 12:00.

**Risks.** Timing-based dynamic resolution is hard to test headless (SwiftShader); inject frame times through the driver. Shadow changes may shift look; compare screenshots at dawn/noon/night.

## M9 Attract mode and rooftop moment

**Scope.** Autopilot hero behind the menus; the 5 s rooftop moment with music, night, rain and cinematic camera; no in-game music otherwise.

**Design outline.**
- New `src/autopilot/` (production): `botBrain.ts` with the planner and aim/press/hold/release logic extracted from `testDrivers.ts` (`planTarget`, `aimForClick`, route picking, stuck handling). `testDrivers.ts` imports it instead of owning it.
- Attract mode in `game.ts`: a menu view mode that steps the real simulation with bot input, a cinematic camera (`camera/cinematicCam.ts`: long lens tracking shots, slow orbits, cuts on landing or at intervals) replacing the park orbit. Input from the player is ignored; leaving the menu resets the hero to the play spawn.
- Rooftop moment: `src/moments/rooftopMoment.ts` state machine (idle → arming 5 s → fading in → active → fading out). Trigger: mode ground on a roof surface, no input, speed ~0. Drives:
  - `audio/music.ts`: fade in/out; in-game music removed elsewhere (menu behaviour unchanged).
  - `world/dayNight.ts`: a temporary time override with blend; restores the saved time.
  - `fx/rain.ts`: instanced streaks around the camera, splash particles, wet-look uniform (darker albedo, higher spec, puddle sheen) in the cel material.
  - `ui/hud.ts`: fade out; new letterbox bars element.
  - `camera/`: slow orbit around the hero.
- Any input (key, mouse, touch) ends it through the same fade path.
- Local-only by design: the override never touches the shared clock M12 adds.

**Tests to add.**
- `attract.spec.ts`: in menu, the hero travels > N m in 60 s with ground time < 10 %, never stuck, camera never inside geometry; production build contains the autopilot (smoke on `npm run preview`).
- `moment.spec.ts`: 5 s idle on a roof starts it (music bus gain rises, time of day moves to night, rain active, HUD opacity 0, letterbox visible); idle on the street does not; one key press restores music gain 0, rain off and the original time; no music in game outside the moment.
- Soak e includes attract mode and moment cycles (no leaks from rain buffers).

**Risks.** Bot logic coupled to `Game` test internals; extract only pure planning code. Rain fill-rate on Low; scale streak count by preset.

## M10 Mobile

**Scope.** Touch controls, landscape, no pointer lock on touch, mobile-friendly menus, Low quality by default.

**Design outline.**
- `input/touch.ts`: virtual joystick (left), look drag (right half), buttons Web (hold), Pull, Jump, Dive, Attack (disabled until M11), pause. Writes into the same tick input path as keyboard/mouse.
- `TickInput.moveX/moveY` become analog (-1..1) with keyboard producing ±1; player movement scales speed by stick magnitude.
- `app.ts`: a `touchMode` flag (pointer: coarse + touch events) bypasses pointer-lock gating; pause on `visibilitychange` and the pause button.
- `ui/`: rotate prompt in portrait; safe-area insets; `dvh`; `touch-action: none` on the canvas and controls; settings/menus re-laid out for phone sizes; controls and key-binding screens hidden or replaced by a touch layout card.
- `index.html`: `viewport-fit=cover`, `user-scalable=no`, `maximum-scale=1`.
- `config/quality.ts`: Low default when touch is detected and no stored choice exists.

**Tests to add.**
- `touch.spec.ts` (Playwright mobile emulation, `hasTouch`, landscape): play starts without pointer lock; joystick half deflection gives about half run speed; holding Web swings and releasing lets go; look drag changes yaw; portrait shows the rotate prompt; no horizontal overflow on menus at 844x390; default quality Low.
- Existing desktop specs unchanged.

**Risks.** iOS Safari audio unlock and fullscreen quirks; multi-touch (look while holding Web) must track touch ids. Performance on real phones is not measurable headless.

## M11 Combat and enemies

**Scope.** Free-flow melee, web-yank/pin, dodge, crime events, enemy roster with three bosses, player health and respawn, combat HUD.

**Design outline.**
- `src/combat/` (pure: no DOM, no three.js rendering; three math classes allowed, matching `player/`):
  - `combatSim.ts`: fixed-tick world of enemies, hits, health, events; deterministic from seed; input = player states + actions, output = state + events.
  - `enemies.ts`: archetypes (thug, gunman, brute/shield, drone) and bosses with original names (names chosen in M11 and recorded in DECISIONS), each a small state machine (patrol, approach, telegraph, attack, stagger, webbed, down).
  - `crimeEvents.ts`: scheduler, spawn points from the city layout (streets, roofs), clear conditions; roaming spawns.
  - `melee.ts`: target selection (crosshair cone, then nearest), lunge, combo chain, counters/dodge windows.
- Player: `health` and `down` state; respawn on a nearby roof after a few seconds; regeneration after no damage. Left click routes to attack when `combat.hasTarget()`, else web line; right click on an enemy yanks or pins.
- Rendering: `combat/render/` enemy rigs (reuse the 21-joint rig with new proportions/costumes, instanced where possible), muzzle flashes, projectiles, hit FX; animator gains punch/kick/lunge/dodge/hit poses.
- HUD: health bar, enemy health, combo counter, event marker on HUD and minimap. Turkish strings in `i18n/tr.ts`. Audio: hit/whoosh/shot SFX synthesized.
- Mobile Attack button wired to the same action.

**Tests to add.**
- `combat.spec.ts`: click near an enemy lunges and hits (no line fired); click with no enemy fires a line; combo counter increments and resets; yank moves the enemy toward the player; pin immobilizes for its duration; a telegraphed attack is avoided by dodge; gunmen hit a swinging player unless dodged; death → respawn on a roof within a few seconds; regeneration.
- Events: an event spawns, appears on the minimap, clears when its enemies are down; bot-driven run clears one event of each archetype and each boss.
- Purity check: `combat/` (sim files) imports nothing from DOM/render modules (grep or a Node import of the sim).
- Fuzz b and soak e include enemies (no NaN, no enemy inside geometry, no leaks).

**Risks.** Click ambiguity between attack and web line; define the target cone carefully. Enemy count vs. performance on Low. Boss designs must stay clearly original.

## M12 Multiplayer, rooms, Docker

**Scope.** Username entry, public and private rooms, client-authoritative movement, server-authoritative combat and clock, remote player rendering, single-player fallback, one-container deployment.

**Design outline.**
- `server/` (Node, TypeScript, `ws`): HTTP static server for `dist/` plus WebSocket on one port (8080). Room manager: per-map public rooms (auto-open a second one at 16), private rooms with 6-char codes, PvP flag only on private rooms. Each room runs `combatSim` with the map seed, the shared day-night clock, and movement sanity checks (max speed, teleport distance).
- `src/net/`: `protocol.ts` (shared message types, versioned; binary or compact JSON), `client.ts` (connect, reconnect, send own state ~20 Hz, receive snapshots/events), `interp.ts` (per-remote interpolation buffer ~100 ms).
- Single player: `combatSim` runs locally; multiplayer: the client renders server combat state and sends actions. Same interface (`CombatSource`).
- Remote players: `character/remotePlayer.ts` = rig + animator + web line driven by replicated state (pos, vel, mode, anchor, flags) and events (fire, release, trick), with a DOM or sprite name tag.
- UI: username prompt (localStorage, profanity filter, `#2` suffix from server), map picker, "create private room" (map, PvP toggle), join by code, invite link `?oda=CODE`; fallback toast when the server is unreachable.
- Rooftop moment (M9) stays local; the shared clock resumes after it.
- Deploy: multi-stage `Dockerfile` (build client + server, slim runtime), `docker-compose.yml`, `deploy/nginx.example.conf` (subdomain placeholder `oyun.example.com`, TLS at Nginx, `Upgrade`/`Connection` headers, long read timeout). Vite dev/preview hosts stay 127.0.0.1; relative asset paths (`base: './'`) already work behind a proxy.

**Tests to add.**
- `net.spec.ts`: start the server in Playwright `webServer`; two browser contexts join the same public room and see each other (position within interpolation tolerance); a 17th client lands in a second room; private room via code and invite link; PvP only in private rooms; duplicate names get `#2`; filtered names rejected; teleport/speed cheat is corrected by the server; enemy damage and kills agree on both clients; shared clock matches; server down → single player starts.
- Server unit checks under Node: room capacity, code generation, sanity limits, combat sim determinism vs. the client build.
- Docker: `docker build` and `docker compose up` serve the game and accept a WebSocket upgrade (run where Docker is available).

**Risks.** Remote swing lines look wrong if anchor events arrive late; send anchor with state. Server CPU per room with combat at 16 players. Client-authoritative movement allows cheating beyond the sanity checks (accepted for co-op).

## M13 Istanbul map

**Scope.** Map abstraction, Manhattan refactored onto it, Istanbul as a second selectable map with hills, water, landmarks and anchors.

**Constraints found in the code.** `world/cityGen.ts` is hard-coded Manhattan (rect land and islet, avenue x street grid, fixed park/bridge/islet). Terrain, traffic lane graph, pedestrian loops, ring routes, minimap, water shader (`uLand`/`uIslet` rects), water respawn and the `CollisionWorld` extent (`cityCollision.ts:51`) all assume it. Terrain is flat and the collision raycast treats terrain as the plane y = 0 (`collision.ts` ~1050). Colliders are only axis-aligned boxes, vertical cylinders and vertical-axis ellipsoids. There is no map concept and no world teardown.

**Design outline.**
1. `src/maps/`: `MapDefinition` → produces `CityLayout`, `Terrain` (heightfield), water mask (texture or polygon set replacing the rect uniforms), lane graph, pedestrian loops, ring routes, minimap painter, spawn/respawn points, world extent.
2. Refactor Manhattan into `maps/manhattan.ts`; all consumers read from the map result. Tests a-i unchanged numbers within noise.
3. Heightfield terrain: `Terrain.height(x,z)` sampled grid; collision raycast marches the heightfield; ground snapping and water respawn use it.
4. World teardown: dispose chunks, instanced meshes, colliders, life and rings; rebuild for the selected map (menu map picker; M12 rooms carry the map id).
5. `maps/istanbul.ts`: compressed geography per the Decisions layout; landmarks built from boxes, cylinders and ellipsoids (domes as ellipsoids, minarets as cylinders with anchorable tips, bridge towers and cable anchor points, Galata Tower as a cylinder stack); low-rise blocks on hills; Levent-style tower cluster in one corner; plane and cypress tree species; ship masts. Optional ferries, seagulls, trams.
6. Water shader, minimap and lane graph read from the map; traffic follows Istanbul streets (non-grid graph).

**Tests to add.**
- Parameterize c and d by map: anchor availability ≥ 95 % and traversal ground time < 10 % on Istanbul (city route across the peninsula, Golden Horn crossing, Bosphorus shore).
- b fuzz on hills (no below-ground, no tunnelling on slopes); map switch soak (Manhattan ↔ Istanbul x10, no geometry/texture/program growth).
- Map picker UI test; minimap shows Istanbul water; h-style life test on the Istanbul lane graph.

**Risks.** Refactor breadth (many modules assume Manhattan); land it first with zero behaviour change. Landmark recognisability with box/cylinder/ellipsoid colliders only. Hills break the flat-ground assumptions in gait, traffic and pedestrians. Long water spans (Bosphorus) need anchors (ships, bridge) to keep d passing.
