import type { BufferGeometry } from 'three';
import { JOINTS, REST, type JointName } from '../../character/rig';
import { GeomBuilder } from '../../render/geomBuilder';
import { EK } from '../types';

/**
 * Low-detail enemy rigs: one merged, rigidly skinned geometry per archetype.
 * Humanoids reuse the hero's 21-joint skeleton (`character/rig.ts`, same
 * joint order and rest offsets, scaled per archetype) with simpler, lower
 * poly primitives; the drone is a 5-bone rig (body and four rotors).
 *
 * Every vertex carries:
 * - `aBone`: its bone (rigid skinning, weight 1);
 * - `aSlot`: 0 fixed colour, 1 tinted by the instance colour (clothes vary
 *   per enemy), 2 skin (tone per instance);
 * - `aProp`: prop bits the instance can hide (`PROP`: weapon, shield, bottle);
 * - `aFx`: x = self-illumination, y = lights up with the wind-up tell.
 *
 * Bones have no rest rotation (as on the hero), so a bone's bind transform
 * is a translation to its rest position; the animator writes skinning
 * matrices relative to it (see `enemyMaterial.ts`).
 */

/** Hideable props (`aProp` bits, `iState.z` hide mask). */
export const PROP = { WEAPON: 1, SHIELD: 2, BOTTLE: 4 } as const;

/** Render archetypes: one instanced mesh each. */
export const ARCH = { THUG: 0, BAT: 1, GUNMAN: 2, BRUTE: 3, DRONE: 4 } as const;
export const ARCH_COUNT = 5;
export const ARCH_NAMES = ['thug', 'bat', 'gunman', 'brute', 'drone'] as const;

/** Render archetype of an enemy kind (bosses get their own rigs in chunk 8; until then the closest archetype). */
export function archOf(kind: number): number {
  switch (kind) {
    case EK.THUG:
      return ARCH.THUG;
    case EK.BAT:
      return ARCH.BAT;
    case EK.GUNMAN:
      return ARCH.GUNMAN;
    case EK.DRONE:
    case EK.KUZGUN:
      return ARCH.DRONE;
    default:
      return ARCH.BRUTE;
  }
}

export interface RigDef {
  arch: number;
  geometry: BufferGeometry;
  bones: number;
  /** Parent bone index per bone (-1 root). */
  parent: Int8Array;
  /** Rest offset of each bone from its parent (model space, metres), xyz per bone. */
  offset: Float32Array;
  /** Rest (bind) position of each bone in model space, xyz per bone. */
  bind: Float32Array;
  /** Uniform size factor against the hero skeleton (humanoids). */
  scale: number;
  /** Bounding sphere around the model origin (culling): centre height and radius. */
  cy: number;
  radius: number;
  triangles: number;
}

export const J = Object.fromEntries(JOINTS.map((n, i) => [n, i])) as Record<JointName, number>;

type Rgb = readonly [number, number, number];

/** Instance tint palettes per archetype (linear RGB): the tinted part of the clothes. */
export const TINTS: readonly (readonly Rgb[])[] = [
  // Thug hoodies: dark red, bottle green, charcoal, mustard, navy, plum.
  [
    [0.34, 0.05, 0.05],
    [0.05, 0.19, 0.09],
    [0.11, 0.11, 0.13],
    [0.36, 0.25, 0.04],
    [0.04, 0.08, 0.24],
    [0.2, 0.06, 0.18],
  ],
  // Bat thug vests: yellow, orange red, off-white, teal.
  [
    [0.62, 0.46, 0.05],
    [0.6, 0.14, 0.03],
    [0.66, 0.66, 0.6],
    [0.04, 0.33, 0.33],
  ],
  // Gunman shirts under the coat: wine, petrol, mauve.
  [
    [0.32, 0.03, 0.08],
    [0.03, 0.16, 0.2],
    [0.24, 0.1, 0.26],
  ],
  // Brute hazard stripes: safety orange, yellow.
  [
    [0.85, 0.28, 0.02],
    [0.8, 0.58, 0.02],
  ],
  // Drone accent rings: red, amber.
  [
    [0.75, 0.08, 0.05],
    [0.85, 0.42, 0.04],
  ],
];

interface Opts {
  scale: number;
  /** Girth multiplier for the torso and limbs. */
  bulk: number;
}

const OPTS: readonly Opts[] = [
  { scale: 1.0, bulk: 1.12 },
  { scale: 1.02, bulk: 1.18 },
  { scale: 1.0, bulk: 1.05 },
  { scale: 1.17, bulk: 1.5 },
];

