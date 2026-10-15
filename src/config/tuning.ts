/**
 * Every gameplay constant lives here. Values are live-editable through the
 * debug panel (backtick). The simulation reads them every tick, so edits take
 * effect immediately. Units: metres, seconds, radians unless the name says deg.
 *
 * `tuningMeta` gives the debug panel a range and step for each entry; entries
 * without metadata (capsule size, tick rate) are fixed at start-up because the
 * collision world and loop are built around them.
 */
export const tuning = {
  sim: {
    tickRate: 120,
    maxSubstepMove: 0.15,
    maxTicksPerFrame: 12,
  },
  body: {
    radius: 0.38,
    height: 1.8,
    /** Rope attach point above the feet (raised hand). */
    ropeOffset: 2.0,
    /** Chest height used for line-of-sight checks. */
    chestHeight: 1.35,
  },
  ground: {
    runSpeed: 8.5,
    sprintSpeed: 16,
    accel: 75,
    sprintAccel: 48,
    decel: 60,
    /** Deceleration when landing faster than sprint speed (keeps flow). */
    overspeedDecel: 22,
    turnBlend: 14,
    jumpSpeed: 9.4,
    sprintJumpBonus: 1.2,
    coyoteTime: 0.12,
    jumpBuffer: 0.14,
    stepHeight: 0.45,
    snapDown: 0.5,
    vaultMinHeight: 0.42,
    vaultMaxHeight: 1.65,
    vaultMaxDepth: 1.8,
    vaultDuration: 0.36,
    mantleDuration: 0.42,
    hardLandingSpeed: 25,
    rollMinSpeed: 5,
    rollDuration: 0.55,
  },
  air: {
    gravity: 22,
    airAccel: 18,
    airControlSpeed: 9,
    /** Heading change per second when above air control speed. */
    airSteerRate: 1.2,
    airBrake: 6,
    drag: 0.0015,
    softCap: 60,
    capDrag: 0.045,
    maxFallSpeed: 90,
  },
  swing: {
    minRope: 12,
    maxRope: 70,
    maxRange: 120,
    minHeightAbove: 4,
    /** Swing anchors must be at least this steep above the hand (shallow = "too low"). */
    minElevationDeg: 12,
    gravityScale: 0.74,
    pumpAccel: 10,
    /** Pumping fades out between pumpMaxSpeed and +10 m/s: W cruises, skill goes faster. */
    pumpMaxSpeed: 27,
    sideAccel: 9,
    brakeAccel: 6,
    steerRate: 0.9,
    catchEfficiency: 0.92,
    catchThreshold: 1.5,
    reelSpeed: 16,
    /** Rope length at attach as a fraction of the distance: <1 gives a gentle lift. */
    attachLengthFactor: 0.93,
    reelStep: 2.0,
    reelRange: 9,
    /** Pull-in speed when the anchor was further than maxRope. */
    pullInSpeed: 26,
    groundClearance: 1.4,
    fireSpeed: 1100,
    maxFireTime: 0.06,
    goodReleaseMinDeg: 12,
    goodReleaseMaxDeg: 72,
    goodReleaseMinUp: 1.5,
    goodReleaseBonus: 5.5,
    /** Forward release bonus fades out between these speeds (height bonus stays). */
    goodReleaseFadeStart: 34,
    goodReleaseFadeEnd: 50,
    goodReleaseUp: 4.5,
    groundLaunchUp: 10,
    groundLaunchForward: 5,
    landReleaseTime: 0.12,
  },
  /** Letting go of a line (button up, or Space on a swing or pull line): a push forward and up. */
  cut: {
    up: 5.5,
    forward: 4.5,
    /** The forward part fades out between these speeds (the lift stays). */
    fadeStart: 32,
    fadeEnd: 52,
    /** Seconds on a line for the full push; shorter holds give less (a tap gives none). */
    fullAfter: 0.4,
  },
  /** Space shortly after a zip end hop or a broken line: an air boost. */
  boost: {
    window: 0.45,
    up: 8,
    forward: 6,
  },
  dive: {
    gravityMul: 1.9,
    steerRate: 2.4,
    forwardAccel: 6,
  },
  zip: {
    /** Top pull speed: a little above swing cruising speed. */
    speed: 34,
    /** The pull starts at least this fast and eases up to `speed` at `accel`. */
    startSpeed: 10,
    accel: 75,
    decel: 75,
    endSpeed: 9,
    cooldown: 0.3,
    maxRange: 80,
    hopUp: 9.5,
    hopBack: 3,
    mantleReach: 3.6,
    maxTime: 3.5,
  },
  wall: {
    crawlSpeed: 5.2,
    wallRunMax: 17,
    wallRunDecay: 11,
    jumpOut: 9,
    jumpUp: 8.5,
    jumpForward: 6,
    stick: 2,
    letGoPush: 2,
  },
  /** Crosshair aim: lines go where the centre ray hits; rays this close around it catch edges. */
  aim: {
    magnetismDeg: 2.5,
    /** Wider magnetism with touch controls: a thumb aims less precisely than a mouse. */
    touchMagnetismDeg: 4,
  },
  /** Wide anchor search (cone around the view). Gameplay aims with the crosshair; test bots use this to pick where to look. */
  assist: {
    range: 72,
    minDistance: 5,
    idealDistance: 36,
    idealElevationDeg: 52,
    maxAimAngleDeg: 78,
    weightAngle: 1.0,
    weightDistance: 0.35,
    weightHeight: 0.3,
    losChecks: 30,
  },
  camera: {
    pivotHeight: 1.6,
    shoulder: 0.62,
    armGround: 4.3,
    armAir: 5.0,
    armFast: 5.8,
    armSpeedRef: 50,
    armDampOut: 3.5,
    /** Rate (1/s) at which a tree crown pulls the arm in; buildings cut it instantly. */
    armSoftIn: 18,
    fovBase: 70,
    fovMax: 95,
    fovSpeedMin: 12,
    fovSpeedMax: 62,
    fovDamp: 3.0,
    followFreq: 18,
    maxLag: 1.1,
    /** In the air the pivot follows a low-passed velocity with a softer spring: smooth arcs and releases. */
    airFollowFreq: 8,
    airVelSmooth: 10,
    maxLagAir: 1.5,
    /** Spring stiffening with lag: frequency x (1 + lagStiffen * (lag / maxLag)^2); twice maxLag is a hard safety limit. */
    lagStiffen: 3,
    /** Auto-follow: with the mouse idle, yaw turns toward the travel direction while flying fast. */
    autoYawRate: 1.2,
    autoYawDelay: 0.9,
    autoYawMinSpeed: 12,
    autoYawMaxAngleDeg: 110,
    lookAhead: 2.0,
    lookAheadDamp: 2.5,
    shakeHardLanding: 0.32,
    shakeDuration: 0.45,
    collisionRadius: 0.32,
    pitchMinDeg: -78,
    pitchMaxDeg: 80,
    baseSensitivity: 0.0022,
  },
  recovery: {
    stuckTime: 3.0,
    minProgress: 0.3,
    deepPenetration: 0.06,
    deepTicks: 6,
    blendTime: 0.35,
  },
  world: {
    waterLevel: -1.2,
    softBoundaryMargin: 110,
    softBoundaryAccel: 26,
  },
  time: {
    dayLengthMinutes: 12,
    startHour: 16.6,
    fastForwardRate: 40,
  },
  /** Rooftop moment: stand still on a roof and the night comes, with rain and music. */
  moment: {
    /** Seconds standing still on a roof before it starts. */
    idleSeconds: 5,
    /** It arms only after this much play since the last spawn, respawn or new game, and after walking this far (m) or using a line. */
    minPlaySeconds: 20,
    minTravel: 5,
    /** Feet at least this high above the street below. */
    minRoofHeight: 8,
    /** Night hour it moves to (from the morning it goes back to `dawnNightHour` instead). */
    nightHour: 22.6,
    dawnNightHour: 3.4,
    /** Time-lapse to night, then the rain builds up. */
    toNightSeconds: 4,
    rainInSeconds: 2.5,
    /** Music: it restarts from the top of the track and comes in quickly (keeps the intro); fades on the way out (music, hour back, rain). */
    musicInSeconds: 0.3,
    musicOutSeconds: 2.5,
    hourBackSeconds: 3,
    rainOutSeconds: 1.6,
    /** Orbit camera: blend in and out, radius, height above the chest, speed (rad/s). */
    orbitInSeconds: 2.5,
    orbitOutSeconds: 1.2,
    orbitRadius: 6,
    orbitHeight: 1.3,
    orbitSpeed: 0.13,
    /** Lightning: seconds between flashes. */
    boltMin: 8,
    boltMax: 18,
  },
  /** On-screen touch controls (phones and tablets). */
  touch: {
    /** Joystick: knob travel (CSS px), dead zone and the deflection that reaches full run speed (fractions of the travel). */
    stickRadius: 56,
    deadZone: 0.12,
    fullAt: 0.88,
    /** Knob at the rim (this fraction of the travel or more): sprint on the ground. */
    sprintAt: 0.97,
    /** Camera turn per CSS px of look drag at sensitivity 1 (rad). */
    lookRadPerPx: 0.0055,
    /** Held reel buttons repeat a wheel notch at this interval (s). */
    reelRepeat: 0.16,
  },
  /** Hero combat (M11). Read by the pure combat sim (30 Hz) and, from chunk 4, the hero's input router. */
  combat: {
    maxHp: 100,
    /** Regeneration starts this long after the last damage, then heals regenRate hp/s. */
    regenDelay: 5,
    regenRate: 12,
    /** Knocked out for this long, then respawn on a roof. */
    downTime: 4,
    /** Respawn roof search: distance ring (m) and roof height band (m). */
    respawnRoofMin: 40,
    respawnRoofMax: 180,
    respawnRoofMinY: 12,
    respawnRoofMaxY: 80,
    /** Any enemy this close in the front arc takes the left click. */
    closeRange: 3,
    closeArcDeg: 220,
    /** Crosshair cone for a lunge target. */
    coneDeg: 9,
    lungeRangeGround: 12,
    lungeRangeAir: 20,
    freeflowRange: 10,
    freeflowConeDeg: 120,
    lungeSpeed: 24,
    lungeMaxTime: 0.45,
    /** Hand/foot to enemy capsule surface at contact. */
    reach: 1.6,
    /** Time after a hit that keeps the chain (and the counter) alive. */
    comboWindow: 1.1,
    inputBuffer: 0.25,
    /** Chain moves: contact time, recovery, damage. The chain cycles jab, cross, kick, upper. */
    jabContact: 0.1,
    jabRecover: 0.22,
    jabDmg: 10,
    crossContact: 0.1,
    crossRecover: 0.22,
    crossDmg: 12,
    kickContact: 0.14,
    kickRecover: 0.28,
    kickDmg: 15,
    upperContact: 0.16,
    upperRecover: 0.34,
    upperDmg: 20,
    /** The 4th hit of a chain knocks back (m/s) and down. */
    chainKnockback: 5,
    airStrikeDmg: 14,
    airHang: 0.35,
    airHangGravity: 0.2,
    /** Left click on a DOWN enemy this close. KOs regular enemies. */
    groundFinisherDmg: 40,
    groundFinisherRange: 3,
    focusPerHit: 12,
    takedownCost: 100,
    takedownRange: 4,
    /** A takedown on a boss removes this fraction of its max hp. */
    takedownBossFrac: 0.15,
    yankDmg: 5,
    yankRange: 35,
    yankConeDeg: 6,
    /** Yanked enemies fly toward the hero for this long and stop this far from it. */
    yankTime: 0.35,
    yankStop: 1.6,
    /** Right button held this long on an enemy pins it, for pinTime. */
    pinHold: 0.3,
    pinTime: 4,
    dodgeIframes: 0.4,
    dodgeLookahead: 0.8,
    dodgeSpeed: 9,
    dodgeTime: 0.25,
    hitStun: 0.25,
    knockdownTime: 0.8,
    /** Server-side checks (same in single player): strike spacing, extra reach, intent rate (per s). */
    minStrikeInterval: 0.15,
    lagTolerance: 1.2,
    maxIntentRate: 15,
    /** Intent time stamps must lie in [now - viewPast, now + viewFuture]. */
    viewPast: 0.4,
    viewFuture: 0.05,
    /** Hero position in an intent must be this close to the extrapolated last sample. */
    heroPosTolerance: 4,
    /** Hero samples are extrapolated at most this far ahead. */
    heroExtrapolate: 0.15,
    /** Late hit resolution for online heroes: clamp(RTT / 2 + graceBase, 0, graceMax). */
    graceBase: 0.05,
    graceMax: 0.2,
  },
  /** Enemy behaviour (shared) and per-kind stats: hp, speed (m/s), damage, telegraph (wind-up, s), cooldown (s), range (m). */
  enemies: {
    /** Target search: nearest valid hero within this range with line of sight, re-checked every `retarget` s. */
    aggroRange: 40,
    loseRange: 60,
    retarget: 0.5,
    /** Reaction after spotting a hero. */
    alertTime: 0.35,
    /** At most this many melee attackers per hero; the others circle at circleMin-circleMax. */
    maxMeleeAttackers: 2,
    circleMin: 4,
    circleMax: 6,
    /** Enemies keep this far apart. */
    separation: 1.2,
    /** Arena leash: the arena rectangle plus this margin. */
    leashMargin: 8,
    /** A fall higher than this KOs. */
    fallKo: 6,
    /** KO'd enemies stay this long, then the slot is recycled. */
    koLinger: 4,
    gravity: 22,
    accel: 30,
    thug: { hp: 60, speed: 4.5, damage: 8, telegraph: 0.45, cooldown: 1.2, range: 1.6, bottleDamage: 6, bottleMinAbove: 3, bottleRange: 15 },
    bat: { hp: 70, speed: 4.2, damage: 14, telegraph: 0.6, cooldown: 1.6, range: 2.1, knockback: 6 },
    gunman: { hp: 50, speed: 3.5, damage: 6, telegraph: 0.7, cooldown: 2, range: 60, burst: 3, burstGap: 0.12, keepMin: 12, keepMax: 25 },
    brute: { hp: 180, speed: 3.2, damage: 22, telegraph: 0.9, cooldown: 2.2, range: 2.4, chargeDamage: 18, chargeSpeed: 12, backArcDeg: 110, aboveHeight: 1.2, pinStun: 1.5 },
    drone: { hp: 30, speed: 10, damage: 7, telegraph: 0.6, cooldown: 2, range: 25, boltSpeed: 25, orbitRadius: 8, orbitHeight: 5 },
    kocbasi: { hp: 1200, speed: 5, damage: 30, telegraph: 1.2, cooldown: 2.5, range: 3, frontArmor: 0.2, chargeSpeed: 22, stompRadius: 6, stompDamage: 15, wallStun: 3, phase2: 0.5 },
    kuzgun: { hp: 900, speed: 12, damage: 20, telegraph: 1, cooldown: 2.5, range: 30, flyMin: 15, flyMax: 30, darts: 5, dartDamage: 6, pinsToDrop: 2, groundStun: 4, adds: 3 },
    diken: { hp: 1000, speed: 5, damage: 10, telegraph: 0.7, cooldown: 2, range: 2.6, clawChain: 3, tailDamage: 25, poisonDps: 2, poisonTime: 4, tailStuck: 2, yankStun: 1.5 },
  },
  /** Crime events and roaming patrols (M11 chunk 7). */
  events: {
    /** First event after this much play, at distMin-distMax m from the hero (also the range for later ones). */
    firstDelay: 20,
    distMin: 250,
    distMax: 700,
    /** Gap after an event ends before the next one starts. */
    gapMin: 45,
    gapMax: 75,
    concurrentSp: 2,
    /** Online: min(concurrentMp, 1 + floor(players / playersPerExtra)). */
    concurrentMp: 3,
    playersPerExtra: 4,
    /** Every n-th cleared event is a boss. */
    bossEvery: 4,
    /** An event expires after this long when no hero came within expireRadius. */
    expireAfter: 240,
    expireRadius: 150,
    roamMin: 4,
    roamMax: 6,
    /** Roaming pairs patrol within roamRadius of a hero, spawn beyond roamSpawnMin from every hero and despawn beyond roamDespawn. */
    roamRadius: 250,
    roamSpawnMin: 120,
    roamDespawn: 350,
    maxEnemiesSp: 30,
    maxEnemiesMp: 60,
    /** Online: enemies replicated per client (nearest) and their radius. */
    replicateMax: 30,
    replicateRadius: 300,
  },
};

