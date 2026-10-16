/**
 * Combat layer of the minimap (M11): red dots for enemies inside the map and
 * a pulsing marker per active crime event, or an arrowhead on the rim
 * pointing at it when it is off the map. Called by `Minimap` through its
 * overlay hook with the map's transform (world → map: rotate by the camera
 * yaw, scale by `k` pixels per metre around the player).
 */

const TAU = Math.PI * 2;
const INK = '#0b0c0e';
/** Event colours by type (match combatHud.css). */
export const EVENT_COLORS: Readonly<Record<string, string>> = { robbery: '#ffb020', gang: '#ff5a4a', drones: '#4fd6ff', boss: '#c37bff' };
/** `ES.KO` (combat/types.ts), kept local so the minimap does not import the sim. */
const KO = 12;
/** `EF.ALERTED`. */
const ALERTED = 16;

export interface MinimapCombatSource {
  readonly crimes: ReadonlyArray<{ x: number; z: number; type: string }>;
  readonly enemies: ReadonlyArray<{ x: number; z: number; state: number; flags: number }>;
}

/** What the last paint drew (tests): event markers inside the map, rim arrows, enemy dots. */
export interface MinimapCombatStats {
  events: number;
  rim: number;
  enemies: number;
}

export function paintMinimapCombat(
  g: CanvasRenderingContext2D,
  src: MinimapCombatSource,
  R: number,
  k: number,
  cos: number,
  sin: number,
  u: number,
  px: number,
  pz: number,
  stats?: MinimapCombatStats,
): void {
  if (stats) stats.events = stats.rim = stats.enemies = 0;
  const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 180);
  // Enemies inside the map.
  const lim = R - 5 * u;
  for (const e of src.enemies) {
    if (e.state === KO) continue;
    const dx = e.x - px,
      dz = e.z - pz;
    const sx = (dx * cos - dz * sin) * k,
      sy = (dx * sin + dz * cos) * k;
    if (sx * sx + sy * sy > lim * lim) continue;
    const alert = (e.flags & ALERTED) !== 0;
    if (stats) stats.enemies++;
    g.beginPath();
    g.arc(R + sx, R + sy, (alert ? 3.1 : 2.4) * u, 0, TAU);
    g.fillStyle = alert ? '#ff3b30' : '#ff8a7a';
    g.fill();
    g.lineWidth = 1.3 * u;
    g.strokeStyle = INK;
    g.stroke();
  }
  // Crime events: a pulsing diamond, or an arrowhead on the rim.
  for (const ev of src.crimes) {
    const col = EVENT_COLORS[ev.type] ?? '#ffb020';
    const dx = ev.x - px,
      dz = ev.z - pz;
    const sx = (dx * cos - dz * sin) * k,
      sy = (dx * sin + dz * cos) * k;
    const d = Math.hypot(sx, sy);
    if (d < R - 9 * u) {
      const x = R + sx,
        y = R + sy;
      g.beginPath();
      g.arc(x, y, (8 + pulse * 5) * u, 0, TAU);
      g.lineWidth = 2 * u;
      g.strokeStyle = hexAlpha(col, 0.9 - pulse * 0.6);
      g.stroke();
      diamond(g, x, y, 6 * u, col, u);
      if (stats) stats.events++;
      continue;
    }
    if (d < 1e-3) continue;
    if (stats) stats.rim++;
    const ux = sx / d,
      uy = sy / d;
    const r = R - 9 * u;
    g.save();
    g.translate(R + ux * r, R + uy * r);
    g.rotate(Math.atan2(uy, ux));
    const s = (1.1 + pulse * 0.2) * u;
    g.beginPath();
    g.moveTo(7 * s, 0);
    g.lineTo(-4.5 * s, -6 * s);
    g.lineTo(-2 * s, 0);
    g.lineTo(-4.5 * s, 6 * s);
    g.closePath();
    g.lineJoin = 'round';
    g.lineWidth = 2.4 * u;
    g.strokeStyle = INK;
    g.stroke();
    g.fillStyle = col;
    g.fill();
    g.restore();
  }
}

function diamond(g: CanvasRenderingContext2D, x: number, y: number, r: number, col: string, u: number): void {
  g.beginPath();
  g.moveTo(x, y - r);
  g.lineTo(x + r, y);
  g.lineTo(x, y + r);
  g.lineTo(x - r, y);
  g.closePath();
  g.lineJoin = 'round';
  g.lineWidth = 2.6 * u;
  g.strokeStyle = INK;
  g.stroke();
  g.fillStyle = col;
  g.fill();
  // "!" glyph.
  g.fillStyle = INK;
  g.fillRect(x - 0.9 * u, y - r * 0.55, 1.8 * u, r * 0.62);
  g.fillRect(x - 0.9 * u, y + r * 0.22, 1.8 * u, 1.8 * u);
}

function hexAlpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
}
