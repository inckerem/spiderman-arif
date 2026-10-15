# SKYTHREAD M11 (combat and enemies) and M12 (multiplayer, rooms, Docker): design

Status: design for implementation agents. Binding inputs: `docs/ROADMAP.md` (M11, M12) and the user decisions restated in the task. All UI strings go to `src/i18n/tr.ts`; docs stay English. Code conventions follow `player/`: numeric constants instead of `const enum` (the tsconfig sets `isolatedModules` and `verbatimModuleSyntax`), no allocation in hot loops, and pure simulation that may use three.js math classes only.

## 0. Findings in the current code that shape the design

| Fact (file) | Consequence |
| --- | --- |
| `generateCity`, `buildCollisionWorld`, `CollisionWorld`, `Terrain`, `tuning`, `core/rng`, `core/math` import no DOM or render code | The server can build the same world from the seed. Combat may use `raycast`, `gatherAabb`, `resolveCapsule`, `resolveSphere`, `supportHeight` and `capsuleFree`. |
| `Player.step` reads `swingPressed/swingReleased/swing`, keeps `holdSwing`, and ends a button line on `rope.byButton && !inp.swing` (player.ts ~319-350) | Combat must be a **pre-filter on `TickInput`** that runs before `player.step`. It takes a whole press-to-release gesture or leaves the input untouched. It never edits rope state. |
| `CharacterAnimator(rig, player: Player)` reads `mode, vel, facing, diving, rollTimer, rope.{attached,anchor,hand}, zip.{tx..ez,hand}, wall.{nx,nz,run}, trav.{kind,t,dur}, groundSurface, world, groundBelow()` plus the `release`/`land`/`attach` events | Extract an `AnimSource` interface that `Player` already satisfies. Remote heroes implement it with a proxy object. |
| `game.ts` `simulate()` runs sample → inject → `fillAim` → `player.step` → events | This is where the combat router and the room link hook in. |
| Vite 8 bundles with rolldown. There is no esbuild or tsx in `node_modules`. Source imports have no extensions (`moduleResolution: bundler`) | Build the server with **`vite build --ssr`**, not `tsc` emit (Node ESM cannot resolve extensionless imports). See §M12.6. |
| Playwright's runner loads TS with extensionless imports in Node | Node-side unit tests (sim, room, codec, names) can be plain Playwright specs with no `page`, and need no new test dependency. |
| Smoke test fails on any console error. A failed `WebSocket` logs one | The client opens a socket only after the player picks multiplayer. |
| `setManual(true)` is used by every spec | It must turn off the crime scheduler and roaming spawns, so the a–j numbers stay the same. |

---

# M11 Combat and enemies

## 1. Module map

```
src/combat/                 PURE (Node-safe): imports only three math, config/tuning, core/*, physics/*, world/types|cityGen|cityCollision
  types.ts                  ids, kinds, states, moves, intents, events (shared with net)
  roster.ts                 per-kind stat tables (reads tuning.enemies)
  combatSim.ts              CombatSim: fixed 30 Hz world of enemies, heroes' health, hits, projectiles
  brains.ts                 thug, bat thug, gunman, brute, drone state machines
  bosses.ts                 Koçbaşı, Kuzgun, Diken
  mover.ts                  ground capsule mover (CollisionWorld), flyer mover (sphere), arena clamp
  projectiles.ts            bullets (delayed hitscan), bolts/darts/bottles (swept spheres)
  crimeEvents.ts            scheduler, arenas, clear/expire, roaming patrols
  spawnPoints.ts            arenas and patrol loops from CityLayout (deterministic, validated at build)
  history.ts                ring buffers of entity positions (lag compensation; SP uses it too)
  hash.ts                   state hash for determinism tests
src/physics/safeSpot.ts     findSafeSpot() moved out of Player (Player keeps a thin wrapper) + findRespawnRoof()
src/sim/room.ts             PURE Room: CombatSim + players + clock + validation + outbox (used by SP and the server)
src/net/roomLink.ts         RoomLink interface; localLink.ts (SP, in-process Room); netLink.ts (M12)
src/net/protocol.ts         message types (object form). M11 uses them in-process; M12 adds codec.ts
src/combat/client/          browser-only logic, still no DOM
  heroCombat.ts             input router, combos, lunge/dodge orchestration, prediction
  meleeTarget.ts            target picking (crosshair cone, close range, free-flow)
  combatView.ts             replicated enemies/projectiles/events + interpolation
src/combat/render/          three.js rendering
  enemyRigs.ts              pooled low-detail SkinnedMesh per archetype (21 joints + boss extra bones)
  enemyAnimator.ts          light FK pose library (not the hero animator)
  droneMesh.ts              one InstancedMesh for all drones
  combatFx.ts               tracers, laser sights, bolts, muzzle flashes, web-pin cocoons, hit sparks (via Particles)
src/ui/combatHud.ts         health, focus, combo, spider-sense, target bar, boss bar, event banner/arrow, down screen
src/debug/combatDrivers.ts  test drivers + combat bot (uses the same input path)
```

## 2. Gameplay rules and tuning (`tuning.combat`, `tuning.enemies`, `tuning.events`)

All values go in `tuning.ts` with `tuningMeta` ranges. They are starting values for playtesting.

**Hero**

| Key | Value | Meaning |
| --- | --- | --- |
| `combat.maxHp` | 100 | |
| `combat.regenDelay` / `regenRate` | 5 s / 12 hp/s | regeneration out of combat (no damage taken for 5 s) |
| `combat.downTime` | 4 s | knocked out, then respawn on a roof |
| `combat.respawnRoofRadius` | 40–180 m | roof search ring (height 12–80 m, `capsuleFree`, not inside an active arena) |
| `combat.closeRange` | 3.0 m | any enemy this close, in the front 220°, takes left click |
| `combat.coneDeg` | 9° | crosshair cone for a lunge target |
| `combat.lungeRangeGround` / `Air` | 12 m / 20 m | |
| `combat.freeflowRange` / `freeflowConeDeg` | 10 m / 120° | during a combo, around the stick direction (or camera forward) |
| `combat.lungeSpeed` / `lungeMaxTime` | 24 m/s / 0.45 s | kinematic, through the capsule resolver like zip |
| `combat.reach` | 1.6 m | hand/foot to enemy capsule surface at contact |
| `combat.comboWindow` | 1.1 s | time after a hit to keep the chain and counter alive |
| `combat.inputBuffer` | 0.25 s | a press during a strike queues the next strike |
| moves: jab/cross/kick/upper | contact at 0.10/0.10/0.14/0.16 s, recovery 0.22/0.22/0.28/0.34 s, damage 10/12/15/20 | the chain cycles. The 4th hit knocks back 5 m/s |
| `combat.airStrikeDmg` / `airHang` | 14 / 0.35 s at gravity x0.2 | air juggle against drones |
| `combat.groundFinisherDmg` | 40 | left click on a DOWN enemy within 3 m. KOs regular enemies |
| `combat.focusPerHit` / `takedownCost` | 12 / 100 | E (`finisher`) on an enemy within 4 m: instant KO, bosses lose 15 % max hp |
| `combat.yankDmg` / `yankRange` / `yankConeDeg` | 5 / 35 m / 6° | right tap on an enemy |
| `combat.pinHold` / `pinTime` | 0.3 s / 4 s | right hold on an enemy. A DOWN enemy pinned stays KO'd |
| `combat.dodgeIframes` / `dodgeLookahead` / `dodgeSpeed` | 0.4 s / 0.8 s / 9 m/s for 0.25 s | |
| `combat.hitStun` / `knockdownTime` | 0.25 s / 0.8 s | |
| `combat.minStrikeInterval` | 0.15 s | server rate check |
| `combat.lagTolerance` | 1.2 m | extra reach allowed when the server validates |

