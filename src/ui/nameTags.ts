/**
 * Name tags over other players' heads (design M12 §5): a pool of DOM labels
 * projected every frame, hidden beyond 120 m, behind the camera, or when a
 * ray from the camera finds a wall in between (rechecked every 200 ms).
 */
import { Vector3, type PerspectiveCamera } from 'three';
import { makeRayHit, F_CANOPY, type CollisionWorld } from '../physics/collision';

const MAX_DIST = 120;
const OCCLUSION_MS = 200;
const HEAD = 2.15;

interface Tag {
  el: HTMLDivElement;
  text: Text;
  pid: number;
  name: string;
  occluded: boolean;
  checkedAt: number;
  shown: boolean;
}

export interface TagTarget {
  pid: number;
  name: string;
  x: number;
  y: number;
  z: number;
}

export class NameTags {
  readonly el: HTMLDivElement;
  private readonly tags = new Map<number, Tag>();
  private readonly v = new Vector3();
  private readonly ray = makeRayHit();

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'sk-nametags';
    parent.prepend(this.el);
  }

  /** Positions every tag; players not in `list` lose theirs. */
  update(list: readonly TagTarget[], camera: PerspectiveCamera, world: CollisionWorld, visible: boolean): void {
    const now = performance.now();
    const w = window.innerWidth;
    const h = window.innerHeight;
    const seen = new Set<number>();
    for (const p of list) {
      seen.add(p.pid);
      let t = this.tags.get(p.pid);
      if (!t) {
        const el = document.createElement('div');
        el.className = 'sk-nametag';
        const text = document.createTextNode('');
        el.append(text);
        this.el.append(el);
        t = { el, text, pid: p.pid, name: '', occluded: false, checkedAt: 0, shown: false };
        this.tags.set(p.pid, t);
      }
      if (t.name !== p.name) {
        t.name = p.name;
        t.text.data = p.name;
      }
      const cam = camera.position;
      const dx = p.x - cam.x;
      const dy = p.y + HEAD - cam.y;
      const dz = p.z - cam.z;
      const d = Math.hypot(dx, dy, dz);
      let show = visible && p.name !== '' && d < MAX_DIST;
      if (show && now - t.checkedAt > OCCLUSION_MS) {
        t.checkedAt = now;
        t.occluded = d > 0.5 && world.raycast(cam.x, cam.y, cam.z, dx / d, dy / d, dz / d, d - 0.6, this.ray, F_CANOPY);
      }
      show = show && !t.occluded;
      if (show) {
        const s = this.v.set(p.x, p.y + HEAD, p.z).project(camera);
        if (s.z > 1 || s.z < -1 || Math.abs(s.x) > 1.1 || Math.abs(s.y) > 1.1) show = false;
        else {
          const k = Math.max(0.6, Math.min(1, 30 / Math.max(1, d)));
          t.el.style.transform = `translate(${((s.x * 0.5 + 0.5) * w).toFixed(1)}px, ${((-s.y * 0.5 + 0.5) * h).toFixed(1)}px) translate(-50%, -100%) scale(${k.toFixed(2)})`;
        }
      }
      if (show !== t.shown) {
        t.shown = show;
        t.el.classList.toggle('is-on', show);
      }
    }
    for (const [pid, t] of this.tags) {
      if (seen.has(pid)) continue;
      t.el.remove();
      this.tags.delete(pid);
    }
  }

  /** Names currently shown (tests). */
  shown(): string[] {
    return [...this.tags.values()].filter((t) => t.shown).map((t) => t.name);
  }

  clear(): void {
    for (const t of this.tags.values()) t.el.remove();
    this.tags.clear();
  }
}
