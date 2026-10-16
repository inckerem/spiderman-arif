import {
  AdditiveBlending,
  Color,
  DataTexture,
  DoubleSide,
  FrontSide,
  Material,
  MeshBasicMaterial,
  MeshToonMaterial,
  NearestFilter,
  RedFormat,
  ShaderChunk,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector3,
  Vector4,
  type IUniform,
  type Texture,
  type WebGLProgramParametersWithUniforms,
} from 'three';

/** Uniforms shared by every patched material, updated once per frame. */
export const shared = {
  uTime: { value: 0 } as IUniform<number>,
  /** Street lamp brightness (0 off .. 1 full). */
  uLamp: { value: 0 } as IUniform<number>,
  uSignAtlas: { value: null as Texture | null } as IUniform<Texture | null>,
  /** 0 = day, 1 = full night (window lights, lamps). */
  uNight: { value: 0 } as IUniform<number>,
  uWind: { value: 1 } as IUniform<number>,
  /** Sky colour reflected by glass. */
  uSkyRefl: { value: new Color(0x9fc7e6) } as IUniform<Color>,
  uWinAtlas: { value: null as Texture | null } as IUniform<Texture | null>,
  /** Hero-only cinematic rim and fill (0 off .. 1 full): night and the rooftop moment. */
  uHeroLight: { value: 0 } as IUniform<number>,
};

let gradientTex: DataTexture | null = null;

/** Four-band toon ramp (hard steps, no filtering: crisp cel shading). */
export function toonGradient(): DataTexture {
  if (gradientTex) return gradientTex;
  const data = new Uint8Array([88, 140, 205, 255]);
  const t = new DataTexture(data, 4, 1, RedFormat);
  t.minFilter = NearestFilter;
  t.magFilter = NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  gradientTex = t;
  return t;
}

/**
 * three's PCF shadows rotate their five taps by per-pixel noise that is meant
 * to be averaged away by TAA. Without TAA it reads as stippled grain along
 * every shadow edge, so the taps keep one fixed pattern: a clean, stable edge
 * (each tap is still a filtered 2x2 compare). Call before any shader compiles.
 */
export function stableShadowSampling(): void {
  ShaderChunk.shadowmap_pars_fragment = ShaderChunk.shadowmap_pars_fragment.replace(
    /interleavedGradientNoise\( gl_FragCoord\.xy \) \* PI2/g,
    '0.0',
  );
}

const MRT_DECL = 'layout(location = 1) out highp vec4 gNormalOut;\n';
const MRT_OPAQUE = 'gNormalOut = vec4(normalize(normal) * 0.5 + 0.5, 1.0);';
const MRT_NONE = 'gNormalOut = vec4(0.0);';

/** Add the second render-target output (view-space normal) to a built-in material shader. */
function injectMRT(shader: WebGLProgramParametersWithUniforms, opaque: boolean): void {
  shader.fragmentShader = MRT_DECL + shader.fragmentShader.replace('#include <dithering_fragment>', `#include <dithering_fragment>\n${opaque ? MRT_OPAQUE : MRT_NONE}`);
}

/**
 * Patch any built-in material so it writes the normal buffer used for
 * outlines. `extra` can further modify the shader.
 */
export function withMRT<T extends Material>(m: T, opaque: boolean, key: string, extra?: (s: WebGLProgramParametersWithUniforms) => void): T {
  m.onBeforeCompile = (shader) => {
    extra?.(shader);
    injectMRT(shader, opaque);
  };
  m.customProgramCacheKey = () => `mrt-${key}-${opaque ? 1 : 0}`;
  return m;
}

export interface CelOptions {
  color?: number;
  vertexColors?: boolean;
  map?: Texture | null;
  side?: typeof FrontSide | typeof DoubleSide;
  emissive?: number;
  key: string;
}

/** Generic cel-shaded material (toon ramp + MRT normals). */
export function celMaterial(o: CelOptions): MeshToonMaterial {
  const m = new MeshToonMaterial({
    color: o.color ?? 0xffffff,
    vertexColors: o.vertexColors ?? false,
    gradientMap: toonGradient(),
    map: o.map ?? null,
    side: o.side ?? FrontSide,
    emissive: o.emissive ?? 0x000000,
  });
  return withMRT(m, true, o.key);
}