**Enemies** (`tuning.enemies.<kind>`): hp, speed, damage, telegraph (wind-up), cooldown.

| Kind (TR UI) | HP | Speed | Attack | Wind-up | Counterplay |
| --- | --- | --- | --- | --- | --- |
| Thug "Serseri" | 60 | 4.5 | punch 8. Bottle throw 6 at players > 3 m above, within 15 m | 0.45 s | anything |
| Bat thug "Sopalı" | 70 | 4.2 | swing 14 | 0.6 s | dodge, then counter |
| Gunman "Tetikçi" | 50 | 3.5 | 3-round burst, 6 each, range 60 m, LOS, keeps 12–25 m away | aim 0.7 s (laser sight) | dodge. Yank disarms him (he becomes a thug) |
| Brute "Zırhlı" | 180, guard on | 3.2 | slam 22 (unblockable), charge 18 | 0.9 s | front hits are BLOCKED (bounce and stagger the hero). Yank tears the shield off. Hits from behind (>110° off his facing) or from above (hero ≥ 1.2 m higher) land. Pin stuns him for 1.5 s |
| Drone "Dron" | 30 | fly 10 | plasma bolt 7, 25 m/s | 0.6 s | air lunge. Pin or yank drops it (KO) |

**Bosses** (original names and designs, recorded in DECISIONS):

| Boss | Inspiration (not shown) | Look | Kit | Weak point |
| --- | --- | --- | --- | --- |
| **Koçbaşı** ("battering ram") | rhino-like charging brute | hydraulic exosuit, brass ram-plate front, yellow/black hazard stripes, bulldozer shoulder blades. No horn | 1200 hp. Frontal armour x0.2. Charge (1.2 s tell, 22 m/s, 30 dmg). Stomp shockwave (radius 6 m, jump or dodge, 15). Phase 2 under 50 %: double charges | a dodged charge that ends in a wall or obstacle stuns him 3 s (all hits x1, takedowns allowed) |
| **Kuzgun** ("raven") | vulture-like winged flyer | black mechanical blade-feather wings, gas-mask beak respirator, long coat | 900 hp. Flies 15–30 m up. Swoop dive (1.0 s tell, 20). Feather-dart volley (5 x 6). Phase 2 calls in 3 drones | 2 web-pins on the wings drop him to the ground, stunned 4 s. Air strikes while he hovers low |
| **Diken** ("thorn") | scorpion-tailed fighter | segmented mechanical stinger tail (5 extra bones), green and copper plated armour | 1000 hp. Claw chain 3 x 10. Tail stab (0.7 s tell, 25 + poison 2/s for 4 s). Tail sweep (jump) | a dodged tail stab sticks the tail in the ground for 2 s (ground-finisher damage x2). Yank the stuck tail for an extra 1.5 s stun |

**Crime events** (`tuning.events`)

| Type (TR) | Arena | Content |
| --- | --- | --- |
| `robbery` "Soygun" | storefront sidewalk segment | 3 thugs (1 bat) + 1–2 gunmen |
| `gang` "Çete kavgası" | intersection | 6–8 mixed + 1 brute |
| `drones` "Dron saldırısı" | low/mid roof (area ≥ 400 m², height 15–60 m) | 4–6 drones + 2 gunmen on the roof |
| `boss` "<Name> görüldü" | Koçbaşı: avenue/plaza. Kuzgun: downtown roofs and airspace. Diken: park plaza or pier | boss plus 0–4 adds |

Scheduler: first event 20 s after play starts, at 250–700 m from the hero (SP) or chosen near random players (MP). The next one comes 45–75 s after the previous ends. Concurrent events: 2 in SP, and `min(3, 1 + floor(players/4))` in MP. Every 4th cleared event is a boss (cycle Koçbaşı → Kuzgun → Diken). An event expires after 240 s if no hero came within 150 m. It clears when all its enemies are KO. Roaming: 4–6 thugs in pairs patrol sidewalk loops (inset 3.8 m like pedestrians) within 250 m of a hero. They spawn > 120 m from every hero and despawn > 350 m away. Caps: 30 active enemies per SP world, 60 per MP room, 30 replicated per client (nearest). Settings toggle **"Suç olayları"** (default on) disables the scheduler and roaming in SP.

## 3. Pure simulation: key types (`src/combat/types.ts`, `combatSim.ts`)

