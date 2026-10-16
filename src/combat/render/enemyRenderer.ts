import {
  Color,
  DynamicDrawUsage,
  Frustum,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshToonMaterial,
  Quaternion,
  Sphere,
  Vector3,
  type Camera,
  type DataTexture,
  type IUniform,
} from 'three';
import { tuning } from '../../config/tuning';
import type { Particles } from '../../fx/particles';
import { GeomBuilder } from '../../render/geomBuilder';
import { toonGradient, withMRT } from '../../render/materials';
import type { CombatView, ViewEnemy } from '../client/combatView';
import { kindInfo } from '../roster';
import { ANIM, EF, ES, HERO_ID_BASE, HIT, PK, type CombatEvent, type EnemyKind } from '../types';
import { CombatBeams } from './combatFx';
import { EnemyAnimator, makePoseSlot, posedPoint, type PoseSlot } from './enemyAnimator';
import { BONE_TEX_ROWS, BONE_TEX_W, enemyDepthMaterial, enemyMaterial, makeBoneTexture } from './enemyMaterial';
import { ARCH, ARCH_COUNT, ARCH_NAMES, J, PROP, TINTS, archOf, enemyRigs, type RigDef } from './enemyRigs';

/** Full animation (and shadows) within this distance of the camera. */
const NEAR = 40;
/** Hidden beyond this distance (the minimap shows them, chunk 7). */
const FAR = 150;
/** Far LOD: the pose is re-evaluated every this many frames (staggered). */
const FAR_POSE_EVERY = 3;
/** Close enemies are drawn even just outside the view (their shadows can fall into it). */
const ALWAYS_NEAR = 18;
const FLASH_TIME = 0.12;
/** Short-lived lines (tracers, web lines of a yank or pin) kept at once. */
const MAX_LINES = 24;
const TRACER_TIME = 0.07;
const WEB_LINE_TIME = 0.22;

interface FxLine {
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  /** Render time it disappears. */
  until: number;
  /** 0 tracer, 1 web line. */
  kind: number;
}

const _m = new Matrix4();
const _q = new Quaternion();
const _p = new Vector3();
const _s = new Vector3(1, 1, 1);
const _up = new Vector3(0, 1, 0);
const _c = new Color();
const _v = new Vector3();
const _d = new Vector3();
const _pm = new Matrix4();
const _frustum = new Frustum();
const _sphere = new Sphere();