export type Tuning = typeof tuning;

/** [min, max, step] for the debug panel. */
export const tuningMeta: Record<string, [number, number, number]> = {
  'ground.runSpeed': [3, 20, 0.1],
  'ground.sprintSpeed': [6, 30, 0.1],
  'ground.accel': [10, 200, 1],
  'ground.sprintAccel': [10, 200, 1],
  'ground.decel': [10, 200, 1],
  'ground.overspeedDecel': [2, 80, 1],
  'ground.turnBlend': [1, 40, 0.5],
  'ground.jumpSpeed': [4, 20, 0.1],
  'ground.sprintJumpBonus': [0, 5, 0.1],
  'ground.coyoteTime': [0, 0.4, 0.01],
  'ground.jumpBuffer': [0, 0.4, 0.01],
  'ground.stepHeight': [0.1, 0.6, 0.01],
  'ground.snapDown': [0.1, 1, 0.01],
  'ground.vaultMinHeight': [0.2, 1, 0.01],
  'ground.vaultMaxHeight': [0.8, 2.2, 0.01],
  'ground.vaultMaxDepth': [0.5, 4, 0.1],
  'ground.vaultDuration': [0.15, 1, 0.01],
  'ground.mantleDuration': [0.15, 1, 0.01],
  'ground.hardLandingSpeed': [10, 60, 0.5],
  'ground.rollMinSpeed': [0, 20, 0.5],
  'ground.rollDuration': [0.2, 1.2, 0.01],
  'air.gravity': [5, 50, 0.5],
  'air.airAccel': [0, 60, 0.5],
  'air.airControlSpeed': [0, 30, 0.5],
  'air.airSteerRate': [0, 5, 0.05],
  'air.airBrake': [0, 30, 0.5],
  'air.drag': [0, 0.05, 0.001],
  'air.softCap': [30, 120, 1],
  'air.capDrag': [0, 0.3, 0.005],
  'air.maxFallSpeed': [30, 150, 1],
  'swing.minRope': [5, 30, 0.5],
  'swing.maxRope': [20, 90, 0.5],
  'swing.maxRange': [30, 160, 1],
  'swing.minHeightAbove': [0, 20, 0.5],
  'swing.minElevationDeg': [0, 60, 1],
  'swing.gravityScale': [0.3, 1.5, 0.01],
  'swing.pumpAccel': [0, 40, 0.5],
  'swing.pumpMaxSpeed': [5, 80, 0.5],
  'swing.sideAccel': [0, 30, 0.5],
  'swing.brakeAccel': [0, 30, 0.5],
  'swing.steerRate': [0, 4, 0.05],
  'swing.catchEfficiency': [0, 1, 0.01],
  'swing.catchThreshold': [0, 10, 0.1],
  'swing.reelSpeed': [1, 50, 0.5],
  'swing.attachLengthFactor': [0.6, 1, 0.01],
  'swing.reelStep': [0.5, 6, 0.1],
  'swing.reelRange': [0, 20, 0.5],
  'swing.pullInSpeed': [1, 60, 0.5],
  'swing.groundClearance': [0, 5, 0.1],
  'swing.fireSpeed': [100, 3000, 10],
  'swing.maxFireTime': [0, 0.2, 0.005],
  'swing.goodReleaseMinDeg': [0, 60, 1],
  'swing.goodReleaseMaxDeg': [20, 90, 1],
  'swing.goodReleaseMinUp': [0, 10, 0.1],
  'swing.goodReleaseBonus': [0, 20, 0.1],
  'swing.goodReleaseUp': [0, 20, 0.1],
  'swing.goodReleaseFadeStart': [0, 100, 1],
  'swing.goodReleaseFadeEnd': [0, 120, 1],
  'swing.groundLaunchUp': [0, 25, 0.5],
  'swing.groundLaunchForward': [0, 20, 0.5],
  'swing.landReleaseTime': [0, 1, 0.01],
  'cut.up': [0, 20, 0.1],
  'cut.forward': [0, 15, 0.1],
  'cut.fadeStart': [0, 100, 1],
  'cut.fadeEnd': [0, 120, 1],
  'cut.fullAfter': [0, 2, 0.05],
  'boost.window': [0, 1.5, 0.01],
  'boost.up': [0, 25, 0.5],
  'boost.forward': [0, 25, 0.5],
  'dive.gravityMul': [1, 4, 0.05],
  'dive.steerRate': [0, 8, 0.1],
  'dive.forwardAccel': [0, 30, 0.5],
  'zip.speed': [10, 80, 0.5],
  'zip.startSpeed': [0, 40, 0.5],
  'zip.accel': [20, 500, 5],
  'zip.decel': [10, 300, 5],
  'zip.endSpeed': [0, 30, 0.5],
  'zip.cooldown': [0, 3, 0.05],
  'zip.maxRange': [20, 120, 1],
  'zip.hopUp': [0, 25, 0.5],
  'zip.hopBack': [0, 15, 0.5],
  'zip.mantleReach': [0.5, 8, 0.1],
  'zip.maxTime': [0.5, 8, 0.1],
  'wall.crawlSpeed': [1, 15, 0.1],
  'wall.wallRunMax': [0, 40, 0.5],
  'wall.wallRunDecay': [0, 40, 0.5],
  'wall.jumpOut': [0, 25, 0.5],
  'wall.jumpUp': [0, 25, 0.5],
  'wall.jumpForward': [0, 25, 0.5],
  'wall.stick': [0, 10, 0.1],
  'wall.letGoPush': [0, 10, 0.1],
  'aim.magnetismDeg': [0, 8, 0.1],
  'aim.touchMagnetismDeg': [0, 10, 0.1],
  'assist.range': [20, 120, 1],
  'assist.minDistance': [0, 30, 0.5],
  'assist.idealDistance': [10, 80, 0.5],
  'assist.idealElevationDeg': [0, 85, 1],
  'assist.maxAimAngleDeg': [10, 120, 1],
  'assist.weightAngle': [0, 5, 0.05],
  'assist.weightDistance': [0, 5, 0.05],
  'assist.weightHeight': [0, 5, 0.05],
  'assist.losChecks': [1, 40, 1],
  'camera.pivotHeight': [0.5, 3, 0.01],
  'camera.shoulder': [-2, 2, 0.01],
  'camera.armGround': [1.5, 12, 0.1],
  'camera.armAir': [1.5, 14, 0.1],
  'camera.armFast': [1.5, 16, 0.1],
  'camera.armSpeedRef': [5, 100, 1],
  'camera.armDampOut': [0.5, 20, 0.1],
  'camera.armSoftIn': [1, 120, 1],
  'camera.fovBase': [40, 100, 1],
  'camera.fovMax': [50, 120, 1],
  'camera.fovSpeedMin': [0, 60, 1],
  'camera.fovSpeedMax': [10, 120, 1],
  'camera.fovDamp': [0.1, 20, 0.1],
  'camera.followFreq': [2, 60, 0.5],
  'camera.maxLag': [0, 5, 0.05],
  'camera.airFollowFreq': [1, 40, 0.5],
  'camera.airVelSmooth': [0.5, 40, 0.5],
  'camera.maxLagAir': [0, 6, 0.05],
  'camera.lagStiffen': [0, 20, 0.1],
  'camera.autoYawRate': [0, 6, 0.05],
  'camera.autoYawDelay': [0, 3, 0.05],
  'camera.autoYawMinSpeed': [0, 60, 1],
  'camera.autoYawMaxAngleDeg': [0, 180, 1],
  'camera.lookAhead': [0, 5, 0.05],
  'camera.lookAheadDamp': [0.1, 20, 0.1],
  'camera.shakeHardLanding': [0, 2, 0.01],
  'camera.shakeDuration': [0.05, 2, 0.01],
  'camera.collisionRadius': [0.1, 0.8, 0.01],
  'camera.pitchMinDeg': [-89, 0, 1],
  'camera.pitchMaxDeg': [0, 89, 1],
  'camera.baseSensitivity': [0.0002, 0.01, 0.0001],
  'recovery.stuckTime': [0.5, 10, 0.1],
  'recovery.minProgress': [0.05, 2, 0.01],
  'recovery.deepPenetration': [0.01, 0.5, 0.01],
  'recovery.deepTicks': [1, 60, 1],
  'recovery.blendTime': [0, 2, 0.01],
  'world.softBoundaryMargin': [10, 300, 1],
  'world.softBoundaryAccel': [1, 100, 1],
  'time.dayLengthMinutes': [1, 120, 0.5],
  'time.startHour': [0, 24, 0.1],
  'time.fastForwardRate': [2, 200, 1],
  'moment.idleSeconds': [1, 30, 0.5],
  'moment.minPlaySeconds': [0, 120, 1],
  'moment.minTravel': [0, 50, 0.5],
  'moment.minRoofHeight': [2, 40, 0.5],
  'moment.nightHour': [0, 24, 0.1],
  'moment.dawnNightHour': [0, 24, 0.1],
  'moment.toNightSeconds': [0.5, 15, 0.1],
  'moment.rainInSeconds': [0.2, 10, 0.1],
  'moment.musicInSeconds': [0.2, 10, 0.1],
  'moment.musicOutSeconds': [0.2, 10, 0.1],
  'moment.hourBackSeconds': [0.5, 10, 0.1],
  'moment.rainOutSeconds': [0.2, 10, 0.1],
  'moment.orbitInSeconds': [0.2, 6, 0.1],
  'moment.orbitOutSeconds': [0.2, 6, 0.1],
  'moment.orbitRadius': [2, 15, 0.1],
  'moment.orbitHeight': [-1, 5, 0.1],
  'moment.orbitSpeed': [0, 1, 0.01],
  'moment.boltMin': [2, 60, 0.5],
  'moment.boltMax': [2, 90, 0.5],
  'touch.stickRadius': [30, 120, 1],
  'touch.deadZone': [0, 0.5, 0.01],
  'touch.fullAt': [0.3, 1, 0.01],
  'touch.sprintAt': [0.5, 1, 0.01],
  'touch.lookRadPerPx': [0.001, 0.02, 0.0005],
  'touch.reelRepeat': [0.05, 0.6, 0.01],
  'combat.maxHp': [10, 500, 1],
  'combat.regenDelay': [0, 30, 0.5],
  'combat.regenRate': [0, 100, 1],
  'combat.downTime': [0.5, 15, 0.1],
  'combat.respawnRoofMin': [0, 200, 1],
  'combat.respawnRoofMax': [20, 400, 1],
  'combat.respawnRoofMinY': [0, 60, 1],
  'combat.respawnRoofMaxY': [10, 200, 1],
  'combat.closeRange': [0.5, 8, 0.1],
  'combat.closeArcDeg': [30, 360, 5],
  'combat.coneDeg': [1, 30, 0.5],
  'combat.lungeRangeGround': [2, 40, 0.5],
  'combat.lungeRangeAir': [2, 50, 0.5],
  'combat.freeflowRange': [2, 30, 0.5],
  'combat.freeflowConeDeg': [10, 360, 5],
  'combat.lungeSpeed': [5, 60, 0.5],
  'combat.lungeMaxTime': [0.1, 2, 0.01],
  'combat.reach': [0.5, 4, 0.05],
  'combat.comboWindow': [0.2, 4, 0.05],
  'combat.inputBuffer': [0, 1, 0.01],
  'combat.jabContact': [0.02, 0.5, 0.01],
  'combat.jabRecover': [0.05, 1, 0.01],
  'combat.jabDmg': [0, 100, 1],
  'combat.crossContact': [0.02, 0.5, 0.01],
  'combat.crossRecover': [0.05, 1, 0.01],
  'combat.crossDmg': [0, 100, 1],
  'combat.kickContact': [0.02, 0.5, 0.01],
  'combat.kickRecover': [0.05, 1, 0.01],
  'combat.kickDmg': [0, 100, 1],
  'combat.upperContact': [0.02, 0.5, 0.01],
  'combat.upperRecover': [0.05, 1, 0.01],
  'combat.upperDmg': [0, 100, 1],
  'combat.chainKnockback': [0, 20, 0.5],
  'combat.airStrikeDmg': [0, 100, 1],
  'combat.airHang': [0, 2, 0.01],
  'combat.airHangGravity': [0, 1, 0.01],
  'combat.groundFinisherDmg': [0, 200, 1],
  'combat.groundFinisherRange': [0.5, 8, 0.1],
  'combat.focusPerHit': [0, 100, 1],
  'combat.takedownCost': [0, 100, 1],
  'combat.takedownRange': [0.5, 10, 0.1],
  'combat.takedownBossFrac': [0, 1, 0.01],
  'combat.yankDmg': [0, 50, 1],
  'combat.yankRange': [5, 80, 1],
  'combat.yankConeDeg': [1, 30, 0.5],
  'combat.yankTime': [0.05, 1.5, 0.01],
  'combat.yankStop': [0.5, 5, 0.1],
  'combat.pinHold': [0.05, 1.5, 0.01],
  'combat.pinTime': [0.5, 15, 0.1],
  'combat.dodgeIframes': [0, 1.5, 0.01],
  'combat.dodgeLookahead': [0.1, 2, 0.05],
  'combat.dodgeSpeed': [0, 30, 0.5],
  'combat.dodgeTime': [0.05, 1, 0.01],
  'combat.hitStun': [0, 2, 0.01],
  'combat.knockdownTime': [0, 4, 0.05],
  'combat.minStrikeInterval': [0, 1, 0.01],
  'combat.lagTolerance': [0, 5, 0.05],
  'combat.maxIntentRate': [1, 60, 1],
  'combat.viewPast': [0, 2, 0.01],
  'combat.viewFuture': [0, 0.5, 0.01],
  'combat.heroPosTolerance': [0.5, 20, 0.1],
  'combat.heroExtrapolate': [0, 1, 0.01],
  'combat.graceBase': [0, 0.3, 0.005],
  'combat.graceMax': [0, 0.5, 0.005],
  'enemies.aggroRange': [5, 150, 1],
  'enemies.loseRange': [10, 200, 1],
  'enemies.retarget': [0.1, 3, 0.05],
  'enemies.alertTime': [0, 2, 0.01],
  'enemies.maxMeleeAttackers': [1, 8, 1],
  'enemies.circleMin': [1, 15, 0.1],
  'enemies.circleMax': [1, 20, 0.1],
  'enemies.separation': [0, 4, 0.05],
  'enemies.leashMargin': [0, 50, 1],
  'enemies.fallKo': [1, 40, 0.5],
  'enemies.koLinger': [0, 20, 0.5],
  'enemies.gravity': [5, 50, 0.5],
  'enemies.accel': [1, 100, 1],
  'events.firstDelay': [0, 300, 1],
  'events.distMin': [0, 1000, 10],
  'events.distMax': [50, 1500, 10],
  'events.gapMin': [0, 600, 1],
  'events.gapMax': [0, 600, 1],
  'events.concurrentSp': [1, 6, 1],
  'events.concurrentMp': [1, 8, 1],
  'events.playersPerExtra': [1, 16, 1],
  'events.bossEvery': [1, 20, 1],
  'events.expireAfter': [10, 900, 5],
  'events.expireRadius': [10, 500, 5],
  'events.roamMin': [0, 20, 1],
  'events.roamMax': [0, 20, 1],
  'events.roamRadius': [50, 600, 10],
  'events.roamSpawnMin': [0, 400, 10],
  'events.roamDespawn': [50, 800, 10],
  'events.maxEnemiesSp': [0, 60, 1],
  'events.maxEnemiesMp': [0, 120, 1],
  'events.replicateMax': [1, 60, 1],
  'events.replicateRadius': [50, 1000, 10],
};

