import { Color, DataTexture, FloatType, MeshDepthMaterial, MeshToonMaterial, NearestFilter, RGBAFormat, type IUniform } from 'three';
import { shared, toonGradient, withMRT } from '../../render/materials';

/**
 * Instanced skinning for the enemy rigs: one `InstancedMesh` per archetype,
 * one draw call for all its enemies. The animator writes each visible
 * enemy's skinning matrices into a shared float texture (one row per
 * instance, three texels per bone: the rows of a 3x4 affine matrix that maps
 * a bind-pose vertex to the posed model space). The vertex shader fetches
 * its bone's row with `gl_InstanceID`; the instance matrix then places the
 * model in the world (feet position and yaw).
 *
 * Per-instance attributes: `iState` (x wind-up tell 0..1, y hit flash 0..1,
 * z prop hide mask, w casts a shadow), `iLook` (skin tone 0..1) and the
 * instance colour (the tinted clothes). The depth material used for the
 * shadow map runs the same skinning and drops instances without a shadow.
 */

/** Texels per row: 3 per bone, up to 32 bones (the boss rigs of chunk 8 add bones). */
export const BONE_TEX_W = 96;
/** Rows: enemies drawn at once (all archetypes). */
export const BONE_TEX_ROWS = 32;

export function makeBoneTexture(): DataTexture {
  const t = new DataTexture(new Float32Array(BONE_TEX_W * BONE_TEX_ROWS * 4), BONE_TEX_W, BONE_TEX_ROWS, RGBAFormat, FloatType);
  t.minFilter = NearestFilter;
  t.magFilter = NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

const DECL = /* glsl */ `
attribute float aBone;
attribute float aSlot;
attribute float aProp;
attribute vec2 aFx;
attribute vec4 iState;
attribute float iLook;
uniform highp sampler2D uBones;
uniform float uRowBase;
vec3 enemyXf(vec3 p, float w) {
  ivec2 c = ivec2(int(aBone + 0.5) * 3, int(uRowBase + 0.5) + gl_InstanceID);
  vec4 r0 = texelFetch(uBones, c, 0);
  vec4 r1 = texelFetch(uBones, c + ivec2(1, 0), 0);
  vec4 r2 = texelFetch(uBones, c + ivec2(2, 0), 0);
  return vec3(dot(r0.xyz, p) + r0.w * w, dot(r1.xyz, p) + r1.w * w, dot(r2.xyz, p) + r2.w * w);
}
bool enemyHidden() {
  return (int(iState.z + 0.5) & int(aProp + 0.5)) != 0;
}
`;

const BEGIN = /* glsl */ `
vec3 transformed = enemyXf(position, 1.0);
if (enemyHidden()) transformed = vec3(0.0);
`;

export interface EnemyUniforms {
  uBones: IUniform<DataTexture>;
  uRowBase: IUniform<number>;
}

/** Tell glow colour (wind-up): hot orange. */
const TELL = new Color(1.0, 0.36, 0.08);

/** Cel material of one archetype mesh (shares its program with the others; `uRowBase` differs). */
export function enemyMaterial(u: EnemyUniforms, key: string): MeshToonMaterial {
  const m = new MeshToonMaterial({ vertexColors: true, gradientMap: toonGradient() });
  withMRT(m, true, 'enemy', (shader) => {
    shader.uniforms.uBones = u.uBones;
    shader.uniforms.uRowBase = u.uRowBase;
    shader.uniforms.uNight = shared.uNight;
    shader.uniforms.uTell = { value: TELL };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${DECL}\nvarying vec3 vEnemyFx;`)
      .replace(
        '#include <color_vertex>',
        `vColor = vec4(color, 1.0);
#ifdef USE_INSTANCING_COLOR
if (aSlot > 0.5 && aSlot < 1.5) vColor.rgb *= instanceColor.rgb;
#endif
if (aSlot > 1.5) vColor.rgb = mix(vec3(0.78, 0.53, 0.38), vec3(0.2, 0.11, 0.07), iLook);
vEnemyFx = vec3(aFx.x, aFx.y * iState.x, iState.y);`,
      )
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = enemyXf(normal, 0.0);')
      .replace('#include <begin_vertex>', BEGIN);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vEnemyFx;\nuniform float uNight;\nuniform vec3 uTell;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
totalEmissiveRadiance += diffuseColor.rgb * vEnemyFx.x * 1.3;
totalEmissiveRadiance += uTell * vEnemyFx.y * 1.8;
totalEmissiveRadiance += (diffuseColor.rgb * 0.8 + vec3(0.35)) * vEnemyFx.z;
// A cool rim at night keeps the silhouettes readable on dark streets.
float enemyRim = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 3.0);
totalEmissiveRadiance += uNight * enemyRim * vec3(0.3, 0.36, 0.5) * 0.4;`,
      );
  });
  m.name = `enemy-${key}`;
  return m;
}

/** Shadow-map depth material with the same skinning; instances with `iState.w` = 0 cast no shadow. */
export function enemyDepthMaterial(u: EnemyUniforms): MeshDepthMaterial {
  const m = new MeshDepthMaterial();
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uBones = u.uBones;
    shader.uniforms.uRowBase = u.uRowBase;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${DECL}`)
      .replace('#include <begin_vertex>', BEGIN)
      .replace('#include <project_vertex>', '#include <project_vertex>\nif (iState.w < 0.5) gl_Position = vec4(0.0, 0.0, -2.0, 1.0);');
  };
  m.customProgramCacheKey = () => 'enemy-depth';
  return m;
}