const HASH = /* glsl */ `
float sk_hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`;

/**
 * Building facade material. Per-vertex attributes:
 *  aFac  (vec2): u = metres along the face, v = world height
 *  aWin  (vec4): window style (-1 = none), floor height, bay width, seed
 *  aWin2 (vec4): ground-floor base y, storefront height, lit ratio, unused
 *  aGlass (vec3): glass tint
 * Window glass reflects the sky by day; at night windows light up one by one
 * as `uNight` rises. Per-window variation fades out when a window shrinks
 * below a pixel, so distant facades do not shimmer.
 */
export function facadeMaterial(): MeshToonMaterial {
  const m = new MeshToonMaterial({ vertexColors: true, gradientMap: toonGradient() });
  return withMRT(m, true, 'facade', (shader) => {
    shader.uniforms.uNight = shared.uNight;
    shader.uniforms.uSkyRefl = shared.uSkyRefl;
    shader.uniforms.uWinAtlas = shared.uWinAtlas;
    shader.uniforms.uLamp = shared.uLamp;
    shader.uniforms.uSignAtlas = shared.uSignAtlas;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec2 aFac;
attribute vec4 aWin;
attribute vec4 aWin2;
attribute vec3 aGlass;
varying vec2 vFac;
varying vec4 vWin;
varying vec4 vWin2;
varying vec3 vGlass;`,
      )
      .replace('#include <color_vertex>', '#include <color_vertex>\nvFac = aFac; vWin = aWin; vWin2 = aWin2; vGlass = aGlass;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uNight;
uniform float uLamp;
uniform vec3 uSkyRefl;
uniform sampler2D uWinAtlas;
uniform sampler2D uSignAtlas;
varying vec2 vFac;
varying vec4 vWin;
varying vec4 vWin2;
varying vec3 vGlass;
${HASH}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
vec3 skWinEmit = vec3(0.0);
if (vWin.x < -2.5) {
  // Sign face: texture from the sign atlas (uv in aFac), neon glow at night.
  vec3 sc = texture2D(uSignAtlas, vFac).rgb;
  diffuseColor.rgb = sc;
  skWinEmit = sc * (0.12 + 0.9 * uLamp);
} else if (vWin.x < -1.5) {
  // Lamp bulb / signal: unlit vertex colour scaled by the lamp factor.
  skWinEmit = diffuseColor.rgb * mix(0.25, 1.6, uLamp);
  diffuseColor.rgb *= 0.3;
} else if (vWin.x > -0.5) {
  float floorH = vWin.y;
  float bayW = vWin.z;
  float yRel = vFac.y - vWin2.x;
  float sf = vWin2.y;
  float style = vWin.x;
  vec2 g;
  if (sf > 0.0 && yRel < sf) {
    style = 7.0;
    g = vec2(vFac.x / max(bayW * 1.7, 3.2), clamp(yRel / sf, 0.0, 0.999));
  } else {
    g = vec2(vFac.x / bayW, (yRel - sf) / floorH);
  }
  vec2 cell = floor(g);
  vec2 local = fract(g);
  vec2 auv = vec2((style + local.x) / 8.0, local.y);
  vec2 gdx = dFdx(g) * vec2(0.125, 1.0);
  vec2 gdy = dFdy(g) * vec2(0.125, 1.0);
  vec4 win = textureGrad(uWinAtlas, auv, gdx, gdy);
  float h1 = sk_hash12(cell + vWin.w * 97.0);
  float h2 = sk_hash12(cell.yx * 1.37 + vWin.w * 31.0);
  float h3 = sk_hash12(cell * 2.11 + vWin.w * 13.0);
  // Screen-space size of a window cell: fade per-window variation when tiny.
  float cellPx = max(length(dFdx(g)), length(dFdy(g)));
  float far = smoothstep(0.25, 0.75, cellPx);
  vec3 glassDay = mix(vGlass * 0.55, uSkyRefl, 0.32 + 0.3 * mix(h1, 0.5, far));
  // Some windows have blinds (lighter, flatter).
  glassDay = mix(glassDay, vec3(0.78, 0.74, 0.66), step(0.86, h2) * (1.0 - far) * 0.6);
  float glass = win.a;
  vec3 wallShade = diffuseColor.rgb * win.rgb;
  diffuseColor.rgb = mix(wallShade, glassDay, glass);
  // Night lights: each window has its own switch-on threshold.
  float lit = step(h2, vWin2.z) * step(h3 * 0.85 + 0.12, uNight);
  float litAvg = vWin2.z * smoothstep(0.1, 0.95, uNight);
  float litF = mix(lit, litAvg, far);
  vec3 warm = mix(vec3(1.0, 0.78, 0.42), vec3(0.62, 0.82, 1.0), step(0.78, h1));
  warm = mix(warm, vec3(1.0, 0.55, 0.85), step(0.97, h3));
  skWinEmit = warm * litF * glass * (0.9 + 0.5 * h1) * uNight;
  diffuseColor.rgb *= 1.0 - 0.75 * litF * glass * uNight;
}`,
      )
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += skWinEmit;');
  });
}