// Per-kind enemy stats share one set of ranges per stat name (`enemies.<kind>.<stat>`).
{
  const statRanges: Record<string, [number, number, number]> = {
    hp: [1, 5000, 1],
    speed: [0, 40, 0.1],
    damage: [0, 100, 1],
    telegraph: [0.05, 3, 0.01],
    cooldown: [0, 10, 0.05],
    range: [0.5, 100, 0.1],
  };
  const kinds = tuning.enemies as unknown as Record<string, unknown>;
  for (const kind of Object.keys(kinds)) {
    const stats = kinds[kind];
    if (typeof stats !== 'object' || stats === null) continue;
    for (const [stat, v] of Object.entries(stats as Record<string, number>)) {
      const r = statRanges[stat];
      tuningMeta[`enemies.${kind}.${stat}`] = r ?? [0, Math.max(1, Math.abs(v) * 4), v % 1 === 0 ? 1 : 0.01];
    }
  }
}

/** Deep copy of the shipped values so the debug panel can reset. */
export const tuningDefaults: Tuning = JSON.parse(JSON.stringify(tuning)) as Tuning;

type TuningNode = { [key: string]: number | TuningNode };

/** Copy numbers from src into dst, recursing into sub-groups (`enemies.<kind>`), never sharing objects. */
function copyTuning(src: TuningNode, dst: TuningNode): void {
  for (const key of Object.keys(src)) {
    const v = src[key]!;
    if (typeof v === 'number') dst[key] = v;
    else copyTuning(v, dst[key] as TuningNode);
  }
}

export function resetTuning(): void {
  copyTuning(tuningDefaults as unknown as TuningNode, tuning as unknown as TuningNode);
}

export const DEG = Math.PI / 180;
