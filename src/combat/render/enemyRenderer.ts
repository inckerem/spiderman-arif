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
import { ANIM, EF, ES, HERO_ID_BASE, HIT, type CombatEvent, type EnemyKind } from '../types';
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
    this.group.name = 'enemies';
    for (let i = 0; i < BONE_TEX_ROWS; i++) this.pool.push(makePoseSlot());
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
        st[i * 4] = tell;
        st[i * 4 + 1] = flash;
        st[i * 4 + 2] = hide;
        st[i * 4 + 3] = this.near[a]![i] ? 1 : 0;
        // Web-pin cocoon around the torso (a pinned drone is wrapped whole).
        if (e.state === ES.PINNED && nCocoon < BONE_TEX_ROWS) {
          const info = kindInfo(e.kind as EnemyKind);
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
    if (ev.e !== 'hit') return;
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
  }
}

function clampDt(dt: number): number {
  return dt < 0 ? 0 : dt > 0.1 ? 0.1 : dt;
}