function humanoidSkeleton(scale: number): { parent: Int8Array; offset: Float32Array; bind: Float32Array } {
  const n = JOINTS.length;
  const parent = new Int8Array(n);
  const offset = new Float32Array(n * 3);
  const bind = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = REST[JOINTS[i]!];
    const p = r.parent ? J[r.parent] : -1;
    parent[i] = p;
    for (let k = 0; k < 3; k++) {
      offset[i * 3 + k] = r.offset[k]! * scale;
      bind[i * 3 + k] = offset[i * 3 + k]! + (p >= 0 ? bind[p * 3 + k]! : 0);
    }
  }
  return { parent, offset, bind };
}

function newBuilder(): GeomBuilder {
  return new GeomBuilder([
    { name: 'aBone', size: 1 },
    { name: 'aSlot', size: 1 },
    { name: 'aProp', size: 1 },
    { name: 'aFx', size: 2 },
  ]);
}

const SLOT_FIXED = 0;
const SLOT_TINT = 1;
const SLOT_SKIN = 2;

/**
 * Helper over a builder: primitives in a bone's local frame (origin at the
 * joint, rest orientation), moved to its bind position.
 */
class Parts {
  constructor(
    readonly g: GeomBuilder,
    readonly bind: Float32Array,
  ) {}

  part(bone: number, slot: number, rgb: Rgb, draw: (g: GeomBuilder) => void, prop = 0, emit = 0, glow = 0): void {
    const g = this.g;
    const start = g.vertexCount;
    g.setColor(rgb[0], rgb[1], rgb[2]);
    g.setExtra('aBone', bone);
    g.setExtra('aSlot', slot);
    g.setExtra('aProp', prop);
    g.setExtra('aFx', emit, glow);
    draw(g);
    const bx = this.bind[bone * 3]!,
      by = this.bind[bone * 3 + 1]!,
      bz = this.bind[bone * 3 + 2]!;
    g.transformRange(start, (v) => {
      v.x += bx;
      v.y += by;
      v.z += bz;
    });
  }
}

/** Tapered limb along -Y from the joint (0) to -len, rounded at both ends. */
function limb(g: GeomBuilder, len: number, r0: number, r1: number): void {
  g.cylinder(0, 0, -len, 0, r1, r0, 8, false);
  g.ellipsoid(0, 0, 0, r0, r0, r0, 8, 4);
  g.ellipsoid(0, -len, 0, r1, r1, r1, 8, 4);
}

// Shared colours (linear).
const JEANS: Rgb = [0.05, 0.08, 0.17];
const DARK: Rgb = [0.025, 0.025, 0.03];
const SOLE: Rgb = [0.6, 0.6, 0.58];
const WHITE: Rgb = [0.72, 0.72, 0.7];
const HAIR: Rgb = [0.03, 0.022, 0.018];
const WOOD: Rgb = [0.42, 0.24, 0.09];
const METAL: Rgb = [0.07, 0.075, 0.085];
const GLASS: Rgb = [0.05, 0.2, 0.08];
const RED_LIGHT: Rgb = [1.0, 0.12, 0.06];

/**
 * The shared humanoid body: pelvis, torso, neck, head, arms, legs and shoes.
 * `top` colours the torso and sleeves (slot), `bare` leaves the forearms
 * (or the whole arms) as skin; `pants`/`shoes` colour the legs.
 */
