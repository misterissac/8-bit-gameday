import { useSyncExternalStore } from 'react';

// v12: removed unphysical back foot glide (back foot stays planted in world space);
// versioned so older saved tunings (which merge over the defaults) don't
// silently keep the previous values.
export const TUNING_STORAGE_KEY = 'playbyplay-debug-tuning-v12';

export const DEFAULT_TUNING = {
  playback: {
    timeScale: 0.61,
    // ...and the pause is what the pitcher's hold is for: a beat between pitches long
    // enough for him to stand in his follow-through (see pitcher.clipDuration).
    cyclePause: 1.8,
    ballReleaseTime: 1.32,
    // Beat the overlaid pitches hold in their finished pose (ball at the
    // catcher / batted ball landed) before the comparison cycle wraps and
    // auto-replays, so the user can digest the result.
    comparisonFinishPause: 3,
  },
  camera: {
    minHeight: 1,
    moveSpeed: 10,
    boostMultiplier: 3,
    rotationSpeed: 0.0025,
    followRestoreDuration: 0.6,
    fielderRestoreDuration: 0.6,
    fielderHeadHeight: 1.8,
    fielderLabelHeight: 2.8,
  },
  pitcher: {
    // The delivery is longer than the throw: the finish is held for a second before
    // the pitcher walks back into his set (see the hold in pitcherSequence), so the
    // clip is the throw plus the hold, and the cycle's own pause below is the same
    // second — the loop only gives the hold the room it asks for.
    clipDuration: 3.32,
    neutralClipDuration: 0.83,
    crossfadeTime: 0.2,
    overlayOpacity: 0.55,
  },
  pitch: {
    spinSpeedScale: 0.1,
    trailSampleStep: 0.001,
    trailLeadScale: 0.08,
    trailParticleScale: 0.04,
    overlayBallOpacity: 0.5,
    overlayTrailFactor: 0.55,
    overlayTraceFactor: 0.55,
    trailFadeTime: 0.18,
    trailMaxOpacity: 0.5,
    whiteTraceScale: 0.018,
    densityMinMph: 70,
    densityMaxMph: 90,
    densityMinFraction: 0.3,
    densityMaxFraction: 1,
    whiteTraceOpacity: 0.16,
    whiteTraceMinOpacity: 0.05,
    whiteTraceFadeTime: 0.5,
    billowCount: 12,
    billowStartFraction: 2 / 3,
    billowSpawnSpan: 0.5,
    billowSpawnBehind: 0.025,
    billowLife: 0.45,
    billowFadeIn: 0.05,
    billowSpread: 1.1,
    billowBackDrift: 0.6,
    billowBaseScale: 0.06,
    billowScaleGrowth: 3.5,
    billowOpacity: 0.85,
    whiteBillowCount: 4,
    whiteBillowCountMax: 16,
    whiteBillowThresholdMph: 85,
    whiteBillowMinMultiplier: 0.1,
    whiteBillowMaxMultiplier: 1,
    goldSparkThresholdMph: 99,
    goldSparkCount: 16,
    goldRingThresholdMph: 100,
    ringPulseTime: 0.35,
    ringSettleTime: 0.8,
    ringFadeTime: 0.3,
    ringPulseOvershoot: 0.8,
    ringMaxOpacity: 0.95,
    ringSettledOpacity: 0.3,
    ringSpikeCount: 17,
    ringSpikeOpacity: 1.25,   // bright enough to bloom over the impact fire sheet
    ringSpikeBurstFactor: 0.3, // snap outward on the pulse so the lances jump out of the fire
    ringSpikeDriftSpeed: 0.14,
    ringSpikeDriftFade: 1.35,
    ringSpikeExpandSpeed: 0.57,
    ringSpikeFade: 0.2,        // linger past the fire's brightest beat
    ringLingerCount: 18,
    ringLingerLife: 0.7,
    ringLingerOpacity: 0.26,
    ringLingerWidth: 0.008,
    ringLingerSpawnSpan: 0.28,
    ringLingerFadeIn: 0.06,
    ringLingerLateAt: 0.5,
    ringLingerLateFraction: 0.35,
    smokeCount: 7,
    smokeLife: 0.7,
    smokeSpawnSpan: 0.28,
    smokeFadeIn: 0.08,
    smokeBaseScale: 0.011,
    smokeScaleGrowth: 1.85,
    smokeGrowthFade: 4,
    smokeOpacity: 1.35,
    smokeWhiteR: 1,
    smokeWhiteG: 1,
    smokeWhiteB: 1,
    smokeRedR: 0.95,
    smokeRedG: 0.35,
    smokeRedB: 0.08,
    smokeGreyR: 0.5,
    smokeGreyG: 0.5,
    smokeGreyB: 0.5,
    smokeBlackR: 0.4,
    smokeBlackG: 0.4,
    smokeBlackB: 0.4,
    smokeWhiteShare: 0.37,
    smokeWhiteWindow: 0.05,
    smokeRedShare: 0.14,
    smokeRedWindowTop: 1.92,
    smokeGreyBlackPower: 1.9,
    smokeWhiteLuminanceThreshold: 0.78,
    smokeToneBoostMax: 0.25,
    smokeWhiteBoost: 0.1,
    smokeWhiteOpacityShrink: 0,
    smokePerimeterSpread: 0.12,
    smokeDriftMin: 0.02,
    smokeDriftMax: 0.11,
    smokeRiseMin: 0.12,
    smokeRiseMax: 0.22,
    smokeSwaySpeedMin: 3,
    smokeSwaySpeedMax: 6.6,
    smokeSwayAmplitudeMin: 0.01,
    smokeSwayAmplitudeMax: 0.025,
    rippleLife: 0.17,      // s — a crack is a snap, not a slow bloom
    rippleMaxScale: 3.0,   // snaps outward fast on the ease-out curve
    rippleOpacity: 0.75,   // white-hot birth flash
    rippleWidth: 0.012,    // m — thin band so the shock front reads as a crisp crack line
    emberCount: 10,
    emberLife: 0.9,
    emberOpacity: 0.95,
    emberBaseScale: 0.006,
    emberSpawnSpan: 0.34,
    emberFadeIn: 0.05,
    emberRiseSpeed: 0.18,
    emberDriftSpeed: 0.05,
    emberTwinkleSpeed: 14,
    emberScatterSpeed: 0.028,
    emberScatterTime: 0.12,
    emberPopAmount: 0.9,
    emberPopOpacity: 1.1,
    emberPopRate: 16,
    emberGlowAmount: 0.5,
    emberGlowFalloff: 2.2,
    emberGlowJitter: 0.12,
    emberGlowAmountJitter: 0.3,
    lingerPulseAmount: 0.35,
    smokeWarmAmount: 0.5,
    smokeWarmFalloff: 2.2,
    zoneHeatTint: 0.65,
    burnRingStartFraction: 0.6,
    burnRingFadeTime: 0.15,
    burnRingOpacity: 1.6,
    burnRingFlickerSpeed: 18,
    burnRingFlickerAmount: 0.35,
    burnRingGlowAmount: 0.95,
    burnRingFlameAmount: 0.6,  // asymmetric flame undulation on the halo rim
    burnRingFlameSpeed: 22,    // rad/s — how fast the flame licks around the ball
    burnRingAxisBias: 0.35,    // flare harder along the spin axis than across it
    burnIgniteAmount: 1.2,     // ignition flash: how much brighter/wider the fire surges at the zone
    burnIgniteRate: 12,        // 1/s — how fast the ignition surge dies down
    burnCrimsonGlow: 0.5,      // ball crimson glow intensifies with the flame tongues
    ballHeatTint: 0.35,        // how strongly the ball's surface warms while burning
    burnShimmerOpacity: 0.4,   // heat-shimmer haze around the burning ball
    burnShimmerSpeed: 9,       // rad/s — how fast the shimmer ripples drift
    burnSparkCount: 20,        // sparkler sparks shed off the burn ring
    burnSparkLife: 0.3,        // s — each spark's flight time
    burnSparkOpacity: 0.9,     // sparkler brightness
    burnSparkScale: 0.018,     // m — sparkler glint size
    impactFireOpacity: 0.8,    // impact fire burst brightness
    impactFireSpread: 0.14,    // m — how far the burst lances outward (slow crawl)
    impactFireScale: 0.06,     // m — impact fire blob size (grows as it spreads)
    ringHoldTime: 0.12,        // s — white-hot ring hold before it cools
    burnTrailCount: 18,
    burnTrailStep: 0.012,
    burnTrailOpacity: 0.85,
    burnTrailScale: 0.022,
    ringFlickerSpeed: 7,
    ringFlickerDepth: 0.14,
  },
  battedBall: {
    throwSpeedMph: 70,
    maxRunSpeedMph: 9,
    // Ground-ball roll speed in mph. 0 = auto = match the ball's own
    // horizontal (exit) speed, which preserves the existing fielder-intercept
    // timing exactly. A non-zero value re-solves the fielded-ball interception
    // so ball and fielder still converge on the same catch point at the same
    // time, but the ball rolls faster/slower along the ground to get there.
    groundRollSpeedMph: 0,
    // How long (ms) a contacted play may loop waiting for its live Statcast
    // hit before the gentle stuck-play auto-advance fires. Deliberately long
    // (30s): the hit normally lands a poll or two after contact, so this never
    // fires early; it only rescues a play whose hit genuinely never arrives.
    noLaunchTimeoutMs: 30000,
    trailFadeTime: 0.18,
    trailMaxOpacity: 0.5,
    trailLeadScale: 0.08,
    trailParticleScale: 0.04,
    traceScale: 0.024,
    traceOpacity: 0.5,
    traceMinOpacity: 0.2,
    traceFadeTime: 0.5,
    comparisonBallOpacity: 0.35,
    comparisonTrailFactor: 0.55,
  },
  batter: {
    fadeStartDistance: 3,
    fadeEndDistance: 11,
    // The set stance's idle: how fast its clock runs, and what the wave does at
    // its deepest point. ``swayKneeFlex`` is the amount that matters — the knees
    // give by this much and the hips drop by whatever the leg geometry says that
    // flex costs (see idleCrouch), so the body can never rise above the stance
    // and lift a shoe off the ground. The rest ride the same clock: the weight
    // shift that lands on a foot as its knee gives, the knees' own travel forward
    // as they flex, the torso's lean with the weight, and the bat's waggle in the
    // hands (a yaw and a roll, at twice the tempo, so it reads as loose rather
    // than metronomic).
    //
    // Read off the reference idle clip (solomon-gumball's BattingIdle: two
    // identical cycles in 2.46 s, so 1.23 s a bounce): the pelvis travelling
    // 4.37 cm down and 3.05 cm across in one motion, the torso tipping 1.8
    // degrees, and a bat that turns 8.2 degrees in the hands. The wave is
    // one-sided, so each amount below is the whole of its own excursion: the
    // tip, the drop and the waggle all happen between the stance and the
    // deepest frame, never above the stance. Flexing to 0.4 rad
    // here drops the hips 4.1 cm, which is that distance at this stance's own
    // geometry — and it costs 24 degrees of knee where the reference's own 12
    // would move this batter barely 1.6 cm, because the rig's legs stand within
    // 5 mm of their own span at the set and the first degrees of flex are where
    // all the drop is.
    swaySpeed: 5.1,
    swayKneeFlex: 0.4,
    swaySwayAmount: 0.03,
    swayKneeTravel: 0.05,
    swayLeanAmount: 0.031,
    swayBatWiggle: 0.055,
    swayBatRoll: 0.03,
    fadeMinOpacity: 0.2,
    swingLead: 0.22,
    followThrough: 0.14,
    followHold: 0.28,
    recoveryTime: 0.55,
    loadTime: 0.18,
    bodyOpenMax: 0.4,
    // How far the chest still is from the pitcher's line at the end of the
    // follow-through — the same axis and the same side as bodyOpenMax above, so
    // the swing keeps opening while this is below the contact turn and the chest
    // reaches the pitcher's line at 0, and *past* him below that. A batter's body
    // does not stop at contact: it carries on round through the pitcher's line,
    // which is also what leaves the arms somewhere to go, instead of folding them
    // across a chest that has stopped turning. (This used to be read as a
    // magnitude, so every value put the finish *short* of the contact turn and
    // the body visibly closed back up through the follow-through.)
    //
    // Measured off the posed skeleton, from 21.8° short of the pitcher at contact
    // to 27.0° *past* him at the end of the follow-through, 31.3° through the hold
    // and 31.3° at the peak: the chest is still opening after the ball has gone,
    // which is the beat the hands ride to come round with it. It is set by the
    // bat's own carry rather than by the body: both fists stay on the handle and
    // the trailing arm's reach is what bounds where the bat can be carried, so the
    // shoulders are what bring the knob round to the plane (see TRAIL_REACH_CLEAR
    // and TRAIL_REACH_MAX in Batter.jsx, and the spec's own reading of it — the
    // finish is measured 27° past the pitcher against the 40° it is held to).
    fullOpenYaw: -0.45,
    headTiltMax: -0.15,
    lowerBodyOpenFactor: 0.9,
    // How much of that turn the pelvis takes with it on the follow-through, as
    // against the 0.9 the hips lead the shoulders with into contact (which sets
    // the whole approach and the contact geometry, and is left alone). All of
    // it: the finish is the whole lower body open with the chest, legs included
    // — the swing is over, nothing is being staged for a next move, and a pelvis
    // left behind the chest is a waist band with a turn to absorb.
    followLowerOpenFactor: 1,
    loadedBaseAngle: -3.141592653589793,
    throughBaseAngle: 1.10,
    cockAngle: 0.7,
    setFaceBias: 0.35,
    // How far the set stance's trunk is turned off the plate-facing yaw toward
    // the pitcher's line — the direction the arms are held toward — as a share of
    // the angle between them. The set stance faces the plate, which is broadside
    // to the pitcher, so the trunk starts the swing a long way round from where
    // the arms are pointed; the trunk and the pelvis are turned this far toward
    // them (together, so nothing is added to the waist's own twist), which is
    // also where the swing unwinds back to. 0 leaves the stance facing the plate
    // exactly as it always did.
    //
    // It is also what the *hands* are measured against. With the grip out over
    // the trail shoulder (where it was) 0.30 of this left the lead arm's bicep 10
    // vertices inside the ribs; with the grip in front of the chest and the trunk
    // turned to meet it, the same arm is clear of the trunk at 0 inside, and 0.11
    // rig in front of its own shoulder.
    //
    // The share is bounded at both ends by the pose it is there for: the pitcher's
    // own view of the arms wants the trunk turned (with the grip in front of the
    // chest, the trail arm reads 91 of 198 vertices hidden at 0 and 26 at 0.2),
    // and the set's own stance wants it still facing mostly away from him
    // (0.38 turns it to 69.5° off his line, where the set no longer reads as a
    // set). At 0.2 the swing unwinds back to -89.7° and lands there with -87.1° at
    // nine tenths of the way home.
    stanceArmFacing: 0.2,
    hipsLead: 2.6,
    bodyTurnLead: 1.15,
    headTrackTiltDown: 0.55,
    headTrackTiltUp: 1.2,
    legBackKneeRise: 0.28,
    legFrontKneeRise: 0.06,
    legBackLoadDrop: 0.05,
    hipSettle: 0.06,
    legBackKneeForward: 0.04,
    legFrontKneeForward: 0.01,
    legBackPushForward: 0.05,
    legFrontPushForward: 0.02,
    legFrontStride: 0.24,
    // Fraction of the pitcher's windup that plays before the batter's front
    // leg starts its step (0 = step the moment the windup starts, 1 = step
    // only at release). The delayed step plants into the swing.
    strideDelayFrac: 0.72,
    legFrontStrideLift: 0.07,
    legFrontKneeLift: 0.08,
    // How far the *lead* foot comes off the ground once the swing fires. It is 0, and
    // the rule behind the number is the one a batter's lead foot follows: the heel is
    // on the floor from the plant through the follow-through, and what the foot does
    // is *pivot* on it, opening with the body. The lift used to be 0.08 — the whole
    // shoe off the ground for the length of the drive, heel first — which read as a
    // batter stepping out of his own swing rather than turning on a planted foot.
    // What is left of it is the *step* (legFrontStrideLift above), which is a lift
    // into the plant, and the toe lift below, which is a lift with the heel down.
    legFrontUnplantLift: 0.03,
    backFootPivot: 0.75,
    // How much of the body's own turn the lead foot takes. At 1 the shoe's yaw is the
    // hips' own, so the foot pivots open with the body it is standing under rather
    // than holding its set angle while the batter turns over it (0.2, which left the
    // shoe pointing 80% of the way to the set all swing long).
    frontFootPivot: 1,
    // ...and how far the lead foot's toes lift as the swing arrives: the foot tips up
    // about its own ankle through the follow-through, so the toe end points up out of
    // the ground while the heel — the end that is left standing on it — takes the
    // weight. Radians, and "slightly" is the point: this is the finish of a swing, not
    // a kick. Measured at 0.18 rad, the shoe's toe comes up about 1.5 cm off the dirt
    // with the heel still on it.
    legFrontToeLift: 0.18,
    hipDriveForward: 0.442, // 15% below the last pass (0.52)
    swingBackTilt: 0.08,
    upperDriveForward: 0.32,
    // Fraction of the full drive the hips and upper body edge forward as the
    // delayed front step begins (30%: a clear forward ride with the foot),
    // blending into the swing's own gradual ride-up so the lunge launches
    // from an already-moving body instead of a choppy speed jump.
    strideEdgeFrac: 0.3,
    // Where in the swing phase (plant -> settle start) the body's forward
    // speed peaks (0 = auto: scales with pitch speed so faster pitches peak
    // later closer to contact, e.g. ~0.60 on 70 mph up to ~0.855 on 104 mph).
    // Manual values > 0 override the auto behavior. 0.5 = mid-swing; higher
    // pushes the peak later, so the maximal surge lands closer to contact.
    swingPeakFrac: 0,
    // Where, through the post-contact return arc (contact -> stance), the
    // body's backward speed peaks. Higher pushes the peak of the return
    // motion closer to the end of recovery, so the body holds its extended
    // posture longer before flowing back; the whole arc is one continuous
    // motion either way — no hold, no separate ease-out stage.
    returnPeakFrac: 0.6,
    // How long the last pre-contact push takes to snap from full drive down
    // to the settle level (1 -> pushSettleLevel, landing exactly at contact).
    // Short: a decisive "snap into the ball" arrival; long: a gradual ease.
    pushSettleTime: 0.035,
    pushSettleLevel: 0.65,
    legLean: 0.3,
    setLean: 0.3,
    leanOutTime: 0.3,
    // The set, in the two beats a batter's own set has: he leans in, and *from that
    // leaned-in pose* shifts his weight onto the back leg. Both leads are "at least
    // this early" and both come off the end of the windup (see Batter.jsx):
    //
    //   leanLead: how long before the pitcher's release the forward lean-in is already
    //   complete — the split second of the batter standing leaned in while the ball is
    //   still in the pitcher's hand. At 0 the lean arrives on the very frame the ball
    //   leaves the hand, with no hold at all.
    //
    //   loadLead: how long before that release the weight shift onto the back leg is
    //   complete — the batter coiled and *waiting* as the arm comes through. The coil
    //   opens on the frame the lean lands, so it is the one the lean's own ramp is
    //   aimed at: the lean can never be complete later than loadTime + loadLead before
    //   the release, or the coil would have to start before the batter had leaned in.
    //
    // At 0 for anyone, the set arrives on the release frame itself.
    //
    // 0.45 rather than 0.12: the whole set — the lean in *and* the weight shift that
    // opens from it — is finished a quarter of a second before the ball leaves the
    // pitcher's hand, so the batter is standing in his coil and waiting on the pitch
    // rather than arriving at it as the arm comes through. The ramp is front-loaded
    // too (see the lean's own clock in Batter.jsx), so the lean is taken in the first
    // part of the windup and held, and the coil then opens with a beat of its own
    // before the release. It is the same clock the pitcher's hand runs on, read off
    // the end of the windup, so this is the whole of the "already set" promise.
    leanLead: 0.45,
    loadLead: 0.08,
    loadLeanBack: 0.08,
    backRecoverLag: 0.35,
    // How late the torso may start its turn back to the set stance, as a
    // fraction of recoveryTime. 0 means it unwinds with the shoulders and the
    // arms — one motion, in the order the chain fired. A late torso leaves the
    // arms and the bat folding across a chest that is still turned to the pull
    // side, which reads as the shoulders twisting off the torso.
    torsoRecoverLag: 0,
    // How far the hands reach from the front of the torso toward the ball, as a
    // share of the way there. It is what holds the *arms* at the pose they were
    // tuned at while the bat takes up the rest of the distance: the batter
    // stands 0.10 m further back from the plate than it used to (see
    // STANCE_SETBACK_M in Batter.jsx), so the ball is that much further from the
    // body, and a share tuned for the old distance carries the hands out after
    // it — the trail arm stretches to its own span at contact, its palm coming
    // 2.6 mm off the handle against a 1 mm bound. At 0.274 the hands sit the same
    // 0.355 rig in front of the torso at contact as they always did, and the bat
    // takes the 0.13 rig of extra distance instead (0.967 -> 1.103 rig).
    //
    // It is also the whole of the *arm*'s share of a drive the rear leg cannot
    // span: the drive is bounded by the planted rear foot's footprint (see the
    // rear-foot block in Batter.jsx), which shortens the ride, which moves the
    // ball the same distance further from the hands. That distance is split here
    // — the share the hands take on top of their set reach, and the rest the bat
    // takes — so the arms stay inside their own span (ARM_STRETCH_MAX) and the
    // bat is left to cover the rest.
    handExtension: 0.05,
    handsPathBulge: 0.3,
    contactTiltMaxDeg: 20,
    planeTiltMaxDeg: 50,
  },
};

