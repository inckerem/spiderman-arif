import { Bone, BufferAttribute, Matrix4, Quaternion, Skeleton, SkinnedMesh, Vector3, MeshToonMaterial } from 'three';
import { GeomBuilder } from '../render/geomBuilder';
import { shared, toonGradient, withMRT } from '../render/materials';
import { COSTUMES, DEFAULT_COSTUME, SLOTS, type CostumeId, type Slot } from './costumes';

const smooth01 = (x: number): number => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/** Joint names (21). Order is the skeleton bone index. */
export const JOINTS = [
  'hips',
  'spine',
  'chest',
  'neck',
  'head',
  'shoulderL',
  'upperArmL',
  'foreArmL',
  'handL',
  'shoulderR',
  'upperArmR',
  'foreArmR',
  'handR',
  'thighL',
  'shinL',
  'footL',
  'toeL',
  'thighR',
  'shinR',
  'footR',
  'toeR',
] as const;
export type JointName = (typeof JOINTS)[number];

/** Rest-pose offsets of each joint from its parent (metres), T-pose-ish with arms down. */
export const REST: Record<JointName, { parent: JointName | null; offset: [number, number, number] }> = {
  hips: { parent: null, offset: [0, 0.98, 0] },
  spine: { parent: 'hips', offset: [0, 0.11, 0] },
  chest: { parent: 'spine', offset: [0, 0.2, 0] },
  neck: { parent: 'chest', offset: [0, 0.23, 0] },
  head: { parent: 'neck', offset: [0, 0.1, 0] },
  shoulderL: { parent: 'chest', offset: [0.085, 0.17, 0] },
  upperArmL: { parent: 'shoulderL', offset: [0.115, 0, 0] },
  foreArmL: { parent: 'upperArmL', offset: [0, -0.29, 0] },
  handL: { parent: 'foreArmL', offset: [0, -0.265, 0] },
  shoulderR: { parent: 'chest', offset: [-0.085, 0.17, 0] },
  upperArmR: { parent: 'shoulderR', offset: [-0.115, 0, 0] },
  foreArmR: { parent: 'upperArmR', offset: [0, -0.29, 0] },
  handR: { parent: 'foreArmR', offset: [0, -0.265, 0] },
  thighL: { parent: 'hips', offset: [0.1, -0.045, 0] },
  shinL: { parent: 'thighL', offset: [0, -0.43, 0] },
  footL: { parent: 'shinL', offset: [0, -0.44, 0] },
  toeL: { parent: 'footL', offset: [0, -0.06, 0.14] },
  thighR: { parent: 'hips', offset: [-0.1, -0.045, 0] },
  shinR: { parent: 'thighR', offset: [0, -0.43, 0] },
  footR: { parent: 'shinR', offset: [0, -0.44, 0] },
  toeR: { parent: 'footR', offset: [0, -0.06, 0.14] },
};

export const LIMB = { upperArm: 0.29, foreArm: 0.265, thigh: 0.43, shin: 0.44, ankle: 0.06 };

export interface CharacterRig {
  mesh: SkinnedMesh;
  bones: Record<JointName, Bone>;
  restQ: Record<JointName, Quaternion>;
  restPos: Record<JointName, Vector3>;
  /** Colour slot of every vertex (index into SLOTS), for costume changes. */
  slots: Uint8Array;
  costume: CostumeId;
}

/** Ellipsoid as [cx, cy, cz, rx, ry, rz] in a bone's local frame. */
type Ell = readonly [number, number, number, number, number, number];
type Pt = readonly [number, number];

/**
 * Point on the front (+Z) of the union of ellipsoids at (x, y), lifted along
 * the surface normal: decals (lenses, emblem) follow the body exactly.
 */
function onFront(surf: readonly Ell[], x: number, y: number, lift: number): [number, number, number, number, number, number] {
  const z = (px: number, py: number): number => {
    let best = -Infinity;
    for (let i = 0; i < surf.length; i++) {
      const [cx, cy, cz, rx, ry, rz] = surf[i]!;
      const u = (px - cx) / rx,
        w = (py - cy) / ry;
      const k = 1 - u * u - w * w;
      // The first surface is the base and is clamped near its silhouette; the others only add bulges.
      if (k <= 0 && i > 0) continue;
      best = Math.max(best, cz + rz * Math.sqrt(Math.max(0.03, k)));
    }
    return best;
  };
  const e = 0.002;
  const z0 = z(x, y);
  let nx = -(z(x + e, y) - z(x - e, y)) / (2 * e),
    ny = -(z(x, y + e) - z(x, y - e)) / (2 * e),
    nz = 1;
  const nl = Math.hypot(nx, ny, nz);
  nx /= nl;
  ny /= nl;
  nz /= nl;
  return [x + nx * lift, y + ny * lift, z0 + nz * lift, nx, ny, nz];
}