function body(
  P: Parts,
  s: number,
  b: number,
  o: {
    top: number;
    topRgb: Rgb;
    pants: Rgb;
    shoes: Rgb;
    sleeves: 'long' | 'short' | 'none';
    fistGlow: boolean;
    hands?: Rgb;
  },
): void {
  const T = (bone: number, draw: (g: GeomBuilder) => void): void => P.part(bone, o.top, o.topRgb, draw);
  const SK = (bone: number, draw: (g: GeomBuilder) => void, glow = 0): void => P.part(bone, SLOT_SKIN, WHITE, draw, 0, 0, glow);
  // Pelvis and belt.
  P.part(J.hips, SLOT_FIXED, o.pants, (g) => g.ellipsoid(0, -0.01 * s, 0, 0.16 * s * b, 0.11 * s, 0.11 * s * b, 10, 6));
  P.part(J.hips, SLOT_FIXED, DARK, (g) => g.cylinder(0, 0, 0.035 * s, 0.07 * s, 0.15 * s * b, 0.148 * s * b, 10, false));
  // Torso.
  T(J.spine, (g) => g.ellipsoid(0, 0.08 * s, 0, 0.14 * s * b, 0.14 * s, 0.1 * s * b, 10, 6));
  T(J.chest, (g) => {
    g.ellipsoid(0, 0.08 * s, 0, 0.185 * s * b, 0.17 * s, 0.115 * s * b, 12, 7);
    g.ellipsoid(0, 0.2 * s, -0.02 * s, 0.12 * s * b, 0.065 * s, 0.075 * s * b, 8, 4);
  });
  SK(J.neck, (g) => g.cylinder(0, 0.005 * s, -0.03 * s, 0.11 * s, 0.06 * s * b, 0.052 * s * b, 8, false));
  SK(J.head, (g) => g.ellipsoid(0, 0.08 * s, 0.006 * s, 0.098 * s, 0.122 * s, 0.108 * s, 12, 8));
  for (const side of [1, -1] as const) {
    const L = side === 1;
    const sh = L ? J.shoulderL : J.shoulderR;
    const ua = L ? J.upperArmL : J.upperArmR;
    const fa = L ? J.foreArmL : J.foreArmR;
    const hd = L ? J.handL : J.handR;
    const th = L ? J.thighL : J.thighR;
    const sn = L ? J.shinL : J.shinR;
    const ft = L ? J.footL : J.footR;
    const to = L ? J.toeL : J.toeR;
    T(sh, (g) => g.ellipsoid(side * 0.07 * s, 0, 0, 0.065 * s * b, 0.06 * s * b, 0.068 * s * b, 8, 4));
    const arm = (g: GeomBuilder): void => limb(g, 0.29 * s, 0.056 * s * b, 0.048 * s * b);
    if (o.sleeves === 'none') SK(ua, arm);
    else T(ua, arm);
    const fore = (g: GeomBuilder): void => limb(g, 0.265 * s, 0.05 * s * b, 0.038 * s * b);
    if (o.sleeves === 'long') T(fa, fore);
    else SK(fa, fore);
    const fist = (g: GeomBuilder): void => g.ellipsoid(0, -0.06 * s, 0.006 * s, 0.048 * s * b, 0.066 * s, 0.04 * s * b, 8, 5);
    if (o.hands) P.part(hd, SLOT_FIXED, o.hands, fist, 0, 0, o.fistGlow ? 1 : 0);
    else SK(hd, fist, o.fistGlow ? 1 : 0);
    P.part(th, SLOT_FIXED, o.pants, (g) => limb(g, 0.43 * s, 0.09 * s * b, 0.064 * s * b));
    P.part(sn, SLOT_FIXED, o.pants, (g) => limb(g, 0.44 * s, 0.064 * s * b, 0.046 * s * b));
    P.part(ft, SLOT_FIXED, o.shoes, (g) => g.ellipsoid(0, -0.035 * s, 0.035 * s, 0.054 * s * b, 0.045 * s, 0.105 * s, 8, 4));
    P.part(ft, SLOT_FIXED, SOLE, (g) => g.box(-0.05 * s * b, -0.08 * s, -0.04 * s, 0.05 * s * b, -0.066 * s, 0.12 * s));
    P.part(to, SLOT_FIXED, o.shoes, (g) => g.ellipsoid(0, 0.012 * s, 0.03 * s, 0.05 * s * b, 0.032 * s, 0.05 * s, 8, 4));
  }
}

function finish(arch: number, g: GeomBuilder, sk: { parent: Int8Array; offset: Float32Array; bind: Float32Array }, scale: number, cy: number, radius: number): RigDef {
  const triangles = g.triangleCount;
  const geometry = g.build();
  return { arch, geometry, bones: sk.parent.length, parent: sk.parent, offset: sk.offset, bind: sk.bind, scale, cy, radius, triangles };
}