const cloneTuning = (value) => Object.fromEntries(
  Object.entries(value).map(([group, values]) => [group, { ...values }]),
);

const clampTuningValue = (group, key, value) => {
  if (group === 'playback' && ['timeScale', 'ballReleaseTime'].includes(key)) return Math.max(0.001, value);
  if (group === 'camera' && key === 'minHeight') return Math.max(0.1, value);
  if (group === 'pitcher' && ['clipDuration', 'neutralClipDuration'].includes(key)) return Math.max(0.001, value);
  if (group === 'pitcher' && key === 'crossfadeTime') return Math.max(0, value);
  if (group === 'pitch' && ['trailSampleStep', 'trailFadeTime', 'whiteTraceFadeTime', 'billowSpawnSpan', 'billowLife', 'ringPulseTime', 'ringSettleTime', 'ringFadeTime', 'ringSpikeDriftFade', 'ringSpikeFade', 'ringLingerLife', 'ringLingerSpawnSpan', 'ringLingerFadeIn', 'smokeLife', 'smokeSpawnSpan', 'smokeFadeIn', 'rippleLife', 'emberLife', 'emberSpawnSpan', 'emberFadeIn', 'emberScatterTime', 'emberPopRate', 'emberGlowFalloff', 'burnRingFadeTime', 'burnRingFlickerSpeed', 'burnTrailStep', 'ringFlickerSpeed', 'smokeWarmFalloff', 'burnRingFlameSpeed', 'burnShimmerSpeed', 'burnSparkLife', 'burnSparkScale', 'impactFireSpread', 'impactFireScale', 'burnIgniteRate'].includes(key)) return Math.max(0.001, value);
  if (group === 'pitch' && ['smokeWhiteR', 'smokeWhiteG', 'smokeWhiteB', 'smokeRedR', 'smokeRedG', 'smokeRedB', 'smokeGreyR', 'smokeGreyG', 'smokeGreyB', 'smokeBlackR', 'smokeBlackG', 'smokeBlackB', 'smokeWhiteShare', 'smokeWhiteWindow', 'smokeRedShare', 'smokeWhiteLuminanceThreshold', 'smokeWhiteOpacityShrink', 'smokeWarmAmount', 'zoneHeatTint', 'emberGlowAmount', 'emberGlowJitter', 'emberGlowAmountJitter', 'lingerPulseAmount', 'burnRingStartFraction', 'burnRingFlickerAmount', 'burnRingGlowAmount', 'burnRingFlameAmount', 'burnRingAxisBias', 'ballHeatTint', 'burnShimmerOpacity', 'ringHoldTime', 'impactFireOpacity', 'burnCrimsonGlow'].includes(key)) return Math.min(1, Math.max(0, value));
  if (group === 'pitch' && key === 'ringLingerWidth') return Math.max(0.001, value);
  if (group === 'pitch' && ['smokeRedWindowTop', 'smokeGreyBlackPower', 'smokeToneBoostMax', 'smokeWhiteBoost'].includes(key)) return Math.max(0, value);
  if (group === 'battedBall' && ['throwSpeedMph', 'maxRunSpeedMph', 'trailFadeTime', 'traceFadeTime'].includes(key)) return Math.max(0.001, value);
  if (group === 'battedBall' && key === 'groundRollSpeedMph') return Math.max(0, value);
  if (group === 'batter' && ['fadeEndDistance', 'swingLead', 'followThrough', 'followHold', 'recoveryTime', 'loadTime', 'pushSettleTime', 'leanOutTime', 'leanLead', 'loadLead'].includes(key)) return Math.max(0, value);
  if (group === 'batter' && key === 'swingPeakFrac') return value <= 0 ? 0 : Math.min(0.95, Math.max(0.05, value));
  if (group === 'batter' && key === 'returnPeakFrac') return Math.min(0.85, Math.max(0.15, value));
  return value;
};