```ts
export const EK = { THUG: 0, BAT: 1, GUNMAN: 2, BRUTE: 3, DRONE: 4, KOCBASI: 5, KUZGUN: 6, DIKEN: 7 } as const;
export type EnemyKind = (typeof EK)[keyof typeof EK];
export const ES = { IDLE: 0, PATROL: 1, ALERT: 2, APPROACH: 3, CIRCLE: 4, TELEGRAPH: 5, ATTACK: 6, RECOVER: 7,
  STAGGER: 8, DOWN: 9, PINNED: 10, YANKED: 11, KO: 12, SPECIAL: 13 } as const;
export const MOVE = { JAB: 0, CROSS: 1, KICK: 2, UPPER: 3, AIR: 4, GROUND: 5, TAKEDOWN: 6, YANK: 7, PIN: 8 } as const;
export const HIT = { STAGGER: 1, KNOCKDOWN: 2, KO: 4, BLOCKED: 8, BACK: 16, ABOVE: 32 } as const; // bit flags
/** Entity ids: enemies 1..0x7fff, heroes 0x8000 + pid (PvP targets). */
export const HERO_ID_BASE = 0x8000;

export interface Enemy {
  id: number; kind: EnemyKind; state: number; stateT: number;
  pos: Vector3; vel: Vector3; yaw: number;
  hp: number; maxHp: number; guard: number;      // brute shield / boss armour hp; 0 = off
  target: number;                                 // hero id or -1
  eventId: number; arena: number;                 // -1 roaming
  flags: number;                                  // AIRBORNE, DISARMED, SHIELDLESS, TAIL_STUCK, ...
  tele: { atk: number; target: number; impactAt: number } | null;
  anim: number; animT0: number;                   // replicated pose id + start (sim seconds)
  slot: number;                                   // melee attack slot around its target (max 2 attackers)
}

export interface HeroState {            // what the sim needs from a hero (from Player in SP, wire in MP)
  pid: number; x: number; y: number; z: number; vx: number; vy: number; vz: number;
  mode: number; grounded: boolean; facing: number; afk: boolean; t: number; // t = sim time of sample
}
export interface CombatHero extends HeroState {
  hp: number; maxHp: number; down: boolean; downUntil: number; lastHurt: number;
  iframesUntil: number; combo: number; comboUntil: number; focus: number; lastStrike: number;
}

export type CombatIntent =
  | { k: 'strike'; seq: number; target: number; move: number; viewT: number; hx: number; hy: number; hz: number }
  | { k: 'yank' | 'pin' | 'takedown'; seq: number; target: number; viewT: number; hx: number; hy: number; hz: number }
  | { k: 'dodge'; seq: number; t: number };

export type CombatEvent =
  | { e: 'tele'; src: number; tgt: number; atk: number; at: number }
  | { e: 'hit'; src: number; tgt: number; move: number; dmg: number; hp: number; fl: number; kx: number; ky: number; kz: number }
  | { e: 'miss'; src: number; tgt: number }                    // dodged
  | { e: 'shot'; src: number; x: number; y: number; z: number; tx: number; ty: number; tz: number; hit: boolean }
  | { e: 'proj'; id: number; kind: number; x: number; y: number; z: number; vx: number; vy: number; vz: number }
  | { e: 'projEnd'; id: number; x: number; y: number; z: number; tgt: number }
  | { e: 'yank' | 'pin'; src: number; tgt: number; dur: number }
  | { e: 'down'; pid: number; until: number } | { e: 'respawn'; pid: number; x: number; y: number; z: number }
  | { e: 'evStart'; ev: CrimeEventInfo } | { e: 'evEnd'; id: number; result: 'clear' | 'expire' }
  | { e: 'boss'; id: number; phase: number }
  | { e: 'rej'; pid: number; seq: number; why: 'range' | 'rate' | 'time' | 'state' | 'pvp' };

export interface CrimeEventInfo { id: number; type: 'robbery' | 'gang' | 'drones' | 'boss'; boss: number;
  x: number; y: number; z: number; radius: number; enemiesLeft: number; startedAt: number }

export class CombatSim {
  static readonly DT = 1 / 30;
  readonly enemies: Enemy[];                  // pooled, KO entries recycled after 4 s
  readonly heroes: Map<number, CombatHero>;
  time = 0; scheduler: boolean; roaming: boolean; pvp: boolean;
  constructor(world: CollisionWorld, layout: CityLayout, spawns: SpawnPoints, seed: number, opts: { pvp: boolean; maxEnemies: number });
  upsertHero(s: HeroState): void;             // latest movement sample (client-authoritative)
  removeHero(pid: number): void;
  intent(pid: number, i: CombatIntent): void; // validated at the next step
  step(): void;                               // exactly DT
  drainEvents(out: CombatEvent[]): void;
  positionAt(id: number, t: number, out: Vector3): boolean; // history, lag compensation
  debugSpawn(kind: EnemyKind, x: number, y: number, z: number): number;
  startEvent(type: CrimeEventInfo['type'], x?: number, z?: number, boss?: number): number;
}
```

Determinism: one `Rng(seed)` per sim. No `Math.random`, `Date` or `performance` in `src/combat`. The same intents at the same steps give the same `hash()`.

**Per-step order (30 Hz):** (1) extrapolate each hero to `time` from its last sample (≤ 150 ms) and record history. (2) Validate and apply queued intents (§5). (3) Crime scheduler and roaming spawn/despawn. (4) Brains pick state and target (nearest non-afk, non-down hero within 40 m with LOS, checked every 0.5 s with staggered phases). Melee slots allow at most 2 attackers per hero. Others circle at 4–6 m. (5) Movers: ground uses an upright capsule r 0.4 h 1.8, gravity, `gatherAabb` + `resolveCapsule` with substeps ≤ 0.3 m, wall probes (2 rays at ±30°, 1.5 m) that steer along the tangent, separation 1.2 m, and a leash to the arena rect +8 m (hard roof-edge clamp unless knocked back; a fall of more than 6 m KOs). Flyers use steering toward an orbit point (radius 8 m, +5 m above the target) with `resolveSphere(r 0.6)`. (6) Telegraphs fire their attack at `impactAt`. A hit on a hero resolves at `impactAt + grace(pid)`, where grace = clamp(RTT/2 + 50 ms, 0, 200 ms) (0 in SP). It misses if a dodge intent stamped in `[impactAt − dodgeIframes, impactAt + 0.05]` exists. (7) Projectiles: swept sphere against the hero capsule (segment-to-segment distance) and world `raycast`. (8) Hero regen, down → respawn (`findRespawnRoof`). (9) Event clear/expire. Budget: ≤ 1 ms per step with 30 enemies.

## 4. Client: input routing that keeps the swing feel (`combat/client/heroCombat.ts`)

`TickInput` gains `attack, attackPressed, finisherPressed: boolean`. Bindings gain `attack: ['KeyF', null]` (always melee, auto-target) and `finisher: ['KeyE', null]`. M10's touch Attack button writes `attack/attackPressed`. Its long press (0.4 s) writes `finisherPressed`.

`Game.simulate` order becomes: `input.sample → injectInput → fillAim → heroCombat.route(inp) → player.step(inp) → heroCombat.after(player.events) → link.tick(dt)`.

```ts
export class HeroCombat {
  constructor(player: Player, world: CollisionWorld, view: CombatView, link: RoomLink);
  /** Takes whole gestures: once a press is captured, its hold and release never reach Player. */
  route(inp: TickInput): void;
  after(events: readonly PlayerEvent[]): void; // contact frames → intents + predicted hit FX
  readonly hud: { combo: number; focus: number; target: number; threat: ThreatInfo | null };
  enabled: boolean;
}
```

Routing rules, evaluated on edges only:

1. **Left press** (`swingPressed`, also `attackPressed` with auto-target): `pick()` returns a target in this priority order:
   1. a DOWN enemy within 3 m (ground finisher);
   2. any enemy within `closeRange` in the front 220°;
   3. an enemy whose chest is within `coneDeg` of the crosshair ray, within lunge range, with LOS;
   4. during a combo (`comboUntil > now`) or when engaged on the ground (alerted enemy within 8 m), the best free-flow target: score = cos(angle to the stick or camera direction) − dist/freeflowRange;
   5. for `attackPressed` only: the nearest enemy in view within lunge range, else a whiff jab.

   With a target: set `captureL = true`, zero `swing/swingPressed/swingReleased` for this tick, and start or queue the strike. With no target: leave the input untouched. The swing works exactly as today: hold, sub-frame tap, and `byButton` release semantics.
2. **While `captureL`:** zero the three swing fields every tick until a tick sees `!inp.swing || inp.swingReleased`, then clear `captureL` (after zeroing that tick too). Player therefore sees `swing=false`, `holdSwing` stays false, and no line fires. A capture can only start when the button was up, so no button-held rope can be attached at that moment and the `byButton` check never cuts a live line.
3. **Right press** (`zipPressed`): an enemy in a 6° cone within 35 m with LOS → `captureR`. Release before `pinHold` sends a **yank**. Holding to `pinHold` sends a **pin**. Zero `zip/zipPressed` while captured. No enemy → pull line as today.
4. **Space** (`jumpPressed`) while `view.threat` targets self with `impactAt − now ∈ [−0.05, dodgeLookahead]` (or a projectile ETA < 0.5 s): consume it (`jumpPressed=false`, mask `jump` until released) and **dodge**. Grounded: `player.beginDodge(dir)` (sidestep away from the attacker, or backflip). Swinging or in the air: the dodge is animation plus i-frames only and **the line stays attached**. Otherwise Space works as today.
5. **E** (`finisherPressed`) with focus ≥ 100 and an enemy within 4 m → takedown.
6. While the hero is DOWN, the router zeroes all movement and action input.

**Player additions** (`player.ts`): `MODE_STRIKE = 6` (`MODE_NAMES` += `'strike'`) with sub-kinds lunge/strike/dodge. It moves kinematically through `integrate()` with the normal resolver. If blocked or pushed off course it aborts to air or ground like zip. In the air the line is cut (no push) before a lunge.

```ts
beginLunge(tx: number, ty: number, tz: number, air: boolean): boolean; // stop at reach−0.2 m, ≤ lungeMaxTime
beginStrike(move: number, dur: number, root: number): void;            // small root motion, faces target
beginDodge(dx: number, dz: number, air: boolean): void;
applyHit(kx: number, ky: number, kz: number, stun: number): void;      // knockback from 'hit' on self
setDown(down: boolean): void;                                           // cuts lines, input ignored by router
readonly strike: { kind: number; t: number; dur: number; move: number; tx: number; ty: number; tz: number };
readonly combatAnim: { action: number; t0: number; dur: number; side: number }; // read by the animator
```

New `PlayerEvent`s: `strike {move}`, `dodge`, `hurt {dmg}`, `down`, `revive`. They feed audio, the animator and (M12) replication.

**Animator:** `CharacterAnimator(rig, src: AnimSource)`. A new `S_COMBAT` state for MODE_STRIKE plus an overlay stage after the base blend and before limb collision: punches upper body, kicks/uppercut/dodge/hurt/down full body. It is driven by `src.combatAnim` with weight curves of 0.06 s in and 0.12 s out.

**Prediction:** at the contact frame `after()` checks reach against the CombatView's interpolated target. If in reach it plays the spark, sound and enemy flinch immediately (render-only flag) and sends the intent with `viewT` = the render time used, and the hero position. Damage numbers, KO and the combo/focus HUD come from confirmed `hit` events. A rejected hit only means a flinch played without damage, which is acceptable.

## 5. Intent validation (in `CombatSim`, identical in SP and on the server)

- `viewT ∈ [now − 0.4 s, now + 0.05 s]`. Hero position within 4 m of its extrapolated last sample.
- Target position from `positionAt(target, viewT)`. Strike: distance to capsule ≤ `reach + lagTolerance`. Yank/pin: ≤ 35 m with LOS from the hero's chest. Takedown: ≤ 4 m and focus ≥ 100.
- Rate: strikes ≥ `minStrikeInterval·0.8` apart. At most 15 intents/s.
- State: the hero is not DOWN, the target is not KO, and hero targets require `pvp`.
- Brute guard: blocked unless the attack comes from behind or above, or the shield is gone. Boss rules as in the table.
- On failure emit `rej`.

## 6. Rendering and performance

| Item | Approach | Draw calls (scene + shadow) |
| --- | --- | --- |
| Humanoid enemies | pool of 24 `SkinnedMesh` built with `GeomBuilder` on the 21-joint skeleton (~1.2k tris, per-vertex colour slots like costumes). Variants: thug (hoodie/cap), bat, gunman (jacket, pistol prop on handR), brute (bulky proportions, riot shield prop on foreArmL). Geometry shared per archetype, skeleton per instance | ≤ 48 |
| Bosses | own rigs: Koçbaşı (scaled 1.6x plus ram plate), Kuzgun (+4 wing bones), Diken (+5 tail bones). Max 1 boss | 2–4 |
| Drones | one `InstancedMesh` (body, rotors spun in the vertex shader) | 2 |
| FX | tracers, laser sights, bolts, darts: one instanced quad mesh. Web-pin cocoons: one InstancedMesh. Sparks via `Particles` | 3–4 |

Total added ≤ ~60 calls (now ~230, budget 600). `EnemyAnimator`: FK pose library (idle, walk/run cycle, punch, bat swing, aim, shoot, charge, stagger, knockdown, get-up, pinned, yanked tumble, KO, taunt), ≤ 0.02 ms per enemy. LOD: full pose < 60 m, pose every 3rd frame at 60–150 m, hidden beyond 150 m (minimap only). Frustum cull per rig with a bounding sphere.

## 7. HUD, audio, strings

`combatHud.ts`: segmented health bar bottom-left with the focus meter under it. Combo counter beside the crosshair (`x12` with a ring that drains over `comboWindow`). Spider-sense: chevrons around the crosshair toward the attacker plus a screen-edge pulse while `threat` is set. Target health bar above the locked enemy (DOM projected like `anchorScreen`). Boss bar top centre with the name and phase. Event banner and an off-screen arrow with distance ("Soygun · 340 m"). Down screen "Bayıldın" with a countdown. The minimap gets `MinimapEvent[]` (pulsing icon per type) and red enemy dots within its radius. Synth SFX in `audio/sfx.ts`: punch/kick thump, whoosh, block clang, gunshot, drone hum (nearest drone, looped), bolt zip, boss stingers, spider-sense tick. The rooftop moment does not arm while an alerted enemy is within 80 m, and a hit on the hero ends it.

## 8. Single player wiring (`net/localLink.ts`)