/** Street thug ("Serseri"): hoodie with the hood up (tinted), jeans, white sneakers; fists light up in the wind-up. */
function buildThug(): RigDef {
  const { scale: s, bulk: b } = OPTS[ARCH.THUG]!;
  const sk = humanoidSkeleton(s);
  const g = newBuilder();
  const P = new Parts(g, sk.bind);
  body(P, s, b, { top: SLOT_TINT, topRgb: WHITE, pants: JEANS, shoes: WHITE, sleeves: 'long', fistGlow: true });
  // Hood: a shell over the back and top of the head, a drawstring pouch on the belly.
  P.part(J.head, SLOT_TINT, WHITE, (g) => {
    g.ellipsoid(0, 0.1 * s, -0.025 * s, 0.118 * s, 0.135 * s, 0.12 * s, 10, 6);
  });
  P.part(J.chest, SLOT_TINT, [0.8, 0.8, 0.8], (g) => g.ellipsoid(0, -0.02 * s, 0.1 * s * b, 0.11 * s * b, 0.06 * s, 0.035 * s, 8, 4));
  P.part(J.chest, SLOT_FIXED, WHITE, (g) => {
    g.box(0.03 * s, 0.1 * s, 0.11 * s * b, 0.04 * s, 0.2 * s, 0.12 * s * b);
    g.box(-0.04 * s, 0.1 * s, 0.11 * s * b, -0.03 * s, 0.2 * s, 0.12 * s * b);
  });
  // Face shadow inside the hood.
  P.part(J.head, SLOT_FIXED, DARK, (g) => g.box(-0.07 * s, 0.11 * s, 0.085 * s, 0.07 * s, 0.135 * s, 0.1 * s));
  // A bottle on the belt (thrown at heroes above; hidden while in hand, chunk 6).
  P.part(J.handR, SLOT_FIXED, GLASS, (g) => {
    g.cylinder(0, 0.04 * s, -0.2 * s, -0.08 * s, 0.03 * s, 0.03 * s, 6, true);
    g.cylinder(0, 0.04 * s, -0.08 * s, -0.02 * s, 0.03 * s, 0.012 * s, 6, true);
  }, PROP.BOTTLE, 0, 1);
  return finish(ARCH.THUG, g, sk, s, 1.0 * s, 1.15 * s);
}

/** Bat thug ("Sopalı"): sleeveless vest (tinted), bare arms, red bandana, cargo pants, a taped baseball bat in the right hand. */
function buildBat(): RigDef {
  const { scale: s, bulk: b } = OPTS[ARCH.BAT]!;
  const sk = humanoidSkeleton(s);
  const g = newBuilder();
  const P = new Parts(g, sk.bind);
  body(P, s, b, { top: SLOT_TINT, topRgb: WHITE, pants: [0.13, 0.15, 0.07], shoes: [0.08, 0.06, 0.04], sleeves: 'none', fistGlow: false, hands: [0.05, 0.05, 0.05] });
  // Bandana and its knot.
  P.part(J.head, SLOT_FIXED, [0.55, 0.04, 0.04], (g) => {
    g.ellipsoid(0, 0.12 * s, -0.005 * s, 0.104 * s, 0.09 * s, 0.114 * s, 10, 5);
    g.ellipsoid(0, 0.1 * s, -0.12 * s, 0.03 * s, 0.03 * s, 0.03 * s, 6, 3);
  });
  P.part(J.head, SLOT_FIXED, DARK, (g) => g.box(-0.06 * s, 0.075 * s, 0.09 * s, 0.06 * s, 0.1 * s, 0.105 * s));
  // Baseball bat: grip in the fist, barrel along the forearm direction (down when hanging, up in the swing).
  P.part(J.handR, SLOT_FIXED, WOOD, (g) => {
    g.cylinder(0, 0.01 * s, -0.12 * s, 0.0, 0.017 * s, 0.017 * s, 6, true);
    g.cylinder(0, 0.01 * s, -0.12 * s, -0.42 * s, 0.017 * s, 0.024 * s, 6, false);
    g.cylinder(0, 0.01 * s, -0.42 * s, -0.8 * s, 0.024 * s, 0.035 * s, 7, true);
  }, PROP.WEAPON, 0, 1);
  P.part(J.handR, SLOT_FIXED, DARK, (g) => g.cylinder(0, 0.01 * s, -0.11 * s, -0.02 * s, 0.02 * s, 0.02 * s, 6, false), PROP.WEAPON);
  return finish(ARCH.BAT, g, sk, s, 1.0 * s, 1.35 * s);
}