/** Closed outline grown outward by `d` (per-vertex offset along the averaged edge normals). */
function grow(outline: readonly Pt[], d: number): Pt[] {
  const n = outline.length;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = outline[i]!,
      b = outline[(i + 1) % n]!;
    area += a[0] * b[1] - b[0] * a[1];
  }
  const sgn = area > 0 ? 1 : -1;
  return outline.map((p, i) => {
    const a = outline[(i + n - 1) % n]!,
      b = outline[(i + 1) % n]!;
    let ex = b[0] - a[0],
      ey = b[1] - a[1];
    const l = Math.hypot(ex, ey) || 1;
    ex /= l;
    ey /= l;
    return [p[0] + ey * d * sgn, p[1] - ex * d * sgn] as Pt;
  });
}

/** Lens outline (hero's left, +X): a teardrop narrowing toward the nose, broad and high at the temple. */
function lensOutline(): Pt[] {
  const cx = 0.051,
    cy = 0.109,
    a = 0.043,
    b = 0.027,
    tilt = 0.52;
  const pts: Pt[] = [];
  const n = 32;
  for (let i = 0; i < n; i++) {
    const th = (i / n) * Math.PI * 2;
    const c = Math.cos(th);
    // Pinch toward the inner end (c < 0) for the teardrop point; flatten the top edge a little.
    const narrow = 1 - 0.72 * Math.pow(Math.max(0, -c), 1.3);
    const flat = Math.sin(th) > 0 ? 0.92 : 1;
    const u = a * c,
      v = b * Math.sin(th) * narrow * flat;
    pts.push([cx + u * Math.cos(tilt) - v * Math.sin(tilt), cy + u * Math.sin(tilt) + v * Math.cos(tilt)]);
  }
  return pts;
}

/** Strip of width w0 at p0 tapering to w1 at p1, as a closed outline. */
function strand(p0: Pt, p1: Pt, w0: number, w1: number): Pt[] {
  let dx = p1[0] - p0[0],
    dy = p1[1] - p0[1];
  const l = Math.hypot(dx, dy) || 1;
  dx /= l;
  dy /= l;
  return [
    [p0[0] - dy * w0 * 0.5, p0[1] + dx * w0 * 0.5],
    [p0[0] + dy * w0 * 0.5, p0[1] - dx * w0 * 0.5],
    [p1[0] + dy * w1 * 0.5, p1[1] - dx * w1 * 0.5],
    [p1[0] - dy * w1 * 0.5, p1[1] + dx * w1 * 0.5],
  ];
}

/**
 * Build the hero: a 21-joint skeleton with rigidly skinned rounded primitives
 * (one draw call). Model faces +Z, height 1.8 m, feet at y = 0. Original
 * design: a full-face mask with large white teardrop lenses, a sleek two-tone
 * suit (main colour on mask, chest, shoulders, gloves and boots; side and leg
 * panels in the second colour) and a geometric thread emblem. Every vertex
 * carries a colour slot so costumes swap without a rebuild.
 */
