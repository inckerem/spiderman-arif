import {
  DirectionalLight,
  Fog,
  HemisphereLight,
  NoToneMapping,
  PCFShadowMap,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import { QUALITY, type QualityPreset } from './config/quality';
import { PostFX } from './render/postfx';
import { shared, stableShadowSampling } from './render/materials';
import { buildCityVisuals, type CityVisuals } from './world/cityRender';
import { Sky } from './world/sky';
import { DayNight } from './world/dayNight';
import { clamp, damp, smoothstep } from './core/math';
import { tuning } from './config/tuning';
import { FixedLoop } from './core/loop';
import { Input, emptyTickInput, type TickInput } from './input/input';
import { CollisionWorld, F_CANOPY } from './physics/collision';
import { Player, MODE_NAMES, MODE_ZIP, type PlayerEvent } from './player/player';
import { CameraRig } from './camera/cameraRig';
import { generateCity } from './world/cityGen';
import { buildCollisionWorld } from './world/cityCollision';
import type { CityLayout } from './world/types';
import { DebugPanel } from './debug/debugPanel';
import { buildCharacter, setCostume, type CharacterRig } from './character/rig';
import type { CostumeId } from './character/costumes';
import { CharacterAnimator } from './character/animator';
import { WebLine, type WebLineState } from './character/webLine';
import { Particles } from './fx/particles';
import { Traffic } from './life/traffic';
import { Pedestrians } from './life/pedestrians';
import { RingRaces } from './extras/rings';
import { AttractMode } from './extras/attractMode';
import { Rain } from './fx/rain';
import { clearShot } from './camera/director';

export interface GameOptions {
  seed: number;
  canvas: HTMLCanvasElement;
  onProgress?: (fraction: number, label: string) => void;
}

/** Extra orbit heights tried, lowest first, when the rooftop-moment orbit is squeezed (m). */
const ORBIT_LIFTS = [0, 1.5, 3, 4.5] as const;

/** Composition root: owns the loop, simulation, camera and rendering. */
export class Game {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  layout!: CityLayout;
  world!: CollisionWorld;
  player!: Player;
  rig!: CameraRig;
  readonly input: Input;
  readonly loop: FixedLoop;
  readonly tickInput: TickInput = emptyTickInput();
  readonly prevPos = new Vector3();
  readonly renderPos = new Vector3();
  private readonly shadowFocus = new Vector3();
  readonly debug: DebugPanel;
  /** Simulation is advanced only while playing. */
  playing = false;
  ticks = 0;
  simTimeMs = 0;
  simTicksMeasured = 0;
  readonly eventLog: PlayerEvent[] = [];
  private hudEl: HTMLDivElement | null = null;
  /** Tests inject input through this hook instead of devices. */
  injectInput: ((out: TickInput) => void) | null = null;
  post!: PostFX;
  visuals!: CityVisuals;
  sky!: Sky;
  dayNight!: DayNight;
  sun!: DirectionalLight;
  hemi!: HemisphereLight;
  quality: QualityPreset = QUALITY[1]!;
  qualityIndex = 1;
  renderScale = 1;
  time = 0;
  timeFast = false;
  frameStats = { calls: 0, triangles: 0, frameMs: 0 };
  hero!: CharacterRig;
  animator!: CharacterAnimator;
  web!: WebLine;
  particles!: Particles;
  traffic!: Traffic;
  peds!: Pedestrians;
  rings!: RingRaces;
  private readonly chestPrev = new Vector3();
  private readonly chestNow = new Vector3();
  /** Hide the hero (photo mode toggle). */
  heroHidden = false;
  /** Animate the hero during manual (test) ticks. */
  animateManual = true;
  private readonly webState: WebLineState = { visible: false, progress: 0, from: new Vector3(), to: new Vector3(), slack: 0, tension: 0 };
  private readonly tmpV = new Vector3();
  private readonly tmpN = new Vector3();
  /** What drives the camera: gameplay rig, the menu's attract mode, or the photo-mode free camera. */
  view: 'play' | 'menu' | 'photo' = 'play';
  /** The hero swinging on autopilot behind the main menu. */
  attract!: AttractMode;
  /** Attract mode runs in the menu view; the test API turns it off in manual mode. */
  attractEnabled = true;
  rain!: Rain;
  /** Rooftop-moment look (0..1 each): rain, rainy mood grade and overcast, lightning flash. */
  readonly weather = { rain: 0, mood: 0, flash: 0 };
  /** Blend from the gameplay camera to a slow orbit around the hero (rooftop moment). */
  cineOrbit = 0;
  private orbitOn = false;
  private orbitA = 0;
  private orbitR = 6;
  /** Orbit direction (+1/-1), extra height over walls, and seconds spent cramped. */
  private orbitDir = 1;
  private orbitLift = 0;
  private orbitCrampT = 0;
  private readonly orbitProbe = new Vector3();
  private readonly orbitPos = new Vector3();
  private readonly orbitLook = new Vector3();
  private readonly chest = new Vector3();
  /** Photo-mode free camera. */
  readonly photoCam = { pos: new Vector3(), yaw: 0, pitch: 0, fov: 70 };
  /** Called once per rendered frame (real-time loop only) after the frame is drawn. */
  onFrame: ((dt: number) => void) | null = null;
  /** Called after an hour key (1-4) set the hour. */
  onHourKey: (() => void) | null = null;
  /** Called for every simulation event (audio, HUD). */
  onPlayerEvent: ((e: PlayerEvent) => void) | null = null;
  /** Fixed camera pose for screenshots (tests/photo checks). */
  cameraOverride: { x: number; y: number; z: number; tx: number; ty: number; tz: number; fov: number } | null = null;

  constructor(private readonly opts: GameOptions) {
    stableShadowSampling();
    this.renderer = new WebGLRenderer({ canvas: opts.canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.quality.pixelRatioCap));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.toneMapping = NoToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    this.renderer.info.autoReset = false;
    this.renderer.setClearColor(0x000000, 0);
    this.input = new Input(opts.canvas);
    this.loop = new FixedLoop(
      (dt) => this.tick(dt),
      (alpha, frameDt) => this.render(alpha, frameDt),
    );
    this.debug = new DebugPanel();
    this.input.onKey((code) => this.onKey(code));
    window.addEventListener('resize', () => this.resize());
  }

  async init(): Promise<void> {
    const p = this.opts.onProgress ?? (() => undefined);
    p(0.05, 'layout');
    await nextFrame();
    const t0 = performance.now();
    this.layout = generateCity(this.opts.seed);
    const t1 = performance.now();
    p(0.35, 'collision');
    await nextFrame();
    this.world = buildCollisionWorld(this.layout);
    const t2 = performance.now();
    console.info(
      `[skythread] city generated in ${(t1 - t0).toFixed(0)} ms, collision in ${(t2 - t1).toFixed(0)} ms: ` +
        `${this.layout.stats.buildings} buildings, ${this.layout.stats.parkTrees} park trees, ` +
        `${this.layout.stats.streetTrees} street trees, ${this.world.count} colliders, max height ${this.layout.stats.maxHeight.toFixed(0)} m`,
    );
    p(0.6, 'buildings');
    await nextFrame();
    this.player = new Player(this.world, this.layout);
    this.rig = new CameraRig(this.world, window.innerWidth / window.innerHeight);
    this.hero = buildCharacter();
    this.animator = new CharacterAnimator(this.hero, this.player);
    this.web = new WebLine();
    this.particles = new Particles();
    this.traffic = new Traffic(this.layout, QUALITY[3]!.trafficCars, this.opts.seed);
    this.peds = new Pedestrians(this.layout, QUALITY[3]!.pedestrians, this.opts.seed, (x, z) => this.world.terrain.height(x, z));
    this.rings = new RingRaces(this.layout, this.world);
    this.attract = new AttractMode(this.world, this.layout, this.hero, this.opts.seed);
    this.attract.onEvent = (e) => this.fxEvent(e, this.attract.player);
    this.rain = new Rain(this.opts.seed);
    this.visuals = await buildCityVisuals(this.layout, (f) => p(0.4 + f * 0.45, 'buildings'));
    await nextFrame();
    p(0.88, 'shaders');
    this.sky = new Sky(this.opts.seed);
    this.scene.add(this.sky.group);
    this.scene.add(this.visuals.group);
    this.scene.add(this.hero.mesh, this.web.group, this.particles.mesh, this.traffic.mesh, this.peds.mesh, this.rings.mesh, this.rain.mesh);
    this.scene.fog = new Fog(0xb4dbf6, 300, 2000);
    this.sun = new DirectionalLight(0xffffff, 2.4);
    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    this.sun.shadow.radius = 1;
    this.scene.add(this.sun, this.sun.target);
    this.hemi = new HemisphereLight(0xc4e0ff, 0x8a7a66, 0.85);
    this.scene.add(this.hemi);
    this.post = new PostFX(this.renderer);
    this.dayNight = new DayNight({
      sun: this.sun,
      hemi: this.hemi,
      fog: this.scene.fog as Fog,
      sky: this.sky,
      water: this.visuals.water,
      lampPools: this.visuals.lampPools,
      outline: (c, s) => this.post.setOutline(c, s),
      fogRange: (n, f) => this.post.setFog(n, f),
    });
    this.dayNight.hour = tuning.time.startHour;
    this.dayNight.dayLengthMinutes = tuning.time.dayLengthMinutes;
    this.applyQuality(1);
    this.dayNight.apply();
    // Compile every shader during loading so play never hitches on first use.
    this.renderer.compile(this.scene, this.rig.camera);
    this.spawn();
    this.applyLifeDensity();
    this.updateLife(0);
    p(1, 'done');
    this.makeDebugHud();
    this.resize();
    // The first frame draws a trace of rain so its buffers are uploaded during loading too.
    this.weather.rain = 0.01;
    this.renderFrame(0);
    this.weather.rain = 0;
  }

  spawn(): void {
    const s = this.layout.spawn;
    const out = new Vector3();
    if (!this.player.findSafeSpot(s[0], s[1] + 0.5, s[2], out)) out.set(s[0], s[1], s[2]);
    this.player.teleport(out.x, out.y, out.z);
    this.prevPos.copy(this.player.pos);
    this.rig.setLook(Math.PI * 0.75, -0.15);
    this.rig.snap();
  }

  start(): void {
    this.loop.start();
  }

  /** A new game from the main menu: the hero at the spawn point with a fresh gameplay camera. */
  startPlay(): void {
    this.spawn();
    this.animator.reset();
    this.animator.perch = 0;
    this.web.release();
    this.rings.abandon();
    this.cineOrbit = 0;
    this.view = 'play';
    // Pose the hero and the camera at the spawn right away (the frame holds still until the pointer lock).
    this.renderPos.copy(this.player.pos);
    this.updateCamera(1 / 60);
    this.updateHero(0);
  }

  /** Back to the main menu: the attract hero carries on behind it. */
  showMenu(): void {
    this.view = 'menu';
    this.attract.resume();
  }

  /** Whether the menu view runs the attract mode now (never in manual test mode). */
  get attractRunning(): boolean {
    return this.view === 'menu' && this.attractEnabled && !this.loop.manual;
  }

  private makeDebugHud(): void {
    const el = document.createElement('div');
    el.style.cssText =
      'position:fixed;left:8px;top:8px;color:#fff;font:12px/1.4 monospace;background:rgba(0,0,0,.45);padding:6px 8px;pointer-events:none;z-index:5;white-space:pre';
    document.body.appendChild(el);
    this.hudEl = el;
  }

  /** One fixed simulation tick (real-time loop). */
  tick(dt: number): void {
    if (this.playing) this.simulate(dt);
    else if (this.attractRunning) this.attract.tick(dt);
  }

  /** One tick driven by tests: injected input, camera updated per tick. */
  manualTick(): void {
    const dt = this.loop.dt;
    this.simulate(dt);
    this.renderPos.copy(this.player.pos);
    this.updateCamera(dt);
    if (this.animateManual) this.updateHero(dt);
  }

  snapCamera(): void {
    this.rig.snap();
    this.renderPos.copy(this.player.pos);
    this.updateCamera(this.loop.dt);
  }

  updateCameraForTest(): void {
    this.renderPos.copy(this.player.pos);
    this.updateCamera(this.loop.dt);
  }

  renderOnce(): void {
    this.renderFrame(0);
  }

  private simulate(dt: number): void {
    this.prevPos.copy(this.player.pos);
    this.input.sample(this.tickInput, this.rig.yaw, this.rig.pitch);
    if (this.injectInput) this.injectInput(this.tickInput);
    if (this.cineOrbit > 0) {
      // The rooftop moment's orbit (and its blend back) is not the view the
      // lines aim with: the press that ends the moment fires nothing, and a
      // button still held afterwards waits for a new press.
      const ti = this.tickInput;
      ti.swing = ti.swingPressed = ti.zip = ti.zipPressed = false;
    }
    this.fillAim(this.tickInput);
    const t0 = performance.now();
    this.player.step(dt, this.tickInput);
    this.simTimeMs += performance.now() - t0;
    this.chestPrev.copy(this.prevPos).y += 1.1;
    this.chestNow.copy(this.player.pos).y += 1.1;
    if (!this.player.events.some((e) => e.type === 'respawn' || e.type === 'recover')) this.rings.check(this.chestPrev, this.chestNow, dt);
    this.simTicksMeasured++;
    this.ticks++;
    for (const e of this.player.events) {
      this.eventLog.push(e);
      if (e.type === 'land' && e.impact > tuning.ground.hardLandingSpeed) this.rig.shake(e.impact);
      if (e.type === 'respawn' || e.type === 'recover') this.prevPos.copy(this.player.pos);
      this.animator.onEvent(e);
      this.fxEvent(e, this.player);
      this.onPlayerEvent?.(e);
    }
    if (this.eventLog.length > 200) this.eventLog.splice(0, this.eventLog.length - 200);
  }

  /** Visual effects triggered by simulation events (of the game's player or the attract hero). */
  private fxEvent(e: PlayerEvent, pl: Player): void {
    const night = this.dayNight.night;
    switch (e.type) {
      case 'attach':
        this.web.attach(this.tmpV.set(e.x, e.y, e.z), this.tmpN.set(e.nx, e.ny, e.nz));
        break;
      case 'zipStart': {
        const t = pl.zipTarget;
        if (t.valid) this.tmpN.set(t.nx, t.ny, t.nz);
        else this.tmpN.set(pl.zip.nx, 0, pl.zip.nz);
        this.web.attach(this.tmpV.set(e.x, e.y, e.z), this.tmpN);
        break;
      }
      case 'release':
        this.web.release();
        if (e.good) this.particles.releaseBurst(this.tmpV.copy(pl.pos).setY(pl.pos.y + 1.1), pl.vel);
        break;
      case 'land':
        if (e.roll || e.impact > tuning.ground.hardLandingSpeed * 0.6) {
          this.particles.dust(this.tmpV.copy(pl.pos).setY(pl.pos.y + 0.1), clamp(e.impact / 40, 0.3, 1), night);
        }
        break;
      case 'wallGrab':
        this.tmpN.set(pl.wall.nx, 0, pl.wall.nz);
        this.particles.wallDust(this.tmpV.copy(pl.pos).setY(pl.pos.y + 1).addScaledVector(this.tmpN, -0.35), this.tmpN);
        break;
      case 'splash':
        this.particles.splash(this.tmpV.set(e.x, tuning.world.waterLevel, e.z));
        break;
      default:
        break;
    }
  }

  /**
   * Hero animation, web line and particles for the current render position.
   * The menu's attract mode passes its own player, animator and position.
   */
  updateHero(dt: number, pl: Player = this.player, anim: CharacterAnimator = this.animator, at: Vector3 = this.renderPos, yaw = this.rig.yaw): void {
    anim.update(dt, at, yaw);
    const cam = this.rig.camera.position;
    // Never render the hero when the camera is pressed against it.
    const d = cam.distanceTo(this.tmpV.set(at.x, at.y + 1.1, at.z));
    this.hero.mesh.visible = !this.heroHidden && d > 0.75;
    const st = this.webState;
    const rope = pl.rope;
    if (rope.attached || rope.firing) {
      const a = rope.anchor;
      st.visible = true;
      st.progress = rope.attached ? 1 : clamp(rope.fireT / Math.max(1e-3, rope.fireDur), 0, 1);
      st.from.copy(anim.handPos[rope.hand]!);
      st.to.set(a.x, a.y, a.z);
      const pivot = this.tmpV.set(at.x, at.y + tuning.body.ropeOffset, at.z);
      st.slack = rope.attached ? rope.length - pivot.distanceTo(st.to) : 0;
      st.tension = rope.attached ? rope.tension : 0;
    } else if (pl.mode === MODE_ZIP) {
      st.visible = true;
      st.progress = clamp(pl.zip.time / 0.07, 0, 1);
      st.from.copy(anim.handPos[pl.zip.hand]!);
      st.to.set(pl.zip.tx, pl.zip.ty, pl.zip.tz);
      st.slack = 0;
      st.tension = 1;
    } else st.visible = false;
    this.web.update(dt, cam, st, this.dayNight.night);
    this.particles.update(dt);
  }

  fillAim(inp: TickInput): void {
    inp.yaw = this.rig.yaw;
    inp.pitch = this.rig.pitch;
    inp.aimOrigin.copy(this.rig.position);
    inp.aimDir.copy(this.rig.fwd);
  }

  render(alpha: number, frameDt: number): void {
    if (!this.player) return;
    if (this.loop.manual) {
      this.renderFrame(0);
      return;
    }
    const m = this.input.consumeMouse();
    let dt = frameDt;
    if (this.view === 'menu') {
      // Attract mode: the autopilot hero, filmed by the cinematic director.
      const at = this.attract;
      at.frame(alpha, frameDt, this.rig.camera);
      this.updateHero(frameDt, at.player, at.animator, at.renderPos, at.rig.yaw);
      this.updateLife(frameDt);
      if (!this.dayNight.paused) this.dayNight.advance(frameDt, 1);
    } else if (this.view === 'photo') {
      this.updatePhotoCamera(frameDt, m.dx, m.dy);
      // Photo mode freezes time: no animation, particles or water motion.
      dt = 0;
    } else if (this.playing) {
      this.rig.applyMouse(m.dx, m.dy);
      this.renderPos.lerpVectors(this.prevPos, this.player.pos, alpha);
      // Blend out recovery offsets smoothly.
      const off = this.player.renderOffset;
      if (off.lengthSq() > 1e-8) {
        this.renderPos.add(off);
        off.multiplyScalar(Math.exp(-frameDt / Math.max(0.01, tuning.recovery.blendTime / 3)));
      }
      this.updateCamera(frameDt);
      this.updateHero(frameDt);
      this.updateLife(frameDt);
      this.timeFast = this.input.enabled && this.input.isHeld('timeFast');
      if (!this.dayNight.paused) this.dayNight.advance(frameDt, this.timeFast ? tuning.time.fastForwardRate : 1);
    } else {
      // Paused under a menu: the frame holds still.
      dt = 0;
    }
    this.renderFrame(dt);
    this.post.updateDynamic(this.loop.lastWorkMs, this.loop.lastFrameMs);
    if (this.hudEl) {
      this.hudEl.style.display = this.debug.visible ? '' : 'none';
      if (this.debug.visible) {
        const pl = this.player;
        this.hudEl.textContent =
          `mode ${MODE_NAMES[pl.mode]}  speed ${pl.speed.toFixed(1)} m/s  alt ${pl.pos.y.toFixed(1)} m  ${this.dayNight.hour.toFixed(2)} h\n` +
          `anchor ${pl.swingTarget.valid ? (pl.swingTarget.assisted ? 'assist' : 'aim') : '-'}  zip ${pl.zipTarget.valid ? 'ok' : '-'}  ` +
          `calls ${this.frameStats.calls}  tris ${this.frameStats.triangles}  scale ${this.post.dynScale.toFixed(2)}`;
      }
    }
    this.onFrame?.(frameDt);
  }

  /** Enter photo mode: the free camera starts at the current view. */
  beginPhoto(): void {
    const cam = this.rig.camera;
    const pc = this.photoCam;
    pc.pos.copy(cam.position);
    // Where the lens looks (the gameplay view, or the rooftop-moment orbit).
    const dir = cam.getWorldDirection(this.tmpN);
    pc.yaw = Math.atan2(-dir.x, -dir.z);
    pc.pitch = Math.asin(clamp(dir.y, -1, 1));
    pc.fov = cam.fov;
    this.view = 'photo';
  }

  /** WASD + mouse free camera (Space/C up and down, Shift fast), kept out of solid geometry. */
  private updatePhotoCamera(dt: number, mdx: number, mdy: number): void {
    const pc = this.photoCam;
    const sens = tuning.camera.baseSensitivity * this.rig.sensitivity;
    pc.yaw -= mdx * sens;
    pc.pitch = Math.max(-1.5, Math.min(1.5, pc.pitch - mdy * sens * (this.rig.invertY ? -1 : 1)));
    const k = this.input;
    const fx = -Math.sin(pc.yaw) * Math.cos(pc.pitch),
      fy = Math.sin(pc.pitch),
      fz = -Math.cos(pc.yaw) * Math.cos(pc.pitch);
    const rx = Math.cos(pc.yaw),
      rz = -Math.sin(pc.yaw);
    // The free camera flies with the movement bindings: jump/dive for up/down, sprint for speed.
    // Keys typed into a focused panel slider adjust the slider, not the camera.
    const keys = !(document.activeElement instanceof HTMLInputElement);
    const f = keys ? (k.isHeld('forward') ? 1 : 0) - (k.isHeld('back') ? 1 : 0) : 0;
    const r = keys ? (k.isHeld('right') ? 1 : 0) - (k.isHeld('left') ? 1 : 0) : 0;
    const u = keys ? (k.isHeld('jump') ? 1 : 0) - (k.isHeld('dive') ? 1 : 0) : 0;
    const speed = (k.isHeld('sprint') ? 40 : 10) * Math.min(dt, 0.1);
    pc.pos.x += (fx * f + rx * r) * speed;
    pc.pos.y += (fy * f + u) * speed;
    pc.pos.z += (fz * f + rz * r) * speed;
    this.world.resolveSphere(pc.pos, 0.35, F_CANOPY, 4);
    const P = this.layout.bounds;
    pc.pos.x = Math.max(P.minX - 400, Math.min(P.maxX + 400, pc.pos.x));
    pc.pos.z = Math.max(P.minZ - 400, Math.min(P.maxZ + 400, pc.pos.z));
    pc.pos.y = Math.max(tuning.world.waterLevel + 0.5, Math.min(900, pc.pos.y));
    const cam = this.rig.camera;
    cam.position.copy(pc.pos);
    cam.fov = pc.fov;
    cam.lookAt(pc.pos.x + fx, pc.pos.y + fy, pc.pos.z + fz);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }

  /** Render the current view and save it as a PNG download. */
  savePhoto(): void {
    this.renderFrame(0);
    const canvas = this.renderer.domElement;
    const d = new Date();
    const pad = (n: number): string => String(n).padStart(2, '0');
    const name = `skythread-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.png`;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 4000);
    }, 'image/png');
  }

  /** Render one frame through the post pipeline and record renderer stats. */
  renderFrame(dt: number): void {
    this.time += dt;
    shared.uTime.value = this.time;
    const wx = this.weather;
    this.dayNight.storm = wx.mood;
    this.dayNight.flash = wx.flash;
    this.dayNight.apply();
    this.post.mood = wx.mood;
    this.post.flash = wx.flash;
    // Hero rim and fill: some at night, full in the rooftop moment's rain.
    shared.uHeroLight.value = Math.max(this.dayNight.night * 0.55, wx.mood);
    const cam0 = this.rig.camera;
    this.rain.update(dt, wx.rain, cam0.position, (2 * Math.tan((cam0.fov * Math.PI) / 360)) / Math.max(1, this.post.internalHeight), this.dayNight.night);
    this.sky.follow(this.rig.camera.position.x, this.rig.camera.position.z);
    this.visuals.updateLod(this.rig.camera.position.x, this.rig.camera.position.z);
    this.sky.uniforms.uTime.value = this.time;
    this.sky.updateClouds(dt);
    if (this.quality.shadows) {
      // Shadows follow the player; with a fixed camera pose they follow the view.
      const o = this.cameraOverride;
      const cam = this.rig.camera;
      if (o) {
        this.shadowFocus.set(o.tx - o.x, o.ty - o.y, o.tz - o.z).normalize().multiplyScalar(this.quality.shadowExtent * 0.8).add(cam.position);
        this.shadowFocus.y = Math.min(this.shadowFocus.y, o.ty);
      } else if (this.view === 'menu') {
        // Attract mode: shadows follow the hero.
        this.shadowFocus.copy(this.attract.renderPos);
      } else if (this.view !== 'play') {
        // Free camera: shadows cover the area in front of the lens.
        cam.getWorldDirection(this.shadowFocus).multiplyScalar(this.quality.shadowExtent * 0.7).add(cam.position);
      } else this.shadowFocus.copy(this.renderPos);
      this.dayNight.placeShadow(this.sun, this.shadowFocus, this.quality.shadowExtent, this.quality.shadowMap);
    }
    const sp = this.player.speed;
    this.post.speedLines = this.view === 'play' ? smoothstep(32, 60, sp) * (this.player.mode === 0 ? 0 : 1) : 0;
    this.renderer.info.reset();
    this.post.render(this.scene, this.rig.camera, this.time);
    this.frameStats.calls = this.renderer.info.render.calls;
    this.frameStats.triangles = this.renderer.info.render.triangles;
  }

  /** Dress the hero in another costume (a vertex colour write, no rebuild). */
  setCostume(id: CostumeId): void {
    if (this.hero.costume !== id) setCostume(this.hero, id);
  }

  applyQuality(index: number): void {
    this.qualityIndex = Math.max(0, Math.min(3, Math.round(index)));
    const q = QUALITY[this.qualityIndex]!;
    this.quality = q;
    this.sun.castShadow = q.shadows;
    this.renderer.shadowMap.enabled = q.shadows;
    if (this.sun.shadow.mapSize.x !== q.shadowMap) {
      this.sun.shadow.mapSize.set(q.shadowMap, q.shadowMap);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    this.rig.camera.far = q.viewFar;
    this.rig.camera.updateProjectionMatrix();
    this.post.settings.fxaa = q.fxaa;
    this.post.settings.maxDynScale = q.maxDynScale;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.pixelRatioCap));
    this.rain.setDensity(q.rainStreaks);
    this.resize();
    this.applyLifeDensity();
  }

  /** Traffic and crowd density follow the quality preset; new ones appear around the player. */
  applyLifeDensity(): void {
    if (!this.traffic) return;
    const p = this.player ? this.player.pos : this.tmpV.set(0, 0, 0);
    this.traffic.setCount(this.quality.trafficCars, p.x, p.z);
    this.peds.setCount(this.quality.pedestrians, p.x, p.z);
  }

  /** Advance cars, pedestrians and ring visuals (real-time frames; tests call it explicitly). */
  updateLife(dt: number): void {
    const c = this.view === 'play' ? this.renderPos : this.rig.camera.position;
    this.rig.camera.getWorldDirection(this.tmpN);
    const l = Math.hypot(this.tmpN.x, this.tmpN.z) || 1;
    this.traffic.update(dt, c.x, c.z, this.tmpN.x / l, this.tmpN.z / l);
    this.peds.update(dt, c.x, c.z, this.tmpN.x / l, this.tmpN.z / l);
    this.rings.refresh();
  }

  private onKey(code: string): void {
    if (code === 'Backquote') this.debug.toggle();
    if (!this.playing) return;
    if (code === 'Digit1') this.dayNight.setHour(6.4);
    if (code === 'Digit2') this.dayNight.setHour(12);
    if (code === 'Digit3') this.dayNight.setHour(18.6);
    if (code === 'Digit4') this.dayNight.setHour(23);
    if (code === 'Digit1' || code === 'Digit2' || code === 'Digit3' || code === 'Digit4') this.onHourKey?.();
  }

  updateCamera(dt: number): void {
    this.rig.update(dt, { pos: this.renderPos, vel: this.player.vel, mode: this.player.mode });
    if (this.cineOrbit > 0.001) this.orbitCamera(dt);
    else this.orbitOn = false;
    const o = this.cameraOverride;
    if (o) {
      const cam = this.rig.camera;
      cam.position.set(o.x, o.y, o.z);
      cam.fov = o.fov;
      cam.lookAt(o.tx, o.ty, o.tz);
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld();
    }
  }

  /**
   * Clear distance of an orbit pose (angle, extra height) from the chest, as
   * a share of its wanted distance (1 = nothing in the way).
   */
  private orbitClear(c: Vector3, a: number, lift: number): number {
    const M = tuning.moment;
    const p = this.orbitProbe.set(c.x + Math.cos(a) * this.orbitR, c.y + M.orbitHeight + lift, c.z + Math.sin(a) * this.orbitR);
    const want = p.distanceTo(c);
    clearShot(this.world, c, p);
    return p.distanceTo(c) / Math.max(1e-3, want);
  }

  /**
   * Rooftop moment: blend the gameplay camera into a slow orbit around the
   * hero, starting from where the camera is. Both the orbit and the blended
   * pose are kept out of geometry (sphere cast from the hero, sphere resolve).
   * Anti-cramp (setback terraces beside towers): the orbit turns back before
   * a wall ahead on the arc, rises over walls when squeezed, and after 0.6 s
   * still squeezed jumps (a cut) to the clearest side of the hero.
   */
  private orbitCamera(dt: number): void {
    const M = tuning.moment;
    const cam = this.rig.camera;
    const c = this.chest.set(this.renderPos.x, this.renderPos.y + 1.2, this.renderPos.z);
    if (!this.orbitOn) {
      this.orbitOn = true;
      this.orbitA = Math.atan2(cam.position.z - c.z, cam.position.x - c.x);
      this.orbitR = Math.max(2.5, Math.hypot(cam.position.x - c.x, cam.position.z - c.z));
      this.orbitDir = 1;
      this.orbitLift = 0;
      this.orbitCrampT = 0;
    }
    // Turn back before a wall ahead on the arc, when the way back is clearer.
    const ahead = this.orbitClear(c, this.orbitA + this.orbitDir * 0.35, this.orbitLift);
    if (ahead < 0.6 && this.orbitClear(c, this.orbitA - this.orbitDir * 0.35, this.orbitLift) > ahead + 0.15) this.orbitDir = -this.orbitDir;
    this.orbitA += this.orbitDir * M.orbitSpeed * dt;
    this.orbitR = damp(this.orbitR, M.orbitRadius, 0.6, dt);
    // Rise over walls when squeezed (the lowest clear lift), settle back down when free.
    let lift = 0;
    for (const l of ORBIT_LIFTS) {
      lift = l;
      if (this.orbitClear(c, this.orbitA, l) >= 0.8) break;
    }
    this.orbitLift = damp(this.orbitLift, lift, 1.2, dt);
    // Still squeezed: cut to the clearest side.
    this.orbitCrampT = this.orbitClear(c, this.orbitA, this.orbitLift) < 0.45 ? this.orbitCrampT + dt : 0;
    if (this.orbitCrampT > 0.6) {
      this.orbitCrampT = 0;
      let best = this.orbitA,
        bestK = -1;
      for (let k = 1; k < 12; k++) {
        const a = this.orbitA + (k * Math.PI) / 6;
        const v = this.orbitClear(c, a, this.orbitLift);
        if (v > bestK) {
          bestK = v;
          best = a;
        }
      }
      this.orbitA = best;
    }
    const w = smoothstep(0, 1, this.cineOrbit);
    const op = this.orbitPos.set(c.x + Math.cos(this.orbitA) * this.orbitR, c.y + M.orbitHeight + this.orbitLift, c.z + Math.sin(this.orbitA) * this.orbitR);
    clearShot(this.world, c, op);
    // Gameplay look point, then the blend toward the orbit.
    this.orbitLook.copy(cam.position).addScaledVector(this.rig.fwd, 10).lerp(c, w);
    cam.position.lerp(op, w);
    clearShot(this.world, c, cam.position);
    cam.fov += (52 - cam.fov) * w;
    cam.up.set(0, 1, 0);
    cam.lookAt(this.orbitLook);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }

  resize(): void {
    const w = window.innerWidth,
      h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    if (this.rig) {
      this.rig.camera.aspect = w / h;
      this.rig.camera.updateProjectionMatrix();
    }
    if (this.post) {
      const pr = this.renderer.getPixelRatio();
      this.post.settings.renderScale = this.renderScale;
      this.post.setSize(Math.round(w * pr), Math.round(h * pr), pr);
    }
  }
}

function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}