/**
 * Foliage/tree material for InstancedMesh: vertex colours, wind sway driven
 * by the vertex height (attribute aSway = sway weight).
 */
export function foliageMaterial(): MeshToonMaterial {
  const m = new MeshToonMaterial({ vertexColors: true, gradientMap: toonGradient() });
  return withMRT(m, true, 'foliage', (shader) => {
    shader.uniforms.uTime = shared.uTime;
    shader.uniforms.uWind = shared.uWind;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aSway;\nuniform float uTime;\nuniform float uWind;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
#ifdef USE_INSTANCING
  vec2 skBase = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
#else
  vec2 skBase = vec2(0.0);
#endif
  float skPh = skBase.x * 0.071 + skBase.y * 0.053;
  float skW = aSway * uWind;
  transformed.x += (sin(uTime * 1.3 + skPh) * 0.06 + sin(uTime * 2.9 + skPh * 1.7) * 0.025) * skW;
  transformed.z += (cos(uTime * 1.1 + skPh * 1.3) * 0.05) * skW;`,
      );
  });
}

/** Unlit emissive material (lamp bulbs, lit signs); colour updated by the day/night system. */
export function emissiveMaterial(color: number, key: string): MeshBasicMaterial {
  return withMRT(new MeshBasicMaterial({ color }), true, key, (shader) => {
    // MeshBasicMaterial has no lighting normal; derive one from the geometry derivative.
    shader.fragmentShader = shader.fragmentShader.replace(
      'void main() {',
      'varying vec3 vSkViewPos;\nvoid main() {\n  vec3 normal = normalize(cross(dFdx(vSkViewPos), dFdy(vSkViewPos)));',
    );
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSkViewPos;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvSkViewPos = mvPosition.xyz;');
  });
}

/** Additive glow (light pools, ring halos). Writes nothing to the normal buffer. */
export function glowMaterial(map: Texture | null, color: number, key: string): MeshBasicMaterial {
  const m = new MeshBasicMaterial({
    color,
    map,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  return withMRT(m, false, key);
}

/**
 * Signed-distance shore for maps with arbitrary coastlines (M13): a texture of
 * the distance to land over the water (red channel, metres / 16) covering
 * `extent` (minX, minZ, maxX, maxZ), plus a colour tint for the map's water.
 */
export interface ShoreSdf {
  texture: Texture;
  extent: Vector4;
  tint: Color;
}

/** Stylised cel water with ripple bands, a hard sun glint and shore foam (around rectangles, or along a shore SDF). */
export function waterMaterial(land: Vector4, islet: Vector4, shore?: ShoreSdf): ShaderMaterial {
  const uniforms = UniformsUtils.merge([
    UniformsLib.fog,
    {
      uTime: shared.uTime,
      uDeep: { value: new Color(0x1f5f8f) },
      uShallow: { value: new Color(0x3f9fbf) },
      uSky: { value: new Color(0x9fc7e6) },
      uSunDir: { value: new Vector3(0.3, 0.8, 0.2) },
      uSunColor: { value: new Color(0xfff2d0) },
      uNight: shared.uNight,
      uLand: { value: land },
      uIslet: { value: islet },
      uPondCenter: { value: new Vector4(0, 0, 0, 0) },
    },
  ]);
  // Keep shared uniform identity (merge clones them).
  uniforms.uTime = shared.uTime;
  uniforms.uNight = shared.uNight;
  if (shore) {
    uniforms.uShoreSdf = { value: shore.texture };
    uniforms.uShoreExtent = { value: shore.extent };
    uniforms.uWaterTint = { value: shore.tint };
  }
  return new ShaderMaterial({
    uniforms,
    defines: shore ? { SHORE_SDF: '' } : {},
    fog: true,
    vertexShader: /* glsl */ `
      #include <common>
      #include <fog_pars_vertex>
      varying vec3 vWorld;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      layout(location = 1) out highp vec4 gNormalOut;
      #include <common>
      #include <fog_pars_fragment>
      uniform float uTime;
      uniform float uNight;
      uniform vec3 uDeep;
      uniform vec3 uShallow;
      uniform vec3 uSky;
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform vec4 uLand;
      uniform vec4 uIslet;
      uniform vec4 uPondCenter;
      #ifdef SHORE_SDF
      uniform sampler2D uShoreSdf;
      uniform vec4 uShoreExtent;
      uniform vec3 uWaterTint;
      #endif
      varying vec3 vWorld;
      float rectDist(vec2 p, vec4 r) {
        vec2 d = max(r.xy - p, p - r.zw);
        return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
      }
      void main() {
        vec2 p = vWorld.xz;
        float t = uTime;
        float w1 = sin(p.x * 0.075 + t * 0.55 + sin(p.y * 0.043 + t * 0.2) * 2.2);
        float w2 = sin(p.y * 0.097 - t * 0.42 + sin(p.x * 0.061) * 1.8);
        float w3 = sin((p.x + p.y) * 0.21 + t * 1.3);
        float ripple = w1 * 0.45 + w2 * 0.4 + w3 * 0.15;
        vec3 V = normalize(cameraPosition - vWorld);
        float fres = pow(1.0 - clamp(V.y, 0.0, 1.0), 4.0);
        vec3 col = mix(uDeep, uShallow, 0.4 + 0.22 * ripple);
        col = mix(col, uSky, clamp(fres * 0.75, 0.0, 0.8));
        // Cel bands
        float band = smoothstep(0.55, 0.62, ripple * 0.5 + 0.5);
        col = mix(col, col * 1.22 + 0.03 * (1.0 - uNight), band * (0.6 - 0.25 * uNight));
        // Hard sun / moon glint
        vec3 N = normalize(vec3(w1 * 0.09 + w3 * 0.03, 1.0, w2 * 0.09));
        vec3 R = reflect(-V, N);
        float s = dot(R, normalize(uSunDir));
        col += step(0.992, s) * uSunColor * 1.2 * smoothstep(-0.05, 0.1, uSunDir.y + 0.1);
        // Shore foam around the island, islet and pond edge (or along the coast's distance field)
        #ifdef SHORE_SDF
        col *= uWaterTint;
        vec2 suv = (p - uShoreExtent.xy) / (uShoreExtent.zw - uShoreExtent.xy);
        float dLand = texture2D(uShoreSdf, clamp(suv, 0.0, 1.0)).r * 16.0;
        #else
        float dLand = min(rectDist(p, uLand), rectDist(p, uIslet));
        #endif
        float foam = 1.0 - smoothstep(0.0, 2.6 + 1.2 * sin(p.x * 0.31 + p.y * 0.27 + t * 1.7), dLand);
        if (uPondCenter.w > 0.0) {
          vec2 q = (p - uPondCenter.xy) / uPondCenter.zw;
          float dp = (1.0 - length(q)) * min(uPondCenter.z, uPondCenter.w);
          foam = max(foam, 1.0 - smoothstep(0.0, 1.6, dp));
        }
        col = mix(col, vec3(0.92, 0.96, 1.0) * (1.0 - 0.55 * uNight), clamp(foam, 0.0, 1.0) * 0.85);
        gl_FragColor = vec4(col, 1.0);
        #include <fog_fragment>
        vec3 vn = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
        gNormalOut = vec4(vn * 0.5 + 0.5, 1.0);
      }`,
  });
}

