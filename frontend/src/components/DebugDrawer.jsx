import React, { useMemo, useState } from 'react';
import { DEFAULT_TUNING, getTuning, resetTuning, saveTuningAsDefault, setTuningValue, useTuning } from '../constants/tuning';

const GROUP_LABELS = {
  playback: 'Playback',
  pitch: 'Pitch Effects',
  battedBall: 'Batted Ball',
  batter: 'Batter',
};

const GROUP_ORDER = ['playback', 'pitch', 'battedBall', 'batter'];

const CONTROL_META = {
  playback: {
    timeScale: ['Simulation speed', 0.05, 1, 0.01, '×'],
    cyclePause: ['Cycle pause', 0, 2, 0.01, 's'],
    ballReleaseTime: ['Ball release time', 0.25, 2.5, 0.01, 's'],
  },
  pitch: {
    spinSpeedScale: ['Spin visual scale', 0, 1, 0.01, '×'],
    trailSampleStep: ['Trail sample step', 0.00005, 0.002, 0.00005, 's'],
    trailLeadScale: ['Trail lead size', 0.005, 0.3, 0.005, 'm'],
    trailParticleScale: ['Trail particle size', 0.001, 0.2, 0.001, 'm'],
    overlayBallOpacity: ['Overlay ball opacity', 0, 1, 0.01, ''],
    overlayTrailFactor: ['Overlay trail factor', 0, 1, 0.01, '×'],
    overlayTraceFactor: ['Overlay trace factor', 0, 1, 0.01, '×'],
    trailFadeTime: ['Trail fade time', 0.01, 1, 0.01, 's'],
    trailMaxOpacity: ['Trail opacity', 0, 1, 0.01, ''],
    densityMinMph: ['Trail density min speed', 40, 110, 1, 'mph'],
    densityMaxMph: ['Trail density max speed', 40, 130, 1, 'mph'],
    densityMinFraction: ['Trail density floor', 0, 1, 0.01, '×'],
    densityMaxFraction: ['Trail density ceiling', 0, 1, 0.01, '×'],
    whiteTraceScale: ['White trace size', 0.001, 0.08, 0.001, 'm'],
    whiteTraceOpacity: ['White trace opacity', 0, 1, 0.01, ''],
    whiteTraceMinOpacity: ['White trace minimum', 0, 1, 0.01, ''],
    whiteTraceFadeTime: ['White trace fade time', 0.01, 2, 0.01, 's'],
    billowCount: ['Billow count', 0, 32, 1, ''],
    billowStartFraction: ['Billow start fraction', 0, 1, 0.01, '×'],
    billowSpawnSpan: ['Billow spawn span', 0.01, 2, 0.01, 's'],
    billowSpawnBehind: ['Billow spawn offset', 0, 0.2, 0.001, 's'],
    billowLife: ['Billow lifetime', 0.01, 2, 0.01, 's'],
    billowFadeIn: ['Billow fade-in', 0, 0.5, 0.01, 's'],
    billowSpread: ['Billow spread', 0, 5, 0.05, 'm/s'],
    billowBackDrift: ['Billow back drift', 0, 3, 0.05, 'm/s'],
    billowBaseScale: ['Billow size', 0.005, 0.25, 0.005, 'm'],
    billowScaleGrowth: ['Billow growth', 0, 10, 0.1, '×/s'],
    billowOpacity: ['Billow opacity', 0, 1.5, 0.01, ''],
    whiteBillowCount: ['White billow base count', 0, 16, 1, ''],
    whiteBillowCountMax: ['White billow max count', 1, 16, 1, ''],
    whiteBillowThresholdMph: ['White wake threshold', 40, 110, 1, 'mph'],
    whiteBillowMinMultiplier: ['White wake minimum', 0, 1, 0.01, '×'],
    whiteBillowMaxMultiplier: ['White wake maximum', 0, 2, 0.01, '×'],
    goldSparkThresholdMph: ['Gold spark threshold', 70, 120, 1, 'mph'],
    goldSparkCount: ['Gold spark count', 0, 16, 1, ''],
    goldRingThresholdMph: ['Gold ring threshold', 70, 130, 1, 'mph'],
    ringPulseTime: ['Ring pulse time', 0.01, 2, 0.01, 's'],
    ringSettleTime: ['Ring settle time', 0.01, 3, 0.01, 's'],
    ringFadeTime: ['Ring fade time', 0.01, 2, 0.01, 's'],
    ringPulseOvershoot: ['Ring pulse overshoot', 0, 3, 0.01, '×'],
    ringMaxOpacity: ['Ring peak opacity', 0, 1.5, 0.01, ''],
    ringSettledOpacity: ['Ring settled opacity', 0, 1, 0.01, ''],
    ringSpikeCount: ['Impact spike count', 0, 32, 1, ''],
    ringSpikeOpacity: ['Spike opacity', 0, 1.5, 0.01, ''],
    ringSpikeBurstFactor: ['Spike burst distance', 0, 2, 0.01, '× radius'],
    ringSpikeDriftSpeed: ['Spike drift speed', 0, 2, 0.01, 'm/s'],
    ringSpikeDriftFade: ['Spike drift fade', 0.01, 4, 0.01, 's'],
    ringSpikeExpandSpeed: ['100+ spike expansion', 0, 3, 0.01, 'm/s'],
    ringSpikeFade: ['100+ spike fade', 0.01, 2, 0.01, 's'],
    ringLingerCount: ['Linger particle count', 0, 32, 1, ''],
    ringLingerLife: ['Linger lifetime', 0.01, 3, 0.01, 's'],
    ringLingerOpacity: ['Linger opacity', 0, 1.5, 0.01, ''],
    ringLingerWidth: ['Linger beam width', 0.001, 0.05, 0.001, 'm'],
    ringLingerSpawnSpan: ['Linger spawn span', 0.01, 2, 0.01, 's'],
    ringLingerFadeIn: ['Linger fade-in', 0, 1, 0.01, 's'],
    ringLingerLateAt: ['Linger thinning time', 0, 3, 0.01, 's'],
    ringLingerLateFraction: ['Linger late fraction', 0, 1, 0.01, '×'],
    smokeCount: ['Smoke particle count', 0, 16, 1, ''],
    smokeLife: ['Smoke lifetime', 0.01, 3, 0.01, 's'],
    smokeSpawnSpan: ['Smoke spawn span', 0.01, 2, 0.01, 's'],
    smokeFadeIn: ['Smoke fade-in', 0, 1, 0.01, 's'],
    smokeBaseScale: ['Smoke size', 0.001, 0.2, 0.001, 'm'],
    smokeScaleGrowth: ['Smoke growth', 0, 4, 0.01, '×'],
    smokeGrowthFade: ['Smoke growth fade', 0, 10, 0.1, '×'],
    smokeOpacity: ['Smoke opacity', 0, 2, 0.01, ''],
    smokeWhiteR: ['Smoke white red channel', 0, 1, 0.01, ''],
    smokeWhiteG: ['Smoke white green channel', 0, 1, 0.01, ''],
    smokeWhiteB: ['Smoke white blue channel', 0, 1, 0.01, ''],
    smokeRedR: ['Smoke red red channel', 0, 1, 0.01, ''],
    smokeRedG: ['Smoke red green channel', 0, 1, 0.01, ''],
    smokeRedB: ['Smoke red blue channel', 0, 1, 0.01, ''],
    smokeGreyR: ['Smoke grey red channel', 0, 1, 0.01, ''],
    smokeGreyG: ['Smoke grey green channel', 0, 1, 0.01, ''],
    smokeGreyB: ['Smoke grey blue channel', 0, 1, 0.01, ''],
    smokeBlackR: ['Smoke black red channel', 0, 1, 0.01, ''],
    smokeBlackG: ['Smoke black green channel', 0, 1, 0.01, ''],
    smokeBlackB: ['Smoke black blue channel', 0, 1, 0.01, ''],
    smokeWhiteShare: ['White smoke share', 0, 1, 0.01, '×'],
    smokeWhiteWindow: ['White smoke color window', 0, 1, 0.01, '×'],
    smokeRedShare: ['Red smoke share', 0, 1, 0.01, '×'],
    smokeRedWindowTop: ['Red smoke window top', 0.15, 2.9, 0.01, '×'],
    smokeGreyBlackPower: ['Grey-black weighting', 0.1, 8, 0.1, '×'],
    smokeWhiteLuminanceThreshold: ['White puff threshold', 0, 1, 0.01, '×'],
    smokeToneBoostMax: ['White tone boost range', 0, 2, 0.01, '×'],
    smokeWhiteBoost: ['White plume boost', 0, 2, 0.01, '×'],
    smokeWhiteOpacityShrink: ['White puff size shrink', 0, 1, 0.01, '×'],
    smokePerimeterSpread: ['Smoke perimeter spread', 0, 1, 0.01, '×'],
    smokeDriftMin: ['Smoke drift minimum', 0, 1, 0.01, 'm/s'],
    smokeDriftMax: ['Smoke drift maximum', 0, 1, 0.01, 'm/s'],
    smokeRiseMin: ['Smoke rise minimum', 0, 1, 0.01, 'm/s'],
    smokeRiseMax: ['Smoke rise maximum', 0, 1, 0.01, 'm/s'],
    smokeSwaySpeedMin: ['Smoke sway minimum', 0, 15, 0.1, 'rad/s'],
    smokeSwaySpeedMax: ['Smoke sway maximum', 0, 15, 0.1, 'rad/s'],
    smokeSwayAmplitudeMin: ['Smoke sway amplitude min', 0, 0.2, 0.005, 'm'],
    smokeSwayAmplitudeMax: ['Smoke sway amplitude max', 0, 0.2, 0.005, 'm'],
    rippleLife: ['Ripple lifetime', 0.01, 2, 0.01, 's'],
    rippleMaxScale: ['Ripple max scale', 1, 8, 0.05, '×'],
    rippleOpacity: ['Ripple opacity', 0, 1.5, 0.01, ''],
    rippleWidth: ['Ripple width', 0.001, 0.1, 0.001, 'm'],
    emberCount: ['Ember particle count', 0, 16, 1, ''],
    emberLife: ['Ember lifetime', 0.01, 3, 0.01, 's'],
    emberOpacity: ['Ember opacity', 0, 1.5, 0.01, ''],
    emberBaseScale: ['Ember size', 0.001, 0.05, 0.001, 'm'],
    emberSpawnSpan: ['Ember spawn span', 0.01, 2, 0.01, 's'],
    emberFadeIn: ['Ember fade-in', 0, 1, 0.01, 's'],
    emberRiseSpeed: ['Ember rise speed', 0, 1, 0.01, 'm/s'],
    emberDriftSpeed: ['Ember drift speed', 0, 0.5, 0.01, 'm/s'],
    emberTwinkleSpeed: ['Ember twinkle speed', 0, 40, 0.5, 'rad/s'],
    emberScatterSpeed: ['Ember scatter distance', 0, 0.2, 0.001, 'm'],
    emberScatterTime: ['Ember scatter time', 0.01, 1, 0.01, 's'],
    emberPopAmount: ['Ember birth pop size', 0, 4, 0.05, '×'],
    emberPopOpacity: ['Ember birth pop glow', 0, 4, 0.05, '×'],
    emberPopRate: ['Ember pop decay rate', 0.5, 60, 0.5, '1/s'],
    emberGlowAmount: ['Ember ring-glow amount', 0, 1, 0.01, '×'],
    emberGlowFalloff: ['Ember ring-glow falloff', 0.1, 8, 0.1, '×'],
    emberGlowJitter: ['Ember glow color jitter', 0, 1, 0.01, '×'],
    emberGlowAmountJitter: ['Ember glow amount jitter', 0, 1, 0.01, '×'],
    lingerPulseAmount: ['Linger pulse with flicker', 0, 1, 0.01, '×'],
    smokeWarmAmount: ['Smoke ring-glow amount', 0, 1, 0.01, '×'],
    smokeWarmFalloff: ['Smoke ring-glow falloff', 0.1, 8, 0.1, '×'],
    zoneHeatTint: ['Zone line heat tint', 0, 1, 0.01, '×'],
    burnRingStartFraction: ['Burn ring start fraction', 0, 1, 0.01, '×'],
    burnRingFadeTime: ['Burn ring fade-in', 0.01, 1, 0.01, 's'],
    burnRingOpacity: ['Burn ring opacity', 0, 2, 0.01, ''],
    burnRingFlickerSpeed: ['Burn ring flicker speed', 0.5, 60, 0.5, 'rad/s'],
    burnRingFlickerAmount: ['Burn ring flicker amount', 0, 1, 0.01, '×'],
    burnRingGlowAmount: ['Burn ring halo amount', 0, 1, 0.01, '×'],
    burnRingFlameAmount: ['Burn halo flame amount', 0, 1, 0.01, '×'],
    burnRingFlameSpeed: ['Burn halo flame speed', 1, 60, 0.5, 'rad/s'],
    burnRingAxisBias: ['Burn halo spin-axis bias', 0, 1, 0.01, '×'],
    burnIgniteAmount: ['Ignition surge amount', 0, 2, 0.01, '×'],
    burnIgniteRate: ['Ignition surge decay', 1, 40, 0.5, '1/s'],
    burnCrimsonGlow: ['Ball crimson flare', 0, 1, 0.01, '×'],
    ballHeatTint: ['Ball heat tint', 0, 1, 0.01, '×'],
    burnShimmerOpacity: ['Heat shimmer opacity', 0, 1, 0.01, '×'],
    burnShimmerSpeed: ['Heat shimmer speed', 0.5, 40, 0.5, 'rad/s'],
    burnSparkCount: ['Burn spark count', 0, 32, 1, ''],
    burnSparkLife: ['Burn spark life', 0.02, 1, 0.01, 's'],
    burnSparkOpacity: ['Burn spark opacity', 0, 2, 0.01, ''],
    burnSparkScale: ['Burn spark size', 0.005, 0.06, 0.001, 'm'],
    impactFireOpacity: ['Impact fire opacity', 0, 2, 0.01, ''],
    impactFireSpread: ['Impact fire spread', 0.02, 0.6, 0.01, 'm'],
    impactFireScale: ['Impact fire size', 0.02, 0.2, 0.001, 'm'],
    ringHoldTime: ['Ring white-hot hold', 0, 0.5, 0.01, 's'],
    burnTrailCount: ['Burn trail glint count', 0, 32, 1, ''],
    burnTrailStep: ['Burn trail glint spacing', 0.002, 0.05, 0.002, 's'],
    burnTrailOpacity: ['Burn trail opacity', 0, 2, 0.01, ''],
    burnTrailScale: ['Burn trail glint size', 0.005, 0.08, 0.001, 'm'],
    ringFlickerSpeed: ['Ring flicker speed', 0, 20, 0.1, 'rad/s'],
    ringFlickerDepth: ['Ring flicker depth', 0, 1, 0.01, '×'],
  },
  battedBall: {
    throwSpeedMph: ['Throw speed', 20, 110, 1, 'mph'],
    maxRunSpeedMph: ['Fielder run speed', 1, 25, 0.1, 'mph'],
    groundRollSpeedMph: ['Ground roll speed (0=auto)', 0, 80, 1, 'mph'],
    noLaunchTimeoutMs: ['No-fielding-data timeout', 1000, 120000, 500, 'ms'],
    trailFadeTime: ['Hit trail fade time', 0.01, 1, 0.01, 's'],
    trailMaxOpacity: ['Hit trail opacity', 0, 1, 0.01, ''],
    trailLeadScale: ['Hit trail lead size', 0.005, 0.3, 0.005, 'm'],
    trailParticleScale: ['Hit trail particle size', 0.001, 0.2, 0.001, 'm'],
    traceScale: ['Hit trace size', 0.001, 0.1, 0.001, 'm'],
    traceOpacity: ['Hit trace opacity', 0, 1, 0.01, ''],
    traceMinOpacity: ['Hit trace minimum', 0, 1, 0.01, ''],
    traceFadeTime: ['Hit trace fade time', 0.01, 2, 0.01, 's'],
    comparisonBallOpacity: ['Comparison ball opacity', 0, 1, 0.01, ''],
    comparisonTrailFactor: ['Comparison trail factor', 0, 1, 0.01, '×'],
  },
  batter: {
    fadeStartDistance: ['Batter fade start', 0, 20, 0.1, 'm'],
    swaySpeed: ['Idle sway speed', 0, 5, 0.05, 'rad/s'],
    swayBobAmount: ['Idle sway amount', 0, 0.2, 0.005, 'm'],
    fadeEndDistance: ['Batter fade end', 0.1, 30, 0.1, 'm'],
    fadeMinOpacity: ['Batter minimum opacity', 0, 1, 0.01, ''],
    swingLead: ['Swing lead', 0, 1, 0.01, 's'],
    followThrough: ['Follow-through', 0, 1, 0.01, 's'],
    recoveryTime: ['Swing recovery', 0.01, 2, 0.01, 's'],
    loadTime: ['Load time', 0, 1, 0.01, 's'],
    bodyOpenMax: ['Body opening', 0, 2, 0.01, 'rad'],
    fullOpenYaw: ['Full open yaw', -3.14, 3.14, 0.01, 'rad'],
    headTiltMax: ['Contact head tilt', -1, 1, 0.01, 'rad'],
    lowerBodyOpenFactor: ['Lower-body opening', 0, 1.5, 0.01, '×'],
    loadedBaseAngle: ['Loaded bat angle', -6.28, 6.28, 0.01, 'rad'],
    throughBaseAngle: ['Through bat angle', -6.28, 6.28, 0.01, 'rad'],
    cockAngle: ['Bat cock angle', 0, 2, 0.01, 'rad'],
    setFaceBias: ['Set stance face bias', 0, 1, 0.01, '×'],
    hipsLead: ['Hips lead', 0, 5, 0.01, '×'],
    bodyTurnLead: ['Body turn lead', 0, 3, 0.01, '×'],
    headTrackTiltDown: ['Head track down', 0, 1.5, 0.01, 'rad'],
    headTrackTiltUp: ['Head track up', 0, 2, 0.01, 'rad'],
    legBackKneeRise: ['Back knee rise', 0, 0.8, 0.01, 'm'],
    legFrontKneeRise: ['Front knee rise', 0, 0.5, 0.01, 'm'],
    legBackLoadDrop: ['Back load drop', 0, 0.3, 0.01, 'm'],
    hipSettle: ['Hip settle', 0, 0.3, 0.01, 'm'],
    legBackKneeForward: ['Back knee forward', 0, 0.3, 0.01, 'm'],
    legFrontKneeForward: ['Front knee forward', 0, 0.3, 0.01, 'm'],
    legBackPushForward: ['Back push forward', 0, 0.3, 0.01, 'm'],
    legFrontPushForward: ['Front push forward', 0, 0.3, 0.01, 'm'],
    legFrontStride: ['Front stride', 0, 0.8, 0.01, 'm'],
    legFrontStrideLift: ['Stride lift', 0, 0.4, 0.01, 'm'],
    legFrontKneeLift: ['Knee lift', 0, 0.4, 0.01, 'm'],
    legFrontUnplantLift: ['Unplant lift', 0, 0.4, 0.01, 'm'],
    backFootPivot: ['Back foot pivot', 0, 1, 0.01, '×'],
    frontFootPivot: ['Front foot pivot', 0, 1, 0.01, '×'],
    hipDriveForward: ['Hip drive forward', 0, 0.5, 0.01, 'm'],
    swingBackTilt: ['Swing back tilt', 0, 0.6, 0.01, 'rad'],
    upperDriveForward: ['Upper drive forward', 0, 0.4, 0.01, 'm'],
    pushSettleTime: ['Push settle time', 0, 0.5, 0.01, 's'],
    pushSettleLevel: ['Push settle level', 0, 1, 0.01, '×'],
    legLean: ['Swing lean', 0, 1, 0.01, 'rad'],
    setLean: ['Set lean', 0, 1, 0.01, 'rad'],
    leanOutTime: ['Lean out time', 0.01, 2, 0.01, 's'],
    loadLeanBack: ['Load lean back', 0, 0.5, 0.01, 'rad'],
    backRecoverLag: ['Back-leg recovery lag', 0, 1, 0.01, '×'],
    handExtension: ['Hand extension', 0, 1, 0.01, '×'],
    handsPathBulge: ['Hands path bulge', 0, 1, 0.01, 'm'],
    contactTiltMaxDeg: ['Contact tilt clamp', 0, 60, 1, '°'],
    planeTiltMaxDeg: ['Plane tilt clamp', 0, 90, 1, '°'],
  },
};