```ts
export interface RoomLink {
  readonly mode: 'local' | 'online';
  readonly selfPid: number;
  readonly view: CombatView;           // enemies, projectiles, events, self health, threats
  readonly remotes: RemoteRoster;      // empty in local mode
  now(): number;                       // room time (s) used for view sampling and intents
  renderTime(): number;                // now() − renderDelay (local: one combat tick; online: 0.1 s)
  tick(dt: number, self: Player, events: readonly PlayerEvent[]): void; // every 120 Hz tick
  intent(i: CombatIntent): void;
  setPaused(p: boolean): void;         // local: stops stepping; online: sets afk
  close(): void;
}
```

`LocalLink` owns a `Room` (§M12.3) with a single slot (pid 1). Each tick it passes the hero's state object straight to `room.onState`, accumulates dt, and calls `room.step()` at 30 Hz. The Room's outbox goes straight to `view.apply(msg)` with no serialization. The client therefore runs the same Room, validation and event code as the server. Manual test mode keeps this exactly deterministic (the 30 Hz step is every 4th tick).

## 9. M11 tests

`window.__game.combat`: `spawn(kind,x,y,z)`, `enemies()`, `clear()`, `state()` (hp, down, combo, focus, threat, events), `startEvent(type, x?, z?, boss?)`, `setScheduler(on)`, `setHp(v)`, `killAll()`, and the drivers below. `setManual(true)` sets the scheduler and roaming off.

