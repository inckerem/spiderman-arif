import type { CityLayout } from '../world/types';
import { getMapVisuals } from '../maps/renderRegistry';
import { COL, TAU, type Extent } from './minimapPaint';
import type { MinimapRing } from './ui';
import { clamp, el } from './dom';

/** World radius shown around the player (m). */
const VIEW_RADIUS_M = 350;
/** CSS border width of the minimap ring (must match styles.css). */
const BORDER_PX = 4;
/** Base map resolution relative to the on-screen device-pixel scale (sharper when rotated). */
const SUPERSAMPLE = 1.6;
const MAX_BASE_PX = 4096;
/** Half-angle of the view cone drawn ahead of the player arrow. */
const CONE_HALF = (42 * Math.PI) / 180;

/** Ring marker colour per route index (park, towers, waterfront). */
const ROUTE_COLORS = ['#7ddc8f', '#f4efe6', '#5ec8ea'];

/**
 * Rotating circular minimap. The static city is painted once into an
 * offscreen canvas; each frame draws it rotated so camera-forward is up,
 * then overlays the view cone, ring markers, the player arrow and a north
 * marker on the rim.
 */
export class Minimap {
  readonly el: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private base: HTMLCanvasElement | null = null;
  private baseExt: Extent = { minX: 0, minZ: 0, maxX: 0, maxZ: 0 };
  private basePxPerM = 0;
  private layout: CityLayout | null = null;
  private cssSize = 0;
  private dpr = 1;
  private headFont = 'sans-serif';
  private visible = false;
  private px = 0;
  private pz = 0;
  private yaw = 0;
  private rings: readonly MinimapRing[] = [];
  private coneFill: CanvasGradient | null = null;

  constructor(
    private readonly northLabel: string,
    ariaLabel: string,
  ) {
    this.el = el('div', 'sk-minimap');
    this.el.setAttribute('role', 'img');
    this.el.setAttribute('aria-label', ariaLabel);
    this.canvas = el('canvas', 'sk-minimap-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.el.append(this.canvas, el('div', 'sk-minimap-overlay'));
  }

  /** Sets the outer CSS size (px) and device pixel ratio; re-renders the base when the scale changed. */
  resize(outerCss: number, dpr: number, headFont: string): void {
    const inner = Math.max(40, Math.round(outerCss) - BORDER_PX * 2);
    this.el.style.width = `${Math.round(outerCss)}px`;
    this.el.style.height = `${Math.round(outerCss)}px`;
    this.headFont = headFont || 'sans-serif';
    if (inner === this.cssSize && dpr === this.dpr) return;
    this.cssSize = inner;
    this.dpr = dpr;
    this.canvas.style.width = `${inner}px`;
    this.canvas.style.height = `${inner}px`;
    this.canvas.width = Math.round(inner * dpr);
    this.canvas.height = Math.round(inner * dpr);
    this.coneFill = null;
    if (this.layout) {
      const want = this.wantPxPerM();
      if (!this.base || Math.abs(want / this.basePxPerM - 1) > 0.2) this.renderBase();
    }
    this.draw();
  }

  setLayout(layout: CityLayout): void {
    this.layout = layout;
    this.renderBase();
    this.draw();
  }

  setVisible(v: boolean): void {
    if (v === this.visible) return;
    this.visible = v;
    if (v) this.draw();
  }

  update(x: number, z: number, yaw: number, rings: readonly MinimapRing[]): void {
    if (Number.isFinite(x)) this.px = x;
    if (Number.isFinite(z)) this.pz = z;
    if (Number.isFinite(yaw)) this.yaw = yaw;
    this.rings = rings;
    this.draw();
  }

  /** Base map pixels per metre for the current on-screen scale. */
  private wantPxPerM(): number {
    const cssPerM = this.cssSize / 2 / VIEW_RADIUS_M;
    return clamp(cssPerM * this.dpr * SUPERSAMPLE, 0.25, 2);
  }

  private renderBase(): void {
    const L = this.layout;
    if (!L) return;
    const mm = getMapVisuals(L.mapId).minimap;
    const e = mm.extent(L);
    const w = e.maxX - e.minX;
    const h = e.maxZ - e.minZ;
    const ppm = Math.min(this.wantPxPerM(), MAX_BASE_PX / w, MAX_BASE_PX / h);
    const c = document.createElement('canvas');
    c.width = Math.ceil(w * ppm);
    c.height = Math.ceil(h * ppm);
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(ppm, 0, 0, ppm, -e.minX * ppm, -e.minZ * ppm);
    mm.paint(g, L, e, 1 / ppm);
    this.base = c;
    this.baseExt = e;
    this.basePxPerM = ppm;
  }

  private draw(): void {
    const g = this.ctx;
    if (!g || !this.visible || this.cssSize <= 0) return;
    const S = this.cssSize;
    const R = S / 2;
    const k = R / VIEW_RADIUS_M;
    const u = S / 200;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = COL.water;
    g.fillRect(0, 0, S, S);

    const cos = Math.cos(this.yaw);
    const sin = Math.sin(this.yaw);
    if (this.base) {
      // Screen = R + Rot(yaw) * k * (world - player): forward (-sin yaw, -cos yaw) maps to up.
      g.save();
      g.translate(R, R);
      g.rotate(this.yaw);
      g.scale(k, k);
      g.translate(-this.px, -this.pz);
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      const e = this.baseExt;
      g.drawImage(this.base, e.minX, e.minZ, e.maxX - e.minX, e.maxZ - e.minZ);
      g.restore();
    }

    // Half-range ring.
    g.strokeStyle = 'rgba(244,239,230,0.2)';
    g.lineWidth = 1;
    g.setLineDash([3 * u, 5 * u]);
    g.beginPath();
    g.arc(R, R, R * 0.5, 0, TAU);
    g.stroke();
    g.setLineDash([]);

    // View cone ahead (camera-forward is always up).
    if (!this.coneFill) {
      const grad = g.createRadialGradient(R, R, 0, R, R, R * 0.92);
      grad.addColorStop(0, 'rgba(255,176,32,0.34)');
      grad.addColorStop(1, 'rgba(255,176,32,0)');
      this.coneFill = grad;
    }
    g.fillStyle = this.coneFill;
    g.beginPath();
    g.moveTo(R, R);
    g.arc(R, R, R * 0.92, -Math.PI / 2 - CONE_HALF, -Math.PI / 2 + CONE_HALF);
    g.closePath();
    g.fill();

    // North marker first so ring markers near the rim stay on top of it.
    this.drawNorth(g, R, cos, sin, u);
    this.drawRings(g, R, k, cos, sin, u);
    this.drawPlayer(g, R, u);
  }

  private drawRings(g: CanvasRenderingContext2D, R: number, k: number, cos: number, sin: number, u: number): void {
    const rings = this.rings;
    if (rings.length === 0) return;
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 160);
    // Pass 0: done rings, pass 1: pending, pass 2: the next ring on top.
    for (let pass = 0; pass < 3; pass++) {
      for (const ring of rings) {
        const kind = ring.next ? 2 : ring.done ? 0 : 1;
        if (kind !== pass) continue;
        const dx = ring.x - this.px;
        const dz = ring.z - this.pz;
        const sx = (dx * cos - dz * sin) * k;
        const sy = (dx * sin + dz * cos) * k;
        const dist = Math.hypot(sx, sy);
        const inside = dist < R - 7 * u;
        if (!inside) {
          if (kind === 2 && dist > 1e-3) this.drawEdgePip(g, R, sx / dist, sy / dist, u, pulse);
          continue;
        }
        const x = R + sx;
        const y = R + sy;
        g.beginPath();
        if (kind === 0) {
          g.arc(x, y, 2.6 * u, 0, TAU);
          g.fillStyle = COL.done;
          g.fill();
        } else if (kind === 1) {
          g.arc(x, y, 3.8 * u, 0, TAU);
          g.lineWidth = 3.6 * u;
          g.strokeStyle = COL.ink;
          g.stroke();
          g.lineWidth = 1.8 * u;
          g.strokeStyle = ROUTE_COLORS[ring.route % ROUTE_COLORS.length] ?? COL.paper;
          g.stroke();
        } else {
          g.arc(x, y, (7 + pulse * 4) * u, 0, TAU);
          g.lineWidth = 2 * u;
          g.strokeStyle = `rgba(255,176,32,${(0.85 - pulse * 0.6).toFixed(3)})`;
          g.stroke();
          g.beginPath();
          g.arc(x, y, 5 * u, 0, TAU);
          g.fillStyle = COL.amber;
          g.fill();
          g.lineWidth = 2.2 * u;
          g.strokeStyle = COL.ink;
          g.stroke();
        }
      }
    }
  }