/** Integer hash of an enemy id (stable look per enemy). */
function hashId(id: number): number {
  let h = Math.imul(id ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Web-pin cocoon: a lumpy white wrap with a few strands (one instanced mesh). */
function cocoonGeometry(): ReturnType<GeomBuilder['build']> {
  const g = new GeomBuilder();
  g.setColor(0.92, 0.93, 0.96);
  // Unit wrap: radius 1 around the torso, height 1 (scaled per enemy).
  g.ellipsoid(0, 0, 0, 1, 1, 1, 12, 8);
  g.ellipsoid(0.55, 0.35, 0.45, 0.55, 0.45, 0.5, 8, 5);
  g.ellipsoid(-0.6, -0.25, 0.35, 0.5, 0.5, 0.5, 8, 5);
  g.ellipsoid(0.1, -0.55, -0.6, 0.55, 0.45, 0.5, 8, 5);
  // Strands from the wrap down to the ground (the unit wrap's ground is about 1.4 below its centre).
  g.setColor(0.86, 0.88, 0.92);
  const up = new Vector3(0, 1, 0);
  const dir = new Vector3();
  const rot = new Quaternion();
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.3;
    const ax = Math.cos(a) * 0.75,
      ay = -0.35,
      az = Math.sin(a) * 0.75;
    const bx = Math.cos(a) * 1.7,
      by = -1.4,
      bz = Math.sin(a) * 1.7;
    dir.set(bx - ax, by - ay, bz - az);
    const len = dir.length();
    rot.setFromUnitVectors(up, dir.normalize());
    const start = g.vertexCount;
    g.cylinder(0, 0, 0, len, 0.045, 0.02, 4, false);
    g.transformRange(start, (v, n) => {
      v.applyQuaternion(rot);
      v.x += ax;
      v.y += ay;
      v.z += az;
      n.applyQuaternion(rot);
    });
  }
  return g.build();
}

/**
 * Enemy rendering (browser only): the five archetype rigs as instanced
 * meshes (one draw call each, plus one each in the shadow pass), skinned on
 * the GPU from a shared bone texture written by the `EnemyAnimator`; web-pin
 * cocoons (one instanced mesh); hit sparks and knockdown dust through the
 * shared `Particles`.
 *
 * Per frame: every replicated enemy within 150 m and in view (or within
 * 18 m) gets a pose slot; within 40 m it is posed every frame and casts a
 * shadow, farther out it is posed every third frame (staggered) without a
 * shadow; beyond 150 m it is not drawn. Visible enemies are packed per
 * archetype into consecutive bone-texture rows (32 at most). No allocation
 * per frame; every program compiles during loading (`warmup`).
 */
export class EnemyRenderer {
  readonly group = new Group();
  readonly meshes: InstancedMesh[] = [];
  readonly cocoons: InstancedMesh;
  /** Laser sights, tracers, projectiles in flight and web lines (one draw call). */
  readonly beams = new CombatBeams();
  private readonly lines: FxLine[] = [];
  private lineNext = 0;
  /** Kinds of recent projectiles by id (their end event carries no kind). */
  private readonly projIds = new Int32Array(64).fill(-1);
  private readonly projKinds = new Int8Array(64);
  /** Visible enemies in the last frame (and per LOD band), for tests and the debug HUD. */
  readonly stats = { visible: 0, near: 0, far: 0, culled: 0, hidden: 0, posed: 0 };
  readonly rigs: readonly RigDef[];
  private readonly animator = new EnemyAnimator();
  private readonly boneTex: DataTexture;
  /** The bone texture data (tests check it for NaN). */
  readonly bones: Float32Array;
  private readonly rowBase: IUniform<number>[] = [];
  private readonly iState: InstancedBufferAttribute[] = [];
  private readonly iLook: InstancedBufferAttribute[] = [];
  private readonly byId = new Map<number, PoseSlot>();
  private readonly active: PoseSlot[] = [];
  private readonly pool: PoseSlot[] = [];
  /** Visible slots per archetype this frame (and their LOD: true = near). */
  private readonly lists: PoseSlot[][] = [];
  private readonly near: boolean[][] = [];
  private readonly counts = new Int32Array(ARCH_COUNT);
  private frame = 0;
  private warm = 0;
  private readonly warmAt = new Vector3();

  constructor(private readonly particles: Particles) {
    this.rigs = enemyRigs();
    this.boneTex = makeBoneTexture();
    this.bones = this.boneTex.image.data as Float32Array;
    const uBones = { value: this.boneTex };
    for (let a = 0; a < ARCH_COUNT; a++) {
      const def = this.rigs[a]!;
      const rowBase = { value: 0 };
      this.rowBase.push(rowBase);
      const u = { uBones, uRowBase: rowBase };
      const geo = def.geometry;
      const st = new InstancedBufferAttribute(new Float32Array(BONE_TEX_ROWS * 4), 4);
      st.setUsage(DynamicDrawUsage);
      const lk = new InstancedBufferAttribute(new Float32Array(BONE_TEX_ROWS), 1);
      lk.setUsage(DynamicDrawUsage);
      geo.setAttribute('iState', st);
      geo.setAttribute('iLook', lk);
      this.iState.push(st);
      this.iLook.push(lk);
      const mesh = new InstancedMesh(geo, enemyMaterial(u, ARCH_NAMES[a]!), BONE_TEX_ROWS);
      mesh.customDepthMaterial = enemyDepthMaterial(u);
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      // The instance colour exists from the start (the program never changes).
      for (let i = 0; i < BONE_TEX_ROWS; i++) mesh.setColorAt(i, _c.set(0xffffff));
      mesh.instanceColor!.setUsage(DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.count = 0;
      mesh.visible = false;
      mesh.name = `enemies-${ARCH_NAMES[a]}`;
      this.meshes.push(mesh);
      this.group.add(mesh);
      const list: PoseSlot[] = [];
      const nl: boolean[] = [];
      for (let i = 0; i < BONE_TEX_ROWS; i++) {
        list.push(makePoseSlot());
        nl.push(false);
      }
      this.lists.push(list);
      this.near.push(nl);
    }
    const cm = new MeshToonMaterial({ vertexColors: true, gradientMap: toonGradient(), emissive: 0x202630 });
    withMRT(cm, true, 'enemy-web');
    this.cocoons = new InstancedMesh(cocoonGeometry(), cm, BONE_TEX_ROWS);
    this.cocoons.instanceMatrix.setUsage(DynamicDrawUsage);
    this.cocoons.frustumCulled = false;
    this.cocoons.castShadow = false;
    this.cocoons.receiveShadow = true;
    this.cocoons.count = 0;
    this.cocoons.visible = false;
    this.cocoons.name = 'enemy-cocoons';
    this.group.add(this.cocoons);
    this.group.add(this.beams.mesh);
    for (let i = 0; i < MAX_LINES; i++) this.lines.push({ ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0, until: -1e9, kind: 0 });
    this.group.name = 'enemies';
    for (let i = 0; i < BONE_TEX_ROWS; i++) this.pool.push(makePoseSlot());
  }

  /** Prop hide mask (`PROP` bits) an enemy was drawn with last frame, or -1 when it was not drawn. */
  hiddenProps(id: number): number {
    const s = this.byId.get(id);
    return s ? s.hide : -1;
  }

  /** Visible enemies drawn in the last frame. */
  get visibleCount(): number {
    return this.stats.visible;
  }

  /**
   * Draw one of everything at (x, y, z) now (for `renderer.compile`) and in
   * the next frame (the shadow pass), so every program compiles during loading.
   */
  warmup(x: number, y: number, z: number): void {
    this.warm = 1;
    this.warmAt.set(x, y, z);
    this.drawWarm();
  }

  /** Forget every pose slot (a new game). */
  reset(): void {
    for (const s of this.active) this.pool.push(s);
    this.active.length = 0;
    this.byId.clear();
    for (const m of this.meshes) {
      m.count = 0;
      m.visible = false;
    }
    this.cocoons.count = 0;
    this.cocoons.visible = false;
    for (const l of this.lines) l.until = -1e9;
    this.beams.begin();
    this.beams.end();
    this.stats.visible = 0;
  }

  /**
   * Pose and pack the replicated enemies for this frame. `t` is the view's
   * render time (room seconds), `hero` the local hero's feet (aim pitch of
   * gunmen and drones targeting it).
   */
  update(view: CombatView, camera: Camera, t: number, hero: Vector3 | null): void {
    this.frame++;
    if (this.warm > 0) {
      this.warm--;
      this.drawWarm();
      return;
    }
    const st = this.stats;
    st.visible = st.near = st.far = st.culled = st.hidden = st.posed = 0;
    this.counts.fill(0);
    const cam = camera.position;
    _pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pm);
    const me = view.selfId;
    let total = 0;
    const list = view.enemies;
    for (let i = 0; i < list.length; i++) {
      const e = list[i]!;
      const a = archOf(e.kind);
      const def = this.rigs[a]!;
      const dist = Math.hypot(e.x - cam.x, e.y + def.cy - cam.y, e.z - cam.z);
      if (dist > FAR) {
        st.hidden++;
        continue;
      }
      if (dist > ALWAYS_NEAR) {
        _sphere.center.set(e.x, e.y + def.cy, e.z);
        _sphere.radius = def.radius + 0.5;
        if (!_frustum.intersectsSphere(_sphere)) {
          st.culled++;
          continue;
        }
      }
      if (total >= BONE_TEX_ROWS) break;
      let slot = this.byId.get(e.id);
      if (!slot || slot.arch !== a) {
        if (slot) this.release(slot);
        slot = this.pool.pop() ?? makePoseSlot();
        slot.id = e.id;
        slot.arch = a;
        slot.fresh = true;
        slot.posedAt = t;
        slot.flashUntil = -1e9;
        slot.fxAnim = -1;
        slot.fxDone = 0;
        slot.lodPhase = hashId(e.id) % FAR_POSE_EVERY;
        slot.phase = (hashId(e.id) % 1000) / 1000;
        slot.aim = 0;
        this.animator.rest(slot, def);
        this.byId.set(e.id, slot);
        this.active.push(slot);
      }
      slot.seen = this.frame;
      const isNear = dist <= NEAR;
      // Aim pitch toward the local hero when it is the target.
      if (hero && e.target === me) {
        const h = kindInfo(e.kind as EnemyKind).flyer ? 0 : 1.45 * def.scale;
        slot.aim = Math.atan2(hero.y + 1.1 - (e.y + h), Math.max(1, Math.hypot(hero.x - e.x, hero.z - e.z)));
      } else slot.aim *= 0.9;
      if (isNear || (this.frame + slot.lodPhase) % FAR_POSE_EVERY === 0 || slot.fresh) {
        const dt = slot.fresh ? 0 : clampDt(t - slot.posedAt);
        slot.posedAt = t;
        this.animator.pose(slot, def, e, t, dt);
        st.posed++;
        this.effects(slot, def, e, t);
      }
      const k = this.counts[a]!;
      this.lists[a]![k] = slot;
      this.near[a]![k] = isNear;
      this.counts[a] = k + 1;
      total++;
      if (isNear) st.near++;
      else st.far++;
    }
    st.visible = total;
    this.pack(view, t);
    this.drawBeams(view, t, hero);
    // Slots of enemies gone (or out of sight) go back to the pool.
    for (let i = this.active.length - 1; i >= 0; i--) {
      const s = this.active[i]!;
      if (s.seen === this.frame) continue;
      this.active[i] = this.active[this.active.length - 1]!;
      this.active.pop();
      this.release(s);
    }
  }

  private release(s: PoseSlot): void {
    if (this.byId.get(s.id) === s) this.byId.delete(s.id);
    this.pool.push(s);
  }

  /** Write rows, instance transforms and states, archetype by archetype. */
  private pack(view: CombatView, t: number): void {
    let row = 0;
    let nCocoon = 0;
    const bones = this.bones;
    const linger = tuning.enemies.koLinger;
    for (let a = 0; a < ARCH_COUNT; a++) {
      const mesh = this.meshes[a]!;
      const n = this.counts[a]!;
      const def = this.rigs[a]!;
      this.rowBase[a]!.value = row;
      const st = this.iState[a]!.array as Float32Array;
      const lk = this.iLook[a]!.array as Float32Array;
      const tints = TINTS[a]!;
      for (let i = 0; i < n; i++) {
        const slot = this.lists[a]![i]!;
        const e = view.enemy(slot.id)!;
        // Bone rows.
        const base = (row + i) * BONE_TEX_W * 4;
        bones.set(slot.skin.subarray(0, def.bones * 12), base);
        // Placement: feet (or a flyer's centre) and yaw (the model faces +Z).
        let y = e.y;
        if (e.state === ES.KO) {
          const age = t - e.animT0;
          if (age > linger - 0.7) y -= (age - (linger - 0.7)) * 1.4;
        }
        _p.set(e.x, y, e.z);
        _q.setFromAxisAngle(_up, e.yaw + Math.PI);
        _m.compose(_p, _q, _s);
        mesh.setMatrixAt(i, _m);
        const h = hashId(slot.id);
        const tint = tints[h % tints.length]!;
        mesh.setColorAt(i, _c.setRGB(tint[0], tint[1], tint[2]));
        lk[i] = ((h >>> 8) % 1000) / 1000;
        // State: tell glow, hit flash, hidden props, shadow.
        let tell = 0;
        if (e.state === ES.TELEGRAPH) tell = 0.55 + 0.45 * Math.sin(t * 26);
        else if (e.anim === ANIM.AIM) tell = 0.6;
        const flash = Math.max(0, Math.min(1, (slot.flashUntil - t) / FLASH_TIME), Math.min(1, (e.flinchUntil - t) / 0.2) * 0.6);
        let hide = 0;
        if (a === ARCH.BRUTE && (e.flags & EF.SHIELDLESS) !== 0) hide |= PROP.SHIELD;
        if ((a === ARCH.GUNMAN || a === ARCH.BAT) && (e.flags & EF.DISARMED) !== 0) hide |= PROP.WEAPON;
        if (a === ARCH.THUG && !(e.anim === ANIM.THROW && e.state === ES.TELEGRAPH)) hide |= PROP.BOTTLE;
        slot.hide = hide;
        st[i * 4] = tell;
        st[i * 4 + 1] = flash;
        st[i * 4 + 2] = hide;
        st[i * 4 + 3] = this.near[a]![i] ? 1 : 0;
        // Web-pin cocoon around the torso (a pinned drone is wrapped whole).
        const info = kindInfo(e.kind as EnemyKind);
        if ((e.state === ES.PINNED || (info.flyer && (e.flags & EF.WEBBED) !== 0)) && nCocoon < BONE_TEX_ROWS) {
          const grow = Math.min(1, (t - e.animT0) / 0.15);
          if (info.flyer) {
            _p.set(e.x, e.y, e.z);
            _v.set(info.radius * 1.1, info.radius * 0.8, info.radius * 1.1).multiplyScalar(grow);
          } else {
            const hh = info.height;
            _p.set(e.x, e.y + hh * 0.5, e.z);
            _v.set(info.radius * 0.95, hh * 0.36, info.radius * 0.85).multiplyScalar(grow);
          }
          _q.setFromAxisAngle(_up, e.yaw + Math.PI);
          _m.compose(_p, _q, _v);
          this.cocoons.setMatrixAt(nCocoon++, _m);
        }
      }
      mesh.count = n;
      mesh.visible = n > 0;
      if (n > 0) {
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor!.needsUpdate = true;
        this.iState[a]!.needsUpdate = true;
        this.iLook[a]!.needsUpdate = true;
      }
      row += n;
    }
    if (row > 0) this.boneTex.needsUpdate = true;
    this.cocoons.count = nCocoon;
    this.cocoons.visible = nCocoon > 0;
    if (nCocoon > 0) this.cocoons.instanceMatrix.needsUpdate = true;
  }

  /** Pose-driven one-shots: dust when a knocked-down enemy hits the ground and under a brute's slam. */
  private effects(slot: PoseSlot, def: RigDef, e: ViewEnemy, t: number): void {
    if (slot.fxAnim !== e.anim || slot.fxT0 !== e.animT0) {
      slot.fxAnim = e.anim;
      slot.fxT0 = e.animT0;
      slot.fxDone = 0;
    }
    const age = t - e.animT0;
    if (def.arch !== ARCH.DRONE && (e.anim === ANIM.KNOCKDOWN || e.anim === ANIM.KO) && (slot.fxDone & 1) === 0 && age > 0.32 && age < 1) {
      slot.fxDone |= 1;
      this.particles.dust(_v.set(e.x, e.y + 0.1, e.z), def.arch === ARCH.BRUTE ? 0.8 : 0.45, 0);
    }
    if (def.arch === ARCH.BRUTE && e.anim === ANIM.STRIKE && (slot.fxDone & 2) === 0 && age > 0.06 && age < 0.5) {
      slot.fxDone |= 2;
      // In front of him, where the gauntlet lands.
      _v.set(e.x - Math.sin(e.yaw) * 1.1 * def.scale, e.y + 0.1, e.z - Math.cos(e.yaw) * 1.1 * def.scale);
      this.particles.dust(_v, 0.7, 0);
    }
  }

  /** A combat event's visual effect (sparks at the hit enemy or on the hero). */
  onEvent(ev: CombatEvent, view: CombatView, hero: Vector3 | null, t: number): void {
    switch (ev.e) {
      case 'shot': {
        // Muzzle flash and a tracer from the posed muzzle (the sim's estimate when the gunman is not drawn).
        const e = view.enemy(ev.src);
        const slot = this.byId.get(ev.src);
        if (e && slot) this.muzzle(slot, e, _p);
        else _p.set(ev.x, ev.y, ev.z);
        this.particles.flash(_p, 1, 0.85, 0.4, 0.45, 4);
        this.line(_p.x, _p.y, _p.z, ev.tx, ev.ty, ev.tz, t + TRACER_TIME, 0);
        return;
      }
      case 'proj':
        this.projIds[ev.id & 63] = ev.id;
        this.projKinds[ev.id & 63] = ev.kind;
        return;
      case 'projEnd':
        if (ev.tgt < 0) {
          const bottle = this.projIds[ev.id & 63] === ev.id && this.projKinds[ev.id & 63] === PK.BOTTLE;
          if (bottle) this.particles.flash(_v.set(ev.x, ev.y, ev.z), 0.45, 0.8, 0.4, 0.3, 10);
          else this.particles.flash(_v.set(ev.x, ev.y, ev.z), 0.35, 1, 0.85, 0.6, 6);
        }
        return;
      case 'yank':
      case 'pin': {
        if (ev.src !== view.selfId || !hero) return;
        const e = view.enemy(ev.tgt);
        if (!e) return;
        const info = kindInfo(e.kind as EnemyKind);
        this.line(hero.x, hero.y + 1.3, hero.z, e.x, info.flyer ? e.y : e.y + info.height * 0.6, e.z, t + WEB_LINE_TIME, 1);
        return;
      }
      case 'hit':
        break;
      default:
        return;
    }
    if (ev.tgt >= HERO_ID_BASE) {
      if (ev.tgt !== view.selfId || !hero || ev.dmg <= 0) return;
      const src = view.enemy(ev.src);
      _d.set(hero.x - (src ? src.x : hero.x), 0, hero.z - (src ? src.z : hero.z));
      if (_d.lengthSq() < 1e-6) _d.set(0, 0, 1);
      _d.normalize();
      this.particles.hitSpark(_v.set(hero.x, hero.y + 1.15, hero.z), _d, Math.min(1, ev.dmg / 20), false);
      return;
    }
    const e = view.enemy(ev.tgt);
    if (!e) return;
    const info = kindInfo(e.kind as EnemyKind);
    const blocked = (ev.fl & HIT.BLOCKED) !== 0;
    const ko = (ev.fl & HIT.KO) !== 0;
    if (!blocked && ev.dmg <= 0 && !ko) return;
    const slot = this.byId.get(ev.tgt);
    if (slot && !blocked) slot.flashUntil = t + FLASH_TIME;
    // Sparks fly away from the hitter (or along the knockback).
    if (hero && ev.src === view.selfId) _d.set(e.x - hero.x, 0, e.z - hero.z);
    else _d.set(ev.kx, 0, ev.kz);
    if (_d.lengthSq() < 1e-6) _d.set(-Math.sin(e.yaw), 0, -Math.cos(e.yaw));
    _d.normalize();
    // Contact point: the side of the body facing the hitter, at chest height.
    const cy = info.flyer ? e.y : e.y + info.height * (blocked ? 0.7 : 0.62);
    _v.set(e.x - _d.x * info.radius, cy, e.z - _d.z * info.radius);
    if (blocked && slot) {
      // Off the shield face.
      const def = this.rigs[slot.arch]!;
      posedPoint(slot, J.foreArmL, def.bind[J.foreArmL * 3]!, def.bind[J.foreArmL * 3 + 1]! - 0.12 * def.scale, def.bind[J.foreArmL * 3 + 2]! - 0.14 * def.scale, _p);
      _q.setFromAxisAngle(_up, e.yaw + Math.PI);
      _v.copy(_p).applyQuaternion(_q).add(_d.set(e.x, e.y, e.z));
      _d.set(-Math.sin(e.yaw), 0, -Math.cos(e.yaw));
    }
    this.particles.hitSpark(_v, _d, ko ? 1 : Math.min(1, ev.dmg / 25), blocked);
    // A torn-off shield or a yanked gun: a white burst at the hands.
    if ((ev.fl & HIT.DISARM) !== 0) this.particles.flash(_v.set(e.x, e.y + info.height * 0.55, e.z), 0.9, 0.9, 1, 0.9, 12);
  }

  private line(ax: number, ay: number, az: number, bx: number, by: number, bz: number, until: number, kind: number): void {
    const l = this.lines[this.lineNext]!;
    this.lineNext = (this.lineNext + 1) % MAX_LINES;
    l.ax = ax;
    l.ay = ay;
    l.az = az;
    l.bx = bx;
    l.by = by;
    l.bz = bz;
    l.until = until;
    l.kind = kind;
  }

  /** The gunman's muzzle in the world, from his posed right hand. */
  private muzzle(slot: PoseSlot, e: ViewEnemy, out: Vector3): Vector3 {
    const def = this.rigs[slot.arch]!;
    const s = def.scale;
    const o = J.handR * 3;
    posedPoint(slot, J.handR, def.bind[o]!, def.bind[o + 1]! - 0.25 * s, def.bind[o + 2]! - 0.035 * s, out);
    _q.setFromAxisAngle(_up, e.yaw + Math.PI);
    return out.applyQuaternion(_q).add(_d.set(e.x, e.y, e.z));
  }

  /** Laser sights of aiming gunmen, projectiles in flight, tracers and web lines. */
  private drawBeams(view: CombatView, t: number, hero: Vector3 | null): void {
    const b = this.beams;
    b.begin();
    const me = view.selfId;
    for (let a = 0; a < ARCH_COUNT; a++) {
      if (a !== ARCH.GUNMAN) continue;
      for (let i = 0; i < this.counts[a]!; i++) {
        const slot = this.lists[a]![i]!;
        const e = view.enemy(slot.id)!;
        if (e.state !== ES.TELEGRAPH || e.anim !== ANIM.AIM) continue;
        this.muzzle(slot, e, _p);
        if (hero && e.target === me) _v.set(hero.x, hero.y + 1.15, hero.z);
        else {
          const c = Math.cos(slot.aim);
          _v.set(_p.x - Math.sin(e.yaw) * 40 * c, _p.y + Math.sin(slot.aim) * 40, _p.z - Math.cos(e.yaw) * 40 * c);
        }
        // The sight brightens as the shot comes.
        const k = Math.min(1, (t - e.animT0) / Math.max(0.1, tuning.enemies.gunman.telegraph));
        b.add(_p.x, _p.y, _p.z, _v.x, _v.y, _v.z, 0.02 + 0.02 * k, 1, 0.08, 0.04, 0.55 + 0.45 * k);
      }
    }
    for (const p of view.projectiles) {
      const sp = Math.hypot(p.vx, p.vy, p.vz) || 1;
      if (p.kind === PK.BOTTLE) b.add(p.x - (p.vx / sp) * 0.3, p.y - (p.vy / sp) * 0.3, p.z - (p.vz / sp) * 0.3, p.x, p.y, p.z, 0.13, 0.3, 0.75, 0.35, 0.9);
      else {
        b.add(p.x - (p.vx / sp) * 1.4, p.y - (p.vy / sp) * 1.4, p.z - (p.vz / sp) * 1.4, p.x, p.y, p.z, 0.32, 0.2, 0.9, 0.75, 0.55);
        b.add(p.x - (p.vx / sp) * 0.6, p.y - (p.vy / sp) * 0.6, p.z - (p.vz / sp) * 0.6, p.x, p.y, p.z, 0.14, 0.85, 1, 0.95, 1);
      }
    }
    for (const l of this.lines) {
      if (l.until <= t) continue;
      if (l.kind === 0) {
        const k = (l.until - t) / TRACER_TIME;
        b.add(l.ax, l.ay, l.az, l.bx, l.by, l.bz, 0.05, 1, 0.85, 0.45, k);
      } else {
        const k = (l.until - t) / WEB_LINE_TIME;
        b.add(l.ax, l.ay, l.az, l.bx, l.by, l.bz, 0.035, 0.9, 0.92, 0.98, 0.8 * k);
      }
    }
    b.end();
  }

  /** One instance of every archetype (rest pose) and a cocoon at the warm-up spot. */
  private drawWarm(): void {
    let row = 0;
    for (let a = 0; a < ARCH_COUNT; a++) {
      const def = this.rigs[a]!;
      const slot = this.lists[a]![0]!;
      this.animator.rest(slot, def);
      this.bones.set(slot.skin.subarray(0, def.bones * 12), row * BONE_TEX_W * 4);
      this.rowBase[a]!.value = row;
      const mesh = this.meshes[a]!;
      _p.set(this.warmAt.x + a * 1.5, this.warmAt.y, this.warmAt.z);
      _m.compose(_p, _q.identity(), _s);
      mesh.setMatrixAt(0, _m);
      const st = this.iState[a]!.array as Float32Array;
      st[0] = 0;
      st[1] = 0;
      st[2] = 0;
      st[3] = 1;
      this.iState[a]!.needsUpdate = true;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.count = 1;
      mesh.visible = true;
      row++;
    }
    this.boneTex.needsUpdate = true;
    _m.compose(this.warmAt, _q.identity(), _v.set(0.4, 0.6, 0.4));
    this.cocoons.setMatrixAt(0, _m);
    this.cocoons.instanceMatrix.needsUpdate = true;
    this.cocoons.count = 1;
    this.cocoons.visible = true;
    this.beams.begin();
    this.beams.add(this.warmAt.x, this.warmAt.y + 1, this.warmAt.z, this.warmAt.x + 1, this.warmAt.y + 1, this.warmAt.z, 0.05, 1, 1, 1, 0.01);
    this.beams.end();
  }
}

function clampDt(dt: number): number {
  return dt < 0 ? 0 : dt > 0.1 ? 0.1 : dt;
}