/** Gunman ("Silahlı"): long dark coat over a tinted shirt, slick hair, sunglasses, a pistol with a red laser emitter. */
function buildGunman(): RigDef {
  const { scale: s, bulk: b } = OPTS[ARCH.GUNMAN]!;
  const sk = humanoidSkeleton(s);
  const g = newBuilder();
  const P = new Parts(g, sk.bind);
  const COAT: Rgb = [0.028, 0.03, 0.036];
  body(P, s, b, { top: SLOT_FIXED, topRgb: COAT, pants: [0.03, 0.03, 0.035], shoes: [0.02, 0.015, 0.012], sleeves: 'long', fistGlow: false, hands: [0.02, 0.02, 0.022] });
  // Shirt front and collar.
  P.part(J.chest, SLOT_TINT, WHITE, (g) => g.ellipsoid(0, 0.1 * s, 0.075 * s, 0.07 * s, 0.13 * s, 0.05 * s, 8, 5));
  // Coat skirt down to the knees (on the hips, so it follows the pelvis).
  P.part(J.hips, SLOT_FIXED, COAT, (g) => g.cylinder(0, 0, -0.5 * s, 0.03 * s, 0.24 * s * b, 0.17 * s * b, 10, false));
  // Hair and sunglasses.
  P.part(J.head, SLOT_FIXED, HAIR, (g) => g.ellipsoid(0, 0.125 * s, -0.012 * s, 0.103 * s, 0.085 * s, 0.112 * s, 10, 5));
  P.part(J.head, SLOT_FIXED, DARK, (g) => g.box(-0.08 * s, 0.085 * s, 0.085 * s, 0.08 * s, 0.115 * s, 0.11 * s));
  // Pistol: the barrel continues the forearm (local -Y), the grip hangs below it (local -Z, which is down
  // when the arm is raised to aim), the laser emitter under the muzzle.
  P.part(J.handR, SLOT_FIXED, METAL, (g) => {
    g.box(-0.018 * s, -0.25 * s, -0.022 * s, 0.018 * s, -0.06 * s, 0.022 * s);
    g.box(-0.016 * s, -0.11 * s, -0.12 * s, 0.016 * s, -0.06 * s, -0.02 * s);
  }, PROP.WEAPON);
  P.part(J.handR, SLOT_FIXED, RED_LIGHT, (g) => g.box(-0.01 * s, -0.25 * s, -0.05 * s, 0.01 * s, -0.2 * s, -0.025 * s), PROP.WEAPON, 0.6, 1);
  return finish(ARCH.GUNMAN, g, sk, s, 1.0 * s, 1.2 * s);
}

/** Shielded brute ("Kalkanlı"): big armoured body, helmet with a glowing visor, hazard stripes (tinted), riot shield on the left forearm. */
function buildBrute(): RigDef {
  const { scale: s, bulk: b } = OPTS[ARCH.BRUTE]!;
  const sk = humanoidSkeleton(s);
  const g = newBuilder();
  const P = new Parts(g, sk.bind);
  const ARMOR: Rgb = [0.09, 0.1, 0.085];
  const PADS: Rgb = [0.16, 0.17, 0.14];
  body(P, s, b, { top: SLOT_FIXED, topRgb: ARMOR, pants: [0.06, 0.065, 0.06], shoes: DARK, sleeves: 'long', fistGlow: false, hands: DARK });
  // Chest plate with a hazard stripe, shoulder pads, knee pads.
  P.part(J.chest, SLOT_FIXED, PADS, (g) => g.ellipsoid(0, 0.1 * s, 0.03 * s, 0.2 * s * b, 0.15 * s, 0.11 * s * b, 10, 5));
  P.part(J.chest, SLOT_TINT, WHITE, (g) => g.box(-0.16 * s * b, 0.05 * s, 0.085 * s * b, 0.16 * s * b, 0.09 * s, 0.17 * s * b));
  for (const side of [1, -1]) {
    P.part(side > 0 ? J.shoulderL : J.shoulderR, SLOT_FIXED, PADS, (g) => g.ellipsoid(side * 0.09 * s, 0.03 * s, 0, 0.1 * s * b, 0.07 * s * b, 0.1 * s * b, 8, 4));
    P.part(side > 0 ? J.shinL : J.shinR, SLOT_FIXED, PADS, (g) => g.ellipsoid(0, -0.02 * s, 0.05 * s, 0.07 * s * b, 0.08 * s, 0.05 * s * b, 6, 4));
  }
  // Right gauntlet (the slam lights it up).
  P.part(J.handR, SLOT_FIXED, PADS, (g) => g.ellipsoid(0, -0.06 * s, 0.006 * s, 0.075 * s * b, 0.085 * s, 0.065 * s * b, 8, 5), 0, 0, 1);
  // Helmet, visor and a dark face slot.
  P.part(J.head, SLOT_FIXED, ARMOR, (g) => g.ellipsoid(0, 0.1 * s, -0.005 * s, 0.118 * s, 0.13 * s, 0.124 * s, 10, 6));
  P.part(J.head, SLOT_FIXED, [0.9, 0.62, 0.08], (g) => g.box(-0.08 * s, 0.075 * s, 0.1 * s, 0.08 * s, 0.11 * s, 0.13 * s), 0, 0.55);
  // Riot shield on the left forearm, on its local -Z side: in the guard pose the forearm points up in
  // front of the chest and local -Z faces forward, so the slab covers the torso and the head.
  P.part(J.foreArmL, SLOT_FIXED, [0.13, 0.17, 0.24], (g) => g.box(-0.24 * s, -0.5 * s, -0.13 * s, 0.24 * s, 0.26 * s, -0.09 * s), PROP.SHIELD);
  P.part(J.foreArmL, SLOT_FIXED, [0.72, 0.72, 0.7], (g) => g.box(-0.22 * s, -0.17 * s, -0.137 * s, 0.22 * s, -0.12 * s, -0.129 * s), PROP.SHIELD);
  P.part(J.foreArmL, SLOT_FIXED, DARK, (g) => g.box(-0.04 * s, -0.3 * s, -0.09 * s, 0.04 * s, -0.08 * s, -0.04 * s), PROP.SHIELD);
  return finish(ARCH.BRUTE, g, sk, s, 1.05 * s, 1.35 * s);
}