  /** Off-map next ring: an amber arrowhead on the rim pointing towards it. */
  private drawEdgePip(g: CanvasRenderingContext2D, R: number, ux: number, uy: number, u: number, pulse: number): void {
    const r = R - 9 * u;
    g.save();
    g.translate(R + ux * r, R + uy * r);
    g.rotate(Math.atan2(uy, ux));
    const s = (1 + pulse * 0.15) * u;
    g.beginPath();
    g.moveTo(6 * s, 0);
    g.lineTo(-4 * s, -5 * s);
    g.lineTo(-4 * s, 5 * s);
    g.closePath();
    g.lineJoin = 'round';
    g.lineWidth = 2.4 * u;
    g.strokeStyle = COL.ink;
    g.stroke();
    g.fillStyle = COL.amber;
    g.fill();
    g.restore();
  }

  private drawPlayer(g: CanvasRenderingContext2D, R: number, u: number): void {
    g.save();
    g.translate(R, R);
    g.scale(u, u);
    g.beginPath();
    g.moveTo(0, -10);
    g.lineTo(7.5, 8);
    g.lineTo(0, 4);
    g.lineTo(-7.5, 8);
    g.closePath();
    g.lineJoin = 'round';
    g.lineWidth = 3.4;
    g.strokeStyle = COL.ink;
    g.stroke();
    g.fillStyle = COL.amber;
    g.fill();
    g.restore();
  }

  private drawNorth(g: CanvasRenderingContext2D, R: number, cos: number, sin: number, u: number): void {
    // World north (-Z) on screen is (sin yaw, -cos yaw).
    const r = R - 11 * u;
    const x = R + sin * r;
    const y = R - cos * r;
    g.beginPath();
    g.arc(x, y, 8.5 * u, 0, TAU);
    g.fillStyle = COL.ink;
    g.fill();
    g.lineWidth = 2 * u;
    g.strokeStyle = COL.amber;
    g.stroke();
    g.fillStyle = COL.paper;
    g.font = `900 ${Math.round(11 * u)}px ${this.headFont}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(this.northLabel, x, y + 0.5 * u);
  }
}