export const mergeTuning = (saved) => {
  const merged = cloneTuning(DEFAULT_TUNING);
  if (!saved || typeof saved !== 'object') return merged;
  for (const [group, values] of Object.entries(merged)) {
    if (!saved[group] || typeof saved[group] !== 'object') continue;
    for (const key of Object.keys(values)) {
      const next = Number(saved[group][key]);
      if (Number.isFinite(next)) merged[group][key] = clampTuningValue(group, key, next);
    }
  }
  // Sanitize: if comparison mode previously leaked COMPARE_PLAYBACK_SPEED (0.2)
  // into saved tuning, revert it to the default timeScale (0.61) so normal playback
  // speed is never permanently stuck in 5x slow-mo.
  if (merged.playback && Math.abs(merged.playback.timeScale - 0.2) < 0.001) {
    merged.playback.timeScale = DEFAULT_TUNING.playback.timeScale;
  }
  return merged;
};

const loadTuning = () => {
  if (typeof window === 'undefined') return cloneTuning(DEFAULT_TUNING);
  try {
    return mergeTuning(JSON.parse(window.localStorage.getItem(TUNING_STORAGE_KEY)));
  } catch {
    return cloneTuning(DEFAULT_TUNING);
  }
};

let currentTuning = loadTuning();
const listeners = new Set();

const publish = ({ persist = true } = {}) => {
  for (const listener of listeners) listener();
  if (persist && typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(TUNING_STORAGE_KEY, JSON.stringify(currentTuning));
    } catch {
      // The in-memory tuning still works when storage is unavailable.
    }
  }
};

export const getTuning = () => currentTuning;

export const subscribeTuning = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useTuning = () => useSyncExternalStore(
  subscribeTuning,
  getTuning,
  getTuning,
);

export const setTuningValue = (group, key, value, { persist = true } = {}) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || !currentTuning[group] || !(key in currentTuning[group])) return;
  currentTuning = {
    ...currentTuning,
    [group]: { ...currentTuning[group], [key]: clampTuningValue(group, key, numeric) },
  };
  publish({ persist });
};

export const saveTuningAsDefault = () => {
  publish();
};

export const resetTuning = () => {
  currentTuning = cloneTuning(DEFAULT_TUNING);
  publish();
};

export const tuningValue = (group, key, fallback) => (
  currentTuning[group]?.[key] ?? fallback
);