export function buildCharacter(costume: CostumeId = DEFAULT_COSTUME): CharacterRig {
  const bones = {} as Record<JointName, Bone>;
  for (const name of JOINTS) {
    const b = new Bone();
    b.name = name;
    const r = REST[name];
    b.position.set(...r.offset);
    bones[name] = b;
  }
  for (const name of JOINTS) {
    const p = REST[name].parent;
    if (p) bones[p].add(bones[name]);
  }
  const root = bones.hips;
  root.updateMatrixWorld(true);

  const geo = new GeomBuilder([
    { name: 'skinIndex', size: 4 },
    { name: 'skinWeight', size: 4 },
    { name: 'aEmit', size: 1 },
  ]);
  const slotRuns: Array<[number, number]> = [];
  const boneIndex = (n: JointName): number => JOINTS.indexOf(n);
  const world = new Matrix4();
  // Emit primitives in a bone's local frame, then move them to bind (model) space.
  const part = (bone: JointName, slot: Slot, draw: (g: GeomBuilder) => void): void => {
    const start = geo.vertexCount;
    geo.setExtra('skinIndex', boneIndex(bone), 0, 0, 0);
    geo.setExtra('skinWeight', 1, 0, 0, 0);
    draw(geo);
    slotRuns.push([geo.vertexCount - start, SLOTS.indexOf(slot)]);
    world.copy(bones[bone].matrixWorld);
    geo.applyMatrix(start, world);
  };
  // Tapered limb segment along -Y from 0 to -len (rounded ends via spheres).
  const limb = (g: GeomBuilder, len: number, r0: number, r1: number): void => {
    g.cylinder(0, 0, -len, 0, r1, r0, 12, false);
    g.ellipsoid(0, 0, 0, r0, r0, r0, 12, 6);
    g.ellipsoid(0, -len, 0, r1, r1, r1, 12, 6);
  };
  /** Flat decal on the front of `surf`, triangulated in rings around the outline's centroid. */
  const decal = (g: GeomBuilder, surf: readonly Ell[], outline: readonly Pt[], lift: number, mirror = 1): void => {
    const n = outline.length;
    const cx = outline.reduce((a, c) => a + c[0], 0) / n,
      cy = outline.reduce((a, c) => a + c[1], 0) / n;
    const RINGS = 3;
    const ids: number[][] = [];
    const pos: Array<Array<ReturnType<typeof onFront>>> = [];
    const centre = onFront(surf, cx * mirror, cy, lift);
    const c0 = g.vertex(...centre);
    for (let k = 1; k <= RINGS; k++) {
      const f = k / RINGS;
      ids.push([]);
      pos.push([]);
      for (const p of outline) {
        const q = onFront(surf, (cx + (p[0] - cx) * f) * mirror, cy + (p[1] - cy) * f, lift);
        pos[k - 1]!.push(q);
        ids[k - 1]!.push(g.vertex(...q));
      }
    }
    // Wind each triangle to face along the surface normal.
    const tri = (A: number, B: number, C: number, a: readonly number[], b: readonly number[], c: readonly number[]): void => {
      const ex = b[0]! - a[0]!,
        ey = b[1]! - a[1]!,
        ez = b[2]! - a[2]!;
      const fx = c[0]! - a[0]!,
        fy = c[1]! - a[1]!,
        fz = c[2]! - a[2]!;
      const d = (ey * fz - ez * fy) * a[3]! + (ez * fx - ex * fz) * a[4]! + (ex * fy - ey * fx) * a[5]!;
      if (d >= 0) g.tri(A, B, C);
      else g.tri(A, C, B);
    };
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      tri(c0, ids[0]![i]!, ids[0]![j]!, centre, pos[0]![i]!, pos[0]![j]!);
      for (let k = 0; k + 1 < RINGS; k++) {
        tri(ids[k]![i]!, ids[k + 1]![i]!, ids[k + 1]![j]!, pos[k]![i]!, pos[k + 1]![i]!, pos[k + 1]![j]!);
        tri(ids[k]![i]!, ids[k + 1]![j]!, ids[k]![j]!, pos[k]![i]!, pos[k + 1]![j]!, pos[k]![j]!);
      }
    }
  };

  // ---- Pelvis: second colour, with the belt line as a trim.
  part('hips', 'secondary', (g) => {
    g.ellipsoid(0, -0.012, 0, 0.152, 0.105, 0.104, 14, 8);
    g.ellipsoid(0.068, -0.045, -0.045, 0.074, 0.08, 0.068, 10, 6);
    g.ellipsoid(-0.068, -0.045, -0.045, 0.074, 0.08, 0.068, 10, 6);
  });
  part('hips', 'accent', (g) => g.cylinder(0, 0, 0.04, 0.058, 0.142, 0.14, 18, false));
  // ---- Torso: tapered waist, broad chest; main colour in the centre, second colour down the sides.
  part('spine', 'secondary', (g) => g.ellipsoid(0, 0.08, 0, 0.128, 0.13, 0.09, 14, 8));
  // Main-colour panels down the middle of the belly and the back.
  part('spine', 'primary', (g) => {
    g.ellipsoid(0, 0.09, 0.018, 0.092, 0.13, 0.085, 12, 8);
    g.ellipsoid(0, 0.09, -0.02, 0.084, 0.13, 0.086, 12, 8);
  });
  const CHEST: Ell = [0, 0.08, 0, 0.176, 0.16, 0.106];
  const PEC_L: Ell = [0.062, 0.1, 0.05, 0.074, 0.062, 0.058];
  const PEC_R: Ell = [-0.062, 0.1, 0.05, 0.074, 0.062, 0.058];
  part('chest', 'primary', (g) => {
    g.ellipsoid(...CHEST, 16, 10);
    g.ellipsoid(...PEC_L, 10, 7);
    g.ellipsoid(...PEC_R, 10, 7);
    // Trapezius slope up to the neck.
    g.ellipsoid(0, 0.2, -0.02, 0.11, 0.06, 0.07, 12, 6);
  });
  part('chest', 'secondary', (g) => {
    g.ellipsoid(0.128, 0.035, -0.008, 0.062, 0.13, 0.088, 10, 7);
    g.ellipsoid(-0.128, 0.035, -0.008, 0.062, 0.13, 0.088, 10, 7);
  });
  // Emblem: an elongated diamond with two swept wings (original).
  const chestSurf: readonly Ell[] = [CHEST, PEC_L, PEC_R];
  part('chest', 'accent', (g) => {
    decal(
      g,
      chestSurf,
      [
        [0, 0.14],
        [0.017, 0.105],
        [0, 0.05],
        [-0.017, 0.105],
      ],
      0.004,
    );
    // Two swept wings rising from the diamond.
    for (const m of [1, -1]) decal(g, chestSurf, strand([0.012, 0.112], [0.085, 0.158], 0.013, 0.004), 0.004, m);
  });
  // ---- Neck and head: a full-face mask, egg-shaped with a narrower chin.
  part('neck', 'primary', (g) => g.cylinder(0, 0.005, -0.03, 0.11, 0.058, 0.05, 12, false));
  const HEAD: Ell = [0, 0.08, 0.005, 0.098, 0.124, 0.11];
  part('head', 'primary', (g) => {
    const start = g.vertexCount;
    g.ellipsoid(...HEAD, 24, 16);
    g.transformRange(start, (v, n) => {
      // Taper below the lenses only, so the decals still sit on the plain ellipsoid.
      const f = smooth01((0.06 - v.y) / 0.1);
      v.x *= 1 - 0.2 * f;
      v.z = 0.005 + (v.z - 0.005) * (1 - 0.07 * f);
      n.x *= 1 + 0.2 * f;
      n.normalize();
    });
  });
  const lens = lensOutline();
  part('head', 'rim', (g) => {
    const rim = grow(lens, 0.0075);
    decal(g, [HEAD], rim, 0.0025, 1);
    decal(g, [HEAD], rim, 0.0025, -1);
  });
  part('head', 'lens', (g) => {
    decal(g, [HEAD], lens, 0.005, 1);
    decal(g, [HEAD], lens, 0.005, -1);
  });
  for (const side of ['L', 'R'] as const) {
    const sh = `shoulder${side}` as JointName;
    const ua = `upperArm${side}` as JointName;
    const fa = `foreArm${side}` as JointName;
    const hd = `hand${side}` as JointName;
    const th = `thigh${side}` as JointName;
    const sn = `shin${side}` as JointName;
    const ft = `foot${side}` as JointName;
    const to = `toe${side}` as JointName;
    const sx = side === 'L' ? 1 : -1;
    // Shoulders and deltoids in the main colour, upper arms in the second.
    part(sh, 'primary', (g) => g.ellipsoid(sx * 0.07, 0, 0, 0.06, 0.055, 0.064, 10, 6));
    part(ua, 'primary', (g) => g.ellipsoid(sx * 0.008, -0.028, 0, 0.071, 0.086, 0.071, 12, 7));
    part(ua, 'secondary', (g) => {
      limb(g, LIMB.upperArm, 0.05, 0.044);
      g.ellipsoid(0, -0.125, 0.012, 0.05, 0.1, 0.052, 10, 7);
    });
    // Gloves to the elbow, a trim at the wrist and a slim launcher on the back of the wrist.
    part(fa, 'primary', (g) => {
      limb(g, LIMB.foreArm, 0.047, 0.035);
      g.ellipsoid(0, -0.07, 0.004, 0.049, 0.085, 0.046, 10, 7);
    });
    part(fa, 'accent', (g) => g.cylinder(0, 0, -0.2, -0.188, 0.0395, 0.041, 12, false));
    part(fa, 'detail', (g) => g.box(-0.024, -0.245, -0.044, 0.024, -0.205, -0.03));
    part(fa, 'accent', (g) => g.box(-0.009, -0.238, -0.047, 0.009, -0.212, -0.043));
    part(hd, 'primary', (g) => {
      g.ellipsoid(0, -0.052, 0.003, 0.04, 0.058, 0.026, 10, 6);
      g.ellipsoid(0, -0.098, 0.006, 0.036, 0.04, 0.021, 8, 5);
      g.ellipsoid(sx * 0.03, -0.035, 0.018, 0.016, 0.034, 0.016, 6, 4);
    });
    // Legs: second colour to the knee, main-colour boots below a trim.
    part(th, 'secondary', (g) => {
      limb(g, LIMB.thigh, 0.082, 0.058);
      g.ellipsoid(0, -0.17, 0.018, 0.076, 0.17, 0.07, 12, 8);
    });
    part(sn, 'primary', (g) => {
      limb(g, LIMB.shin, 0.058, 0.04);
      g.ellipsoid(0, -0.13, -0.022, 0.055, 0.12, 0.054, 10, 7);
    });
    part(sn, 'accent', (g) => g.cylinder(0, 0, -0.045, -0.03, 0.0575, 0.059, 12, false));
    part(ft, 'primary', (g) => g.ellipsoid(0, -0.034, 0.03, 0.046, 0.043, 0.096, 10, 6));
    part(ft, 'detail', (g) => g.box(-0.033, -0.079, -0.035, 0.033, -0.071, 0.11));
    part(to, 'primary', (g) => g.ellipsoid(0, 0.013, 0.03, 0.044, 0.031, 0.05, 10, 6));
    part(to, 'detail', (g) => g.box(-0.032, -0.019, -0.01, 0.032, -0.011, 0.06));
  }

  const geometry = geo.build();
  const slots = new Uint8Array(geo.vertexCount);
  let at = 0;
  for (const [count, slot] of slotRuns) {
    slots.fill(slot, at, at + count);
    at += count;
  }
  const mat = new MeshToonMaterial({ vertexColors: true, gradientMap: toonGradient() });
  withMRT(mat, true, 'hero', (shader) => {
    shader.uniforms.uHeroLight = shared.uHeroLight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aEmit;\nvarying float vEmit;')
      .replace('#include <color_vertex>', '#include <color_vertex>\nvEmit = aEmit;');
    // Cinematic light on the hero only (night, the rooftop moment): a fill
    // that lifts the suit's own colours and a cool rim on the silhouette, so
    // the suit reads against a dark roof without brightening the scene.
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vEmit;\nuniform float uHeroLight;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
totalEmissiveRadiance += diffuseColor.rgb * vEmit * 0.9;
float heroRim = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 3.0);
totalEmissiveRadiance += uHeroLight * (diffuseColor.rgb * 0.32 + vec3(0.42, 0.52, 0.75) * heroRim * 0.45);`,
      );
  });
  const mesh = new SkinnedMesh(geometry, mat);
  mesh.add(root);
  const skeleton = new Skeleton(JOINTS.map((n) => bones[n]));
  mesh.bind(skeleton);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  mesh.name = 'hero';
  const restQ = {} as Record<JointName, Quaternion>;
  const restPos = {} as Record<JointName, Vector3>;
  for (const n of JOINTS) {
    restQ[n] = bones[n].quaternion.clone();
    restPos[n] = bones[n].position.clone();
  }
  const rig: CharacterRig = { mesh, bones, restQ, restPos, slots, costume };
  setCostume(rig, costume);
  return rig;
}

/** Repaint the suit: writes each vertex's slot colour and glow for the costume. */
export function setCostume(rig: CharacterRig, id: CostumeId): void {
  const c = COSTUMES[id];
  const geometry = rig.mesh.geometry;
  const color = geometry.getAttribute('color') as BufferAttribute;
  const emit = geometry.getAttribute('aEmit') as BufferAttribute;
  const col = color.array as Float32Array;
  const em = emit.array as Float32Array;
  const slots = rig.slots;
  for (let i = 0; i < slots.length; i++) {
    const slot = SLOTS[slots[i]!]!;
    const rgb = c.colors[slot];
    col[i * 3] = rgb[0];
    col[i * 3 + 1] = rgb[1];
    col[i * 3 + 2] = rgb[2];
    em[i] = c.emit[slot];
  }
  color.needsUpdate = true;
  emit.needsUpdate = true;
  rig.costume = id;
}