| Spec | Checks |
| --- | --- |
| `tests/combatSim.spec.ts` (Node, no page) | generate the city in Node, build spawn points (all `capsuleFree`), run 1800 steps with scripted heroes: damage, regen, down → roof respawn (support from a building collider, y ≥ 12), two runs give the same hash. **Purity:** walk the import graph of `src/combat/**` (minus `render/`), `src/sim/**`, `src/net/{protocol,codec,names,maps,clock,interp}.ts` and fail on anything outside the allowed list (three, config/tuning, core/math|rng, physics/*, world/types|cityGen|cityCollision, player/targeting types) and on `window`/`document` tokens |
| `tests/combat.spec.ts` (browser, manual mode) | thug in the crosshair at 8 m → left click → MODE_STRIKE lunge, `hit` event, no `webFire`. No enemy → `webFire`. Sub-frame click with no enemy still attaches (rerun `lineControlsTest`). Combo increments over 4 hits and resets after `comboWindow`. Yank moves the enemy ≥ 60 % of the distance toward the hero. Pin keeps the position within 0.2 m for `pinTime`. Bat telegraph → Space in the window → `miss` and no damage. Without Space → damage. Gunmen vs a city-route swing: hits > 0 without dodge, 0 with the bot dodging on threat, and the line stays attached through air dodges. Brute: frontal hits blocked, yank removes the shield. Drone air lunge KOs. Death → respawn on a roof within `downTime + 1 s`. Regen to full. Event: start → minimap has the marker → `killAll` → `evEnd clear`. **Combat bot** clears one robbery, gang and drone event plus each boss (time limit 240 s each). Draw calls ≤ 600 with 30 enemies at the widest view |
| fuzz b / soak e | fuzz spawns 20 enemies around the hero (0 NaN, 0 enemy capsules > 3 cm inside geometry, 0 under terrain). Soak enables the scheduler (heap slope unchanged, geometry/program counts flat after first spawn of each archetype, pool reuse) |

## 10. M11 implementation checklist (each chunk ends with typecheck + the named specs)

1. **Foundations:** tuning sections; `combat/types.ts`, `roster.ts`; move `findSafeSpot` to `physics/safeSpot.ts` plus `findRespawnRoof`; `spawnPoints.ts`. Verify: `combatSim.spec` (spawn points + purity skeleton); swing/fuzz unchanged.
2. **Sim core with thugs:** `CombatSim`, `mover.ts`, `brains.ts` (thug, bat), hero health/regen/down/respawn, telegraph/dodge resolution, `history.ts`, `hash.ts`. Verify: Node spec (damage, regen, respawn, determinism).
3. **Room and LocalLink:** `sim/room.ts` (single-slot use), `net/protocol.ts` object types, `CombatView`, hook into `Game.simulate`, test API `combat.*`. Temporary debug capsules allowed. Verify: browser spawn plus enemies chasing a teleported hero.
4. **Hero side:** `TickInput` fields and bindings (`attack`, `finisher` plus the key-bindings screen), `MODE_STRIKE`, `HeroCombat` routing rules 1–6, `AnimSource` refactor, animator combat overlay. Verify: routing and combo specs, `swing.spec` and `keybindings.spec` unchanged, `character.spec` NaN-free.
5. **Enemy rendering:** rigs, `EnemyAnimator`, drones, FX, LOD. Verify: screenshots (day/night) and the draw-call check.
6. **Roster:** gunman (laser, delayed hitscan, swinging targets), brute (guard, shield yank), drone (flyer, bolts, air juggle). Verify: those specs.
7. **Events and HUD:** `crimeEvents.ts`, roaming, minimap events and enemy dots, `combatHud.ts`, strings, SFX, settings toggle, rooftop-moment interplay. Verify: event spec plus `ui.spec`/`attract.spec` unchanged.
8. **Bosses:** sim kits, rigs, arenas. Verify: boss bot runs.
9. **Hardening:** combat bot completes everything, fuzz/soak integration, M10 Attack button wired, docs (ARCHITECTURE §2/§9, DECISIONS: names, routing rules, 30 Hz), full suite.

---

# M12 Multiplayer, rooms, Docker

## 1. Authority and rates

| Concern | Authority | Rate |
| --- | --- | --- |
| Own hero movement, swing, animation | client (120 Hz local sim) | upload 20 Hz |
| Enemies, projectiles, events, health, hits, combo/focus, respawn points | server `Room` / `CombatSim` | **30 Hz sim**. Enemy snapshots 15 Hz. Events immediately |
| Day-night clock | server per room | `clock` every 5 s and on join |
| Movement sanity | server | every received state |

Why 30 Hz: 33 ms granularity is well below the combat windows (telegraphs ≥ 0.45 s, combo window 1.1 s), and the cost is ~4x lower than 120 Hz (≈ 2 ms/step for 60 enemies, so ~6 % of a core per full room). SP uses the same 30 Hz, so the behaviour is identical. Hero movement stays at 120 Hz on the client because it is never simulated on the server.

## 2. Protocol (`src/net/protocol.ts`, `codec.ts`), `PROTOCOL_VERSION = 1`

Text frames carry JSON control and events. Binary frames carry high-rate state: the first byte is the opcode, little-endian `DataView`. ws `maxPayload` is 4096. permessage-deflate is off.

```ts
export type MapId = 'manhattan';                         // M13 adds 'istanbul'
export interface RoomInfo { id: string; map: MapId; seed: number; public: boolean; code?: string; pvp: boolean; index: number }
export type ClientMsg =
  | { t: 'hello'; v: number; name: string; costume: string; map: MapId;
      join: { kind: 'public' } | { kind: 'code'; code: string } | { kind: 'create'; pvp: boolean };
      token?: string }                                   // reconnect token
  | { t: 'act'; i: CombatIntent }
  | { t: 'ping'; c: number }                             // client ms
  | { t: 'leave' }
  | { t: 'dbg'; op: 'spawn' | 'event' | 'killAll'; a: number[] }; // only when server TEST_HOOKS=1
export type ServerMsg =
  | { t: 'welcome'; v: number; pid: number; name: string; room: RoomInfo; token: string; now: number;
      players: Array<{ pid: number; name: string; costume: string }>; events: CrimeEventInfo[];
      clock: { hour: number; dayLen: number }; hp: number }
  | { t: 'reject'; why: 'version' | 'name' | 'profanity' | 'full' | 'notFound' | 'rate' | 'server' }
  | { t: 'join'; pid: number; name: string; costume: string } | { t: 'left'; pid: number; why: string }
  | { t: 'ce'; ev: CombatEvent[] }                      // batched per server tick
  | { t: 'clock'; hour: number; dayLen: number }
  | { t: 'correct'; x: number; y: number; z: number; why: 'speed' | 'teleport' | 'bounds' | 'nan' }
  | { t: 'pong'; c: number; s: number }
  | { t: 'kick'; why: string };
// Binary: 0x01 C→S hero state, 0x02 S→C hero states batch, 0x03 S→C enemy snapshot
```

**Hero state (0x01, ~34–58 B):** `u16 seq, u32 tMs (client's estimate of room time), f32 x,y,z, i16 vx,vy,vz (×100), u16 facing, u8 mode, u8 flags` (grounded, diving, ropeAttached, ropeFiring, hand, down, afk, paused), `u8 teleportCounter`, `u8 combatAction, u8 combatT (×100)`. Optional blocks gated by flags: anchor `f32×3` (rope or zip), zip end `f32×3`, wall `i8 nx,nz` + `u8 run`, trav `u8 kind, u8 t, u8 dur`. Then `u8 nEvents` + events (`u8 type` + payload: land impact/roll/surface, release good/broken/power, attach hand/xyz/normal, zipStart, wallGrab, jump, dive, boost, splash, strike, dodge). **0x02** = `u8 count` + per player `u8 pid` + the same body. The server forwards the client's bytes after clamping `tMs` into `[recv − 1000, recv]`.

**Enemy snapshot (0x03, 16 B per enemy):** header `u32 roomMs, u8 count`. Each entry: `u16 id, u8 kind, u8 state, i16 x,z (×20 = 5 cm), i16 y (×50), u16 yaw, u8 hp% , u8 guard%, u8 anim, u8 animT (×50), u8 flags, u8 target pid`. It includes the 30 nearest enemies within 300 m of the receiver. Full state every snapshot, no deltas: TCP is reliable and the snapshot fits the budget, so there is no ack bookkeeping. Spawn and KO also go out as reliable `ce` events.

**Bandwidth (16 players, 30 enemies near each):**

| Stream | Per client down | Per client up |
| --- | --- | --- |
| 15 remote heroes × 20 Hz × ~45 B | 13.5 KB/s | — |
| enemies 15 Hz × (5 + 30×16) B | 7.3 KB/s | — |
| events/clock/pong (JSON) | ~2 KB/s | — |
| own state 20 Hz × ~45 B, intents, pings | — | ~1.2 KB/s |
| **Total** | **~23 KB/s (~185 kbit/s)** | **~1.2 KB/s** |

Server egress for a full room is ~370 KB/s (~3 Mbit/s). JSON for hero states would be ~5x larger, which is why they are binary.

**Clock sync** (`net/clock.ts`): ping every 2 s. Keep 8 samples. offset = `s − (c + rtt/2)` of the minimum-RTT sample, slewed at ≤ 5 ms/s. `roomNow()` = performance.now() + offset.

## 3. Shared `Room` (`src/sim/room.ts`, pure)

```ts
export interface RoomConfig { id: string; map: MapRuntime; pvp: boolean; maxPlayers: number; publicRoom: boolean; testHooks: boolean }
export interface MapRuntime { id: MapId; seed: number; layout: CityLayout; world: CollisionWorld; spawns: SpawnPoints } // one per map, shared by rooms
export interface RoomOut { send(pid: number, m: ServerMsg | Uint8Array): void; broadcast(m: ServerMsg | Uint8Array, except?: number): void }
export class Room {
  constructor(cfg: RoomConfig, out: RoomOut, seed: number);
  readonly players: Map<number, Slot>;            // name, costume, token, lastState, strikes, violations, rtt, disconnectedAt
  admit(name: string, costume: string, token?: string): { pid: number; name: string } | { reject: 'full' | 'name' };
  drop(pid: number, keepForReconnect: boolean): void; // keep slot 30 s
  onState(pid: number, s: HeroState, raw: Uint8Array | null, recvMs: number): void; // sanity check → sim.upsertHero; raw is relayed
  onIntent(pid: number, i: CombatIntent): void;
  step(nowMs: number): void;                      // 30 Hz: sim.step, ce batch, snapshots every 2nd step, relay batch, clock
  readonly hour: number;                          // shared clock
  get empty(): boolean;
}
```

Movement sanity in `onState`: reject NaN; enforce bounds `layout.bounds ± 400`, y ∈ [−5, 900]. Allowed displacement = `110 m/s × Δt + 2 m`. A jump beyond that is accepted only when `teleportCounter` changed **and** the new spot is within 80 m (water or recovery respawn), at `layout.spawn`, or at the server-issued respawn point. Otherwise the server sends `correct` with the last valid position and the client teleports there. More than 5 corrections in 10 s means `kick`. Intents are validated as in M11 §5.

## 4. Client networking

- `net/netLink.ts` implements `RoomLink` over `WebSocket(new URL('ws', location.href))` with ws/wss chosen by protocol. That works behind any subpath because of `base: './'`. A dev-only `?ws=` override is used by the tests. The connect timeout is 4 s. On failure it shows the toast "Sunucuya ulaşılamadı, tek oyunculu başlıyor" and switches to `LocalLink` at the current hero position.
- The local `CombatSim` is not run in online mode. `CombatView.apply(msg)` buffers snapshots. Enemies render at `roomNow − 0.1 s` with linear position/yaw interpolation, extrapolate ≤ 0.15 s on underrun, and snap on a state change to YANKED/KO.
- **Reconnect:** the token (128 bit) lives in `sessionStorage`. Retries use backoff 0.5, 1, 2, 4, 8 s. The server keeps the slot (name, hp, pid) for 30 s, with the hero invisible to enemies and invulnerable. After that the client offers "Tek oyunculu devam et".
- **Clock:** `DayNight` advances locally and is pulled toward `room.hour` (wrap-aware; snap if off by > 0.05 h, else blend over 2 s). T, Y and 1–4 are disabled online (toast "Saat oda ile paylaşılıyor"). The rooftop moment still sets `hold` locally. On its end it restores to the **current shared hour** (`RooftopMoment` gets `restoreHour: () => number`).
- **Pause online:** the menu opens and the game keeps running. State flag `afk`: enemies ignore the hero and it cannot be damaged. In PvP it cannot attack for 3 s after unpausing.

## 5. Remote heroes (`character/animSource.ts`, `character/remotePlayer.ts`, `net/remoteRoster.ts`)

```ts
export interface AnimSource {          // satisfied by Player structurally; animator depends only on this
  readonly mode: number; readonly vel: Vector3; readonly facing: number; readonly diving: boolean; readonly rollTimer: number;
  readonly groundSurface: number; readonly world: CollisionWorld;
  readonly rope: { attached: boolean; hand: number; anchor: { x: number; y: number; z: number } };
  readonly zip: { tx: number; ty: number; tz: number; ex: number; ey: number; ez: number; hand: number };
  readonly wall: { nx: number; nz: number; run: number };
  readonly trav: { kind: number; t: number; dur: number };
  readonly combatAnim: { action: number; t0: number; dur: number; side: number };
  groundBelow(x: number, y: number, z: number): number;
}
export class RemotePlayer implements AnimSource {
  readonly pid: number; name: string; costume: CostumeId;
  readonly buf: InterpBuffer<HeroSample>;  // 32 samples, keyed by room ms
  readonly pos: Vector3; readonly rig: CharacterRig; readonly animator: CharacterAnimator; readonly web: WebLine;
  /** Sample at renderTime, fill AnimSource fields, release due events into animator/fx/audio. */
  frame(renderTime: number, dt: number, lod: 0 | 1 | 2 | 3): void;
}
```

Events carried in a state packet are queued with that packet's time and fire when `renderTime` passes it, so attach/release line up with the motion. A changed `teleportCounter` snaps (no lerp). `combatAnim` is replicated as action + age. Name tags: a DOM pool (`ui/nameTags.ts`) projected each frame, hidden beyond 120 m or when a raycast every 200 ms finds them occluded. Remote SFX play at distance-attenuated gain.

**LOD:** (0) < 60 m and in the frustum: full animator every frame. (1) 60–150 m: animator every 3rd frame with limb collision and foot IK off (`animator.lite`). (2) 150–500 m: rig hidden, shown as one shared instanced low-poly silhouette coloured by costume (one draw call for all). (3) beyond: minimap dot only. Off-frustum heroes skip the animator and run `reset()` when they reappear. Worst case 15 full heroes ≈ 30 + 15 web lines + 1 ≈ 46 draw calls, with animator ≤ 1.5 ms in total but typically 4–6 heroes at tier 0.

## 6. Server (`server/`, Node 22, TypeScript, `ws`)

```
server/main.ts         http.createServer: static dist/, GET /healthz, WS upgrade on /ws; 30 Hz drift-corrected loop over all rooms
server/config.ts       env: PORT=8080 HOST=0.0.0.0 STATIC_DIR=dist MAX_PLAYERS_PER_ROOM=16 MAX_ROOMS=200
                       MAX_CONN_PER_IP=8 PRIVATE_ROOM_IDLE_S=60 RECONNECT_GRACE_S=30 TRUST_PROXY=0
                       ALLOWED_ORIGINS= (empty = any) TEST_HOOKS=0 LOG_LEVEL=info
