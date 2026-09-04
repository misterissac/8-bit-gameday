import { useSyncExternalStore } from 'react';

// v12: removed unphysical back foot glide (back foot stays planted in world space);
// versioned so older saved tunings (which merge over the defaults) don't
// silently keep the previous values.
export const TUNING_STORAGE_KEY = 'playbyplay-debug-tuning-v12';

export const DEFAULT_TUNING = {
  playback: {
    timeScale: 0.61,
    cyclePause: 0.6,
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
    clipDuration: 2.08,
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
    swaySpeed: 1.4,
    swayBobAmount: 0.04,
    fadeMinOpacity: 0.2,
    swingLead: 0.22,
    followThrough: 0.14,
    recoveryTime: 0.55,
    loadTime: 0.18,
    bodyOpenMax: 0.4,
    fullOpenYaw: 0,
    headTiltMax: -0.15,
    lowerBodyOpenFactor: 0.9,
    loadedBaseAngle: -3.141592653589793,
    throughBaseAngle: 1.5707963267948966,
    cockAngle: 0.7,
    setFaceBias: 0.35,
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
    legFrontUnplantLift: 0.08,
    backFootPivot: 0.75,
    frontFootPivot: 0.2,
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
    loadLeanBack: 0.08,
    backRecoverLag: 0.35,
    handExtension: 0.35,
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
  if (group === 'batter' && ['fadeEndDistance', 'swingLead', 'followThrough', 'recoveryTime', 'loadTime', 'pushSettleTime', 'leanOutTime'].includes(key)) return Math.max(0.001, value);
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