const formatValue = (value, step, unit) => {
  const decimals = step < 0.001 ? 5 : step < 0.01 ? 4 : step < 0.1 ? 2 : 1;
  const text = Number(value).toFixed(decimals).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
  return `${text}${unit ? ` ${unit}` : ''}`;
};

function SliderRow({ group, name, value }) {
  const meta = CONTROL_META[group]?.[name];
  if (!meta) return null;
  const [label, min, max, step, unit] = meta;
  const numericValue = Number(value);
  const clampedValue = Number.isFinite(numericValue)
    ? Math.min(max, Math.max(min, numericValue))
    : min;
  return (
    <label className="debug-slider-row" title={`${label}: ${formatValue(clampedValue, step, unit)}`}>
      <span className="debug-slider-label">
        <span>{label}</span>
        <output>{formatValue(clampedValue, step, unit)}</output>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={clampedValue}
        onChange={(event) => {
          const next = Number(event.target.value);
          setTuningValue(group, name, Math.min(max, Math.max(min, next)));
        }}
        aria-label={label}
      />
    </label>
  );
}

export function DebugDrawer() {
  const tuning = useTuning();
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState(() => new Set(['playback', 'pitch', 'battedBall', 'batter']));
  const totalControls = useMemo(
    () => GROUP_ORDER.reduce((count, group) => count + Object.keys(tuning[group] ?? {}).length, 0),
    [tuning],
  );

  const exportSettings = () => {
    const blob = new Blob([JSON.stringify(getTuning(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'freebuff-debug-tuning.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const toggleGroup = (group) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

  return (
    <aside className={`debug-drawer ${open ? 'debug-drawer-open' : 'debug-drawer-closed'}`} aria-label="Debug tuning drawer">
      <button
        type="button"
        className="debug-drawer-toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={open ? 'Close debug tuning drawer' : 'Open debug tuning drawer'}
        title={open ? 'Close debug tuning drawer' : 'Open debug tuning drawer'}
      >
        {open ? '×' : '⚙'}
      </button>
      {open && (
        <div className="debug-drawer-panel">
          <header className="debug-drawer-header">
            <div>
              <strong>DEBUG TUNING</strong>
              <span>{totalControls} live sliders</span>
            </div>              <div className="debug-drawer-actions">
                <button
                  type="button"
                  className="debug-save-button"
                  onClick={saveTuningAsDefault}
                  title="Save the current tuning sliders as the default"
                  aria-label="Save current debug tuning as default"
                >
                  Save default
                </button>
                <button
                  type="button"
                  className="debug-export-button"
                  onClick={exportSettings}
                  title="Download the current tuning sliders as JSON"
                  aria-label="Export current debug tuning as JSON"
                >
                  Export JSON
                </button>
                <button
                  type="button"
                  className="debug-reset-button"
                  onClick={resetTuning}
                  title="Restore every tuning slider to its default"
                  aria-label="Reset all debug tuning sliders"
                >
                  ↺
                </button>
              </div>
          </header>
          <div className="debug-drawer-scroll">
            {GROUP_ORDER.map((group) => {
              const values = tuning[group];
              const isExpanded = expanded.has(group);
              return (
                <section className="debug-slider-group" key={group}>
                  <button
                    type="button"
                    className="debug-slider-group-toggle"
                    onClick={() => toggleGroup(group)}
                    aria-expanded={isExpanded}
                  >
                    <span>{GROUP_LABELS[group]}</span>
                    <span>{isExpanded ? '−' : '+'}</span>
                  </button>
                  {isExpanded && (
                    <div className="debug-slider-list">
                      {Object.entries(values).map(([name, value]) => (
                        <SliderRow key={name} group={group} name={name} value={value} />
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        </div>
      )}
    </aside>
  );
}

export { CONTROL_META, DEFAULT_TUNING };