server/static.ts       MIME map, path-traversal guard, index.html no-cache, assets/* immutable, 404
server/roomManager.ts  maps → MapRuntime (built once at start); public rooms per map: join the lowest-index
                       non-full "public #n", open #n+1 when all are full, delete empty #n>1;
                       private: code from "ABCDEFGHJKMNPQRSTUVWXYZ23456789" (crypto.randomInt, retry on clash),
                       creator's map + pvp flag; delete after PRIVATE_ROOM_IDLE_S empty
server/session.ts      per socket: hello once within 5 s, token buckets (state 30/s burst 40, act 15/s, other 5/s),
                       oversize/garbage → close 1009/1008, 10 s sustained abuse → kick; ping every 20 s, terminate after 2 misses
```

Names (`src/net/names.ts`, shared so the client can give instant feedback): NFC normalize, trim, 3–16 chars of `[A-Za-z0-9ÇĞİÖŞÜçğıöşü _.-]`, no zero-width or control characters. Profanity: lowercase with `toLocaleLowerCase('tr')`, map leetspeak (0→o 1→i 3→e 4→a 5→s 7→t @→a $→s), strip separators, collapse repeated letters, test substrings against a compact TR+EN stem list, with an allowlist for false positives (e.g. "sikke", "ambulans"). Uniqueness: the server appends `#2`, `#3`, … to the display name within a room. The client remembers the bare name in `localStorage['skythread.name.v1']`.

**Build choice: `vite build --ssr` (rolldown) over tsx or tsc emit.** It adds no dev dependency, because Vite 8 already ships rolldown. It uses the same `bundler` resolution as the client, so the extensionless shared imports from `src/` just work, whereas plain `tsc` output fails in Node ESM. It produces one prebuilt `dist-server/server.mjs` that starts instantly with no runtime transpiler in production (tsx would put a transform step into the container). It builds in under a second. `vite.server.config.ts`: `build.ssr = 'server/main.ts'`, `outDir: 'dist-server'`, `target: 'node22'`, `ssr.noExternal: ['three']` (tree-shaken math only), external `ws`. Typecheck: `tsconfig.server.json` (`types: ['node']`, includes `server`, `src/combat`, `src/sim`, `src/net`, `src/physics`, `src/world`, `src/config`, `src/core`). `npm run typecheck` runs both configs. New deps: `ws@8.18.3`, dev `@types/ws@8.18.1`. Scripts: `build:server`, `server` (`node dist-server/server.mjs`), `server:test` (`build:server` then `PORT=8787 HOST=127.0.0.1 STATIC_DIR= TEST_HOOKS=1 node dist-server/server.mjs`).

`vite.config.ts`: hosts stay 127.0.0.1. Add `server.proxy['/ws'] = { target: 'ws://127.0.0.1:8787', ws: true }` (and the same for `preview`). The launcher gets an optional `--sunucu` flag that runs `dist-server/server.mjs` on 127.0.0.1:4173 instead of `vite preview`.

## 7. Docker and Nginx

```dockerfile
# Dockerfile
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build && npm run build:server

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 STATIC_DIR=/app/dist
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist-server/server.mjs"]
```

`.dockerignore`: node_modules, dist, dist-server, .tools, test-results, .git. `docker-compose.yml`: one service `skythread`, `build: .`, `restart: unless-stopped`, `ports: ["127.0.0.1:8080:8080"]` (only Nginx is public), env (`MAX_PLAYERS_PER_ROOM=16`, `TRUST_PROXY=1`, `ALLOWED_ORIGINS=https://oyun.example.com`), `read_only: true`, `tmpfs: [/tmp]`, `security_opt: [no-new-privileges:true]`, `mem_limit: 512m`. `/healthz` → `{ok, rooms, players, uptime, version}`.

`deploy/nginx/oyun.example.com.conf`:

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }
server { listen 80; listen [::]:80; server_name oyun.example.com; return 301 https://$host$request_uri; }
server {
  listen 443 ssl; listen [::]:443 ssl; http2 on; server_name oyun.example.com;
  ssl_certificate     /etc/letsencrypt/live/oyun.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/oyun.example.com/privkey.pem;
  gzip on; gzip_types application/javascript text/css application/json image/svg+xml;
  location /ws {
    proxy_pass http://127.0.0.1:8080; proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme; proxy_buffering off;
    proxy_read_timeout 3600s; proxy_send_timeout 3600s;
  }
  location / { proxy_pass http://127.0.0.1:8080; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; }
}
```

## 8. UI flow (Turkish)

The main menu keeps **Oyna** (single player, unchanged; tests rely on it) and adds **Çok Oyunculu**. That screen has: name field (pre-filled, live validation messages), map picker (Manhattan; İstanbul in M13), **Herkese Açık Odaya Katıl**, **Özel Oda Kur** (toggle "Oyuncular birbirine vurabilir (PvP)"), and **Kodla Katıl** (6-character field, upper-cased). `?oda=CODE` on boot opens this screen with the code filled in. The pause menu online shows the room name/code, **Davet bağlantısını kopyala** (`location.origin + location.pathname + '?oda=' + code`) and the player list. Toasts for joined/left/kicked/reconnecting.

## 9. M12 tests

| Spec | Checks |
| --- | --- |
| `tests/server.spec.ts` (Node, no page) | codec round trips (hero state with every optional block and event type, snapshot quantization error ≤ 5 cm and 0.01 rad); names (length, charset, profanity incl. leetspeak, allowlist, `#2`/`#3`); room codes (alphabet, 10k unique); RoomManager (16 fill public #1, 17th → #2, empty #2 deleted, private code join, `notFound`); Room sanity (110 m/s ok, teleport without counter → `correct`, 6 in 10 s → `kick`, valid water-respawn teleport accepted); rate limiter; **SP/server parity**: a `Room` stepped through `LocalLink` and a bare `Room` with the same scripted states and intents emit identical `ce` streams |
| `tests/net.spec.ts` (browsers + `tests/netBot.ts` raw-ws bots) | Playwright `webServer` becomes an array: the existing `npm run dev` plus `{ command: 'npm run server:test', url: 'http://127.0.0.1:8787/healthz', reuseExistingServer: true }`. Cases: two contexts join public and see each other (remote position within 0.5 m of the source after 1 s, name tag visible); 15 bots + 1 browser fill a room, a 17th lands in public #2; private room via UI and via `/?oda=CODE`; PvP hit lands in a private PvP room, a hero-target intent is `rej pvp` in public; duplicate name gets `#2`, a profane name is rejected with a UI message; a cheat bot teleporting is corrected, then kicked; a `dbg spawn` enemy killed by A gives the same `hit`/KO sequence on A and B; hour difference between clients < 0.02 h; `?ws=ws://127.0.0.1:9` → fallback toast and SP within 5 s (that single expected console error filtered); reconnect after `__game.net.dropSocket()` keeps pid, name and hp within 3 s; perf: 15 bots swinging around the browser hero (replaying recorded paths) keep draw calls ≤ 600 and remote-hero animator time ≤ 2 ms per frame |
| Docker (manual gate where Docker exists) | `docker compose up -d --build`; `curl -f localhost:8080/healthz`; `node tests/netBot.ts`-style probe connects to `ws://localhost:8080/ws` and gets `welcome`; container reports healthy |

## 10. M12 implementation checklist

1. **Protocol:** `net/protocol.ts` (finalize), `codec.ts`, `names.ts`, `maps.ts` (`manhattan` → seed 1337; online ignores `?seed`), `clock.ts`, `interp.ts`. Verify: `server.spec` codec, names and codes.
2. **Remote rendering offline:** `AnimSource` already in place (M11). `RemotePlayer`, `RemoteRoster`, LOD, name tags, driven by a dev-only "ghost" that replays the local hero's encoded states 1 s late through the real codec. Verify: screenshots plus position-error numbers.
3. **Server skeleton:** deps, `vite.server.config.ts`, `tsconfig.server.json`, scripts, `server/*` static + healthz + ws, `RoomManager`, `session.ts` with limits, `Room` multi-slot. Verify: `server.spec` RoomManager/limits; `curl /healthz`.
4. **NetLink:** hello/welcome, 20 Hz upload, relay, snapshots into `CombatView`, intents, `ce` events, clock, corrections, reconnect, fallback, Vite proxy. Verify: two-context presence and combat-agreement cases.
5. **UI:** multiplayer screen, invite link, pause-menu room panel, toasts, strings, online restrictions (time keys, pause = afk). Verify: private/code/invite/name cases; `ui.spec` unchanged.
6. **Rules:** movement sanity, kicks, PvP intents and lag compensation for hero targets, shared-clock moment restore. Verify: cheat and PvP cases.
7. **Performance:** bot load test, LOD tuning. Verify: perf case.
8. **Deploy and docs:** Dockerfile, compose, `.dockerignore`, nginx example, launcher `--sunucu`, README (deploy section with env table), ARCHITECTURE/DECISIONS/MILESTONES. Full suite + Docker gate.

## 11. Risks

- Click ambiguity: tune `coneDeg`/`closeRange` with the combat bot and playtests. Swing specs guard the no-enemy path.
- Lunge into geometry: reuse zip's abort-on-block. Fuzz covers MODE_STRIKE.
- Server CPU with 200 rooms: profile `Room.step`. Sleep the sims of rooms with no active players. `MAX_ROOMS` caps it.
- Client-authoritative movement still allows cheating within 110 m/s (accepted for co-op). PvP is limited to private rooms.
- Remote web lines with late anchors: the anchor travels in every state packet while a rope or zip is active.