/** Drone ("Dron"): a flattened pod with an accent ring, four arms with spinning rotors and a glowing eye in front (+Z). */
function buildDrone(): RigDef {
  // Bones: 0 body (centre at the model origin), 1-4 rotors at the arm tips.
  const parent = new Int8Array([-1, 0, 0, 0, 0]);
  const arm = 0.5;
  const offset = new Float32Array([0, 0, 0, arm, 0.1, arm, -arm, 0.1, arm, arm, 0.1, -arm, -arm, 0.1, -arm]);
  const bind = Float32Array.from(offset);
  const sk = { parent, offset, bind };
  const g = newBuilder();
  const P = new Parts(g, bind);
  const SHELL: Rgb = [0.5, 0.52, 0.56];
  P.part(0, SLOT_FIXED, SHELL, (g) => {
    g.ellipsoid(0, 0, 0, 0.36, 0.2, 0.36, 12, 7);
    g.ellipsoid(0, -0.15, 0, 0.18, 0.1, 0.18, 8, 4);
  });
  P.part(0, SLOT_TINT, WHITE, (g) => g.cylinder(0, 0, -0.035, 0.035, 0.375, 0.375, 14, false));
  // Arms out to the rotors and rotor hubs.
  for (const [x, z] of [
    [arm, arm],
    [-arm, arm],
    [arm, -arm],
    [-arm, -arm],
  ] as const) {
    P.part(0, SLOT_FIXED, DARK, (g) => g.orientedBox(x * 0.6, 0.04, z * 0.6, 0.035, 0.025, 0.36, Math.atan2(x, z)));
    P.part(0, SLOT_FIXED, DARK, (g) => g.cylinder(x, z, 0.0, 0.12, 0.05, 0.05, 8, true));
  }
  // Rotors: two thin blades per hub (spun by their bone).
  for (let r = 1; r <= 4; r++) {
    P.part(r, SLOT_FIXED, [0.12, 0.12, 0.13], (g) => {
      g.box(-0.3, 0.035, -0.025, 0.3, 0.05, 0.025);
      g.box(-0.025, 0.035, -0.3, 0.025, 0.05, 0.3);
    });
  }
  // The eye: a dark socket and a glowing lens facing forward.
  P.part(0, SLOT_FIXED, DARK, (g) => g.ellipsoid(0, 0.0, 0.3, 0.12, 0.1, 0.08, 10, 5));
  P.part(0, SLOT_FIXED, RED_LIGHT, (g) => g.ellipsoid(0, 0.0, 0.355, 0.07, 0.06, 0.04, 10, 5), 0, 1.0, 1);
  return finish(ARCH.DRONE, g, sk, 1, 0, 0.95);
}

let rigs: RigDef[] | null = null;

/** The five archetype rigs (built once, shared by every instance). */
export function enemyRigs(): readonly RigDef[] {
  if (!rigs) rigs = [buildThug(), buildBat(), buildGunman(), buildBrute(), buildDrone()];
  return rigs;
}
