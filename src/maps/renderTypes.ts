import type { Mesh, ShaderMaterial } from 'three';
import type { GeomBuilder } from '../render/geomBuilder';
import type { ChunkBuilders } from '../world/render/buildingsGeo';
import type { CityLayout } from '../world/types';
import type { Extent } from '../ui/minimapPaint';

/** Render side of a map: everything the generic city renderer does not draw. */

/** Chunk builders for a world position (geometry merged per 240 m chunk). */
export type ChunkGetter = (x: number, z: number) => ChunkBuilders;

export interface WaterVisuals {
  meshes: Mesh[];
  /** Water materials (the day-night cycle updates their uniforms). */
  materials: ShaderMaterial[];
}

export interface MapVisuals {
  /** Landmark and bridge geometry, merged into the chunks. */
  buildExtras(L: CityLayout, getChunk: ChunkGetter): void;
  /** Static ground: `ground` drawn plain, `decals` with polygon offset. */
  ground(L: CityLayout): { ground: GeomBuilder; decals: GeomBuilder };
  water(L: CityLayout): WaterVisuals;
  /** Fogged silhouettes beyond the playable area. */
  backdrop(L: CityLayout): GeomBuilder;
  minimap: {
    extent(L: CityLayout): Extent;
    /** Paints the static map in world units; `px` is one base pixel in metres. */
    paint(g: CanvasRenderingContext2D, L: CityLayout, e: Extent, px: number): void;
  };
}
