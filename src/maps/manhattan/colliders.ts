import { CollisionWorld, F_ANCHOR, F_BRIDGE, F_BUILDING, F_CAMERA, F_CLIMB, SURF_CONCRETE, SURF_METAL, SURF_STONE } from '../../physics/collision';
import type { CityLayout } from '../../world/types';

/** Lighthouse on the islet (collision and rendering). */
export const LIGHTHOUSE = { x: 1062, z: 2, r: 3.6, h: 31 };

/** The suspension bridge to the islet and the lighthouse. */
export function addManhattanColliders(w: CollisionWorld, layout: CityLayout): void {
  const br = layout.bridge;
  const BR = F_BRIDGE | F_ANCHOR | F_CAMERA;
  w.addBox(br.deck.minX, br.deck.minY, br.deck.minZ, br.deck.maxX, br.deck.maxY, br.deck.maxZ, BR, SURF_CONCRETE);
  // Deck side rails (walkable deck with edges).
  w.addBox(br.deck.minX, br.deck.maxY, br.deck.minZ, br.deck.maxX, br.deck.maxY + 1.1, br.deck.minZ + 0.3, F_BRIDGE | F_ANCHOR, SURF_METAL);
  w.addBox(br.deck.minX, br.deck.maxY, br.deck.maxZ - 0.3, br.deck.maxX, br.deck.maxY + 1.1, br.deck.maxZ, F_BRIDGE | F_ANCHOR, SURF_METAL);
  for (const t of br.towers) w.addBox(t.minX, t.minY, t.minZ, t.maxX, t.maxY, t.maxZ, BR | F_CLIMB, SURF_STONE);
  for (const t of br.beams) w.addBox(t.minX, t.minY, t.minZ, t.maxX, t.maxY, t.maxZ, BR | F_CLIMB, SURF_STONE);
  for (const t of br.anchorages) w.addBox(t.minX, t.minY, t.minZ, t.maxX, t.maxY, t.maxZ, BR | F_CLIMB, SURF_STONE);
  for (const s of br.suspenders) w.addCylinder(s[0], s[1], s[2], s[3], 0.22, F_BRIDGE | F_ANCHOR, SURF_METAL);
  // Lighthouse on the islet.
  const L = LIGHTHOUSE;
  w.addCylinder(L.x, L.z, 0.15, L.h, L.r, F_BUILDING | F_ANCHOR | F_CAMERA, SURF_STONE);
  w.addCylinder(L.x, L.z, L.h, L.h + 4.5, L.r * 0.7, F_BUILDING | F_ANCHOR | F_CAMERA, SURF_METAL);
}
