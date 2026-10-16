/**
 * The other players in an online room (design M12 §5): one RemotePlayer each,
 * added to the scene, posed by level of detail every rendered frame. Beyond
 * the rig range they are drawn as one shared instanced silhouette (one draw
 * call for all, coloured by costume); beyond that only the minimap shows them.
 */
import { CapsuleGeometry, Color, Frustum, InstancedMesh, Matrix4, MeshBasicMaterial, Object3D, Sphere, Vector3, type PerspectiveCamera, type Scene } from 'three';
import type { CollisionWorld } from '../physics/collision';
import type { PlayerEvent } from '../player/player';
import { RemotePlayer } from '../character/remotePlayer';
import { COSTUMES } from '../character/costumes';
import type { HeroSample, PlayerInfo } from './protocol';
import { RENDER_DELAY_S } from './interp';

const MAX_SILHOUETTES = 64;

export interface RemoteView {
  pid: number;
  name: string;
  x: number;
  y: number;
  z: number;
  lod: number;
  inView: boolean;
  webVisible: boolean;
}

export class RemoteRoster {
  readonly players = new Map<number, RemotePlayer>();
  /** Called for each remote hero event when it fires (audio, particles). */
  onEvent: ((r: RemotePlayer, e: PlayerEvent) => void) | null = null;
  private readonly silhouettes: InstancedMesh;
  private readonly frustum = new Frustum();
  private readonly projView = new Matrix4();
  private readonly sphere = new Sphere(new Vector3(), 1.4);
  private readonly dummy = new Object3D();
  private readonly color = new Color();

  constructor(
    private readonly scene: Scene,
    private readonly world: CollisionWorld,
  ) {
    const geo = new CapsuleGeometry(0.35, 1.1, 4, 8);
    geo.translate(0, 0.9, 0);
    this.silhouettes = new InstancedMesh(geo, new MeshBasicMaterial(), MAX_SILHOUETTES);
    this.silhouettes.count = 0;
    this.silhouettes.frustumCulled = false;
    this.silhouettes.name = 'remoteSilhouettes';
    scene.add(this.silhouettes);
  }

  add(p: PlayerInfo): RemotePlayer {
    let r = this.players.get(p.pid);
    if (r) {
      r.name = p.name;
      r.setCostume(p.costume);
      return r;
    }
    r = new RemotePlayer(p.pid, p.name, p.costume, this.world);
    r.onEvent = (rp, e) => this.onEvent?.(rp, e);
    this.players.set(p.pid, r);
    this.scene.add(r.rig.mesh, r.web.group);
    return r;
  }

  remove(pid: number): void {
    const r = this.players.get(pid);
    if (!r) return;
    r.dispose();
    this.players.delete(pid);
  }

  clear(): void {
    for (const pid of [...this.players.keys()]) this.remove(pid);
    this.silhouettes.count = 0;
  }

  /** A relayed state. Unknown pids (a state racing its `join`) are kept with a placeholder name. */
  push(pid: number, s: HeroSample): void {
    (this.players.get(pid) ?? this.add({ pid, name: '', costume: '' })).push(s);
  }

  /** Pose every remote hero at `nowS − 0.1 s` (room time). */
  update(nowS: number, dt: number, camera: PerspectiveCamera, night: number): void {
    const renderMs = (nowS - RENDER_DELAY_S) * 1000;
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    let n = 0;
    for (const r of this.players.values()) {
      const p = r.pos;
      this.sphere.center.set(p.x, p.y + 0.9, p.z);
      const inView = this.frustum.intersectsSphere(this.sphere);
      if (!r.frame(renderMs, dt, camera, night, inView)) continue;
      if (r.lod === 2 && inView && n < MAX_SILHOUETTES) {
        this.dummy.position.copy(r.pos);
        this.dummy.rotation.set(0, r.facing, 0);
        this.dummy.updateMatrix();
        this.silhouettes.setMatrixAt(n, this.dummy.matrix);
        const c = COSTUMES[r.costume].colors.primary;
        this.silhouettes.setColorAt(n, this.color.setRGB(c[0], c[1], c[2]));
        n++;
      }
    }
    this.silhouettes.count = n;
    this.silhouettes.instanceMatrix.needsUpdate = true;
    if (this.silhouettes.instanceColor) this.silhouettes.instanceColor.needsUpdate = true;
  }

  /** Positions and state for the minimap, name tags and tests. */
  views(out: RemoteView[] = []): RemoteView[] {
    out.length = 0;
    for (const r of this.players.values()) {
      if (r.lod < 0) continue;
      out.push({ pid: r.pid, name: r.name, x: r.pos.x, y: r.pos.y, z: r.pos.z, lod: r.lod, inView: r.inView, webVisible: r.webVisible });
    }
    return out;
  }

  dispose(): void {
    this.clear();
    this.silhouettes.removeFromParent();
    this.silhouettes.geometry.dispose();
    (this.silhouettes.material as MeshBasicMaterial).dispose();
  }
}
