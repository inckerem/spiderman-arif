import { CapsuleGeometry, Color, DynamicDrawUsage, InstancedMesh, Matrix4, MeshToonMaterial, Quaternion, Vector3 } from 'three';
import { toonGradient, withMRT } from '../../render/materials';
import type { CombatView } from '../client/combatView';
import { kindInfo } from '../roster';
import { EF, ES } from '../types';

/** Base colour per kind: thug, bat, gunman, brute, drone, Koçbaşı, Kuzgun, Diken. */
const KIND_COLORS = [0xd8452e, 0xe08a1e, 0x6a4fd0, 0x5b6470, 0x2aa7c9, 0xc9a227, 0x2b2b33, 0x3f9b4a] as const;

const _m = new Matrix4();
const _p = new Vector3();
const _s = new Vector3();
const _q = new Quaternion();
const _q2 = new Quaternion();
const _up = new Vector3(0, 1, 0);
const _x = new Vector3(1, 0, 0);
const _c = new Color();

/**
 * Temporary enemy visuals until the rigs of chunk 5: one instanced capsule
 * per replicated enemy (one draw call), sized by kind, coloured by kind and
 * tinted by state (wind-up flashes white, stagger and a predicted flinch
 * brighten, down and KO lie flat, pinned turns pale).
 */
export class DebugCapsules {
  readonly mesh: InstancedMesh;

  constructor(capacity: number) {
    const mat = new MeshToonMaterial({ gradientMap: toonGradient() });
    withMRT(mat, true, 'combat-debug');
    // Unit capsule: radius 0.5, total height 2 (scaled per kind).
    const geo = new CapsuleGeometry(0.5, 1, 4, 10);
    geo.translate(0, 1, 0);
    this.mesh = new InstancedMesh(geo, mat, Math.max(1, capacity));
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.name = 'combat-debug-capsules';
    this.mesh.setColorAt(0, _c.set(0xffffff));
    this.mesh.count = 0;
  }

  update(view: CombatView, now: number): void {
    const mesh = this.mesh;
    let n = 0;
    const cap = mesh.instanceMatrix.count;
    for (const e of view.enemies) {
      if (n >= cap) break;
      const info = kindInfo(e.kind as Parameters<typeof kindInfo>[0]);
      const r = info.radius;
      const h = info.flyer ? r * 2 : info.height;
      _p.set(e.x, info.flyer ? e.y - r : e.y, e.z);
      _s.set(r * 2, h / 2, r * 2);
      if (e.state === ES.KO || e.state === ES.DOWN) {
        // Lying along its facing direction.
        _q.setFromAxisAngle(_up, e.yaw).multiply(_q2.setFromAxisAngle(_x, -Math.PI / 2));
        _p.y += r;
      } else _q.setFromAxisAngle(_up, e.yaw);
      _m.compose(_p, _q, _s);
      mesh.setMatrixAt(n, _m);
      _c.set(KIND_COLORS[e.kind] ?? 0xffffff);
      if (e.state === ES.TELEGRAPH) _c.lerp(WHITE, 0.55 + 0.45 * Math.sin(now * 40));
      else if (e.state === ES.PINNED) _c.lerp(WHITE, 0.7);
      else if (e.state === ES.KO) _c.multiplyScalar(0.35);
      else if (e.state === ES.STAGGER || e.flinchUntil > now || (e.flags & EF.KNOCKED) !== 0) _c.lerp(WHITE, 0.35);
      mesh.setColorAt(n, _c);
      n++;
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
}

const WHITE = new Color(0xffffff);
