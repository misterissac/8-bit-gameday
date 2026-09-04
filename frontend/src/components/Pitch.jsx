import React, { useRef, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Billboard, Line, Text, useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { getCycleDuration, getTimeScale, getBallReleaseTime, stepSimulation } from '../constants/playback';
import { getTuning, useTuning } from '../constants/tuning';
import { impactDistortion, SHOCK_SWEEP_FACTOR } from '../util/impactDistortion';

// Front edge of home plate (17 in from the back tip) and mid-plate (8.5 in),
// in meters along this app's -Z axis. The strike zone is drawn at the front
// edge, and the pitch "arrives at the plate" when it crosses that plane.
const FRONT_OF_PLATE_Z = -0.4318;
const BACK_OF_PLATE_Z = 0; // back tip of home plate (world z)
const MID_PLATE_Z = -(8.5 / 12) * 0.3048; // = -0.2159 m from the back tip

// Particle trail sampling + size. Denser and smaller than solomon-gumball's
// PitchArc (0.02s / 0.15 / 0.05) so the path reads as a fine, continuous
// trajectory rather than a row of chunky boxes. The colored tail and the white
// trajectory trace are each a single InstancedMesh (one draw call each) with
// per-instance color + alpha.
const TRAIL_MAX_PARTICLES = 2048; // fixed instanced capacity (~1s of flight)
// The number of wake particles scales with pitch speed: a 70 mph pitch
// emits 30% of the full count and the density ramps linearly up to 100% at
// 90 mph — so fast pitches leave the densest wake while slow ones leave a
// lighter one. The trail implements this by widening its sample step
// (TRAIL_SAMPLE_STEP / densityFrac) and the yellow→red billow layer by
// emitting fewer particles.
// Shared speed → density ramp for the wake layers (clamps to 30% below
// 70 mph and 100% above 90 mph).
function getSpeedDensityFrac(speed, settings = getTuning().pitch) {
    return THREE.MathUtils.clamp(
        (speed - settings.densityMinMph) / Math.max(0.001, settings.densityMaxMph - settings.densityMinMph),
        settings.densityMinFraction,
        settings.densityMaxFraction,
    );
}

// Speed-graded tail color: the whole tail is a single constant color per
// pitch (no gradient along the flight), picked from a ramp that shifts with
// the pitch's release speed — yellowish-white below TRAIL_SPEED_MIN_MPH, then
// dim yellow at TRAIL_SPEED_MIN_MPH (70 mph) stepping through yellowish-orange
// and orange-red to crimson red at TRAIL_SPEED_MAX_MPH (99 mph), clamped
// beyond. The slow end stays dim so it reads clearly distinct from the golden
// 100 mph elite-fastball ring.
const TRAIL_SPEED_MIN_MPH = 70;
const TRAIL_SPEED_MAX_MPH = 99;
// The speed → color ramp anchors: each stop pins a named color at a release
// speed (mph), and speeds between stops lerp linearly to the next one.
const TRAIL_SPEED_STOPS = [
    { mph: TRAIL_SPEED_MIN_MPH, rgb: [0.7, 0.6, 0.16] },  // dim yellow (distinct from the golden 100 mph ring)
    { mph: 78, rgb: [1, 0.7, 0.12] },                     // yellowish-orange
    { mph: 86, rgb: [1, 0.35, 0.05] },                    // orange-red
    { mph: TRAIL_SPEED_MAX_MPH, rgb: [0.86, 0.08, 0.24] }, // crimson red
];
// Any pitch slower than 70 mph clamps to the ramp's pale start (yellowish-
// white), so offspeed offerings still read as the cool end of the gradient.
const TRAIL_COLOR_YELLOWISH_WHITE = [1, 0.95, 0.65];

// Shared speed → tail-color ramp: lerps across the TRAIL_SPEED_STOPS anchors
// by release speed, clamping below the first and above the last stop. Used by
// both the pitch's trailing tail and the hawk-eye crossing ring, so the ring
// left at the strike zone always matches the tail's color for the same
// velocity.
function speedTrailColor(speed) {
    const stops = TRAIL_SPEED_STOPS;
    const last = stops[stops.length - 1];
    // Below 70 mph clamp to yellowish-white; at/above 70 the ramp starts at
    // the dim yellow stop (so exactly 70 mph yields dim yellow, per the spec).
    if (speed < stops[0].mph) return TRAIL_COLOR_YELLOWISH_WHITE.slice();
    if (speed >= last.mph) return last.rgb.slice();
    for (let i = 1; i < stops.length; i++) {
        const lo = stops[i - 1];
        const hi = stops[i];
        if (speed <= hi.mph) {
            const frac = (speed - lo.mph) / (hi.mph - lo.mph);
            return [
                THREE.MathUtils.lerp(lo.rgb[0], hi.rgb[0], frac),
                THREE.MathUtils.lerp(lo.rgb[1], hi.rgb[1], frac),
                THREE.MathUtils.lerp(lo.rgb[2], hi.rgb[2], frac),
            ];
        }
    }
    return last.rgb.slice();
}

// Comparison overlay: each overlaid pitch's hawk-eye ring gets its pitch type
// anchored just below the crossing spot, so ribbons, rings, and labels read as
// one pitch. The label sits right under the ring (a thin gap below its bottom
// edge), slightly toward the camera so it stays in front of the zone lines.
// Its height is half the ring's outer diameter — i.e. the ring's outer radius
// — scaled down a touch, broadcast-style: plain solid white with no border so
// it reads like a velocity label (e.g. "94 mph") rather than a badge.
const RING_LABEL_GAP = 0.008; // m — gap between the ring's bottom edge and the label
const RING_LABEL_OFFSET_Z = 0.05; // toward the camera
const RING_LABEL_FONT_SCALE = 0.85; // label cap height = this × the ring's outer radius (half its diameter)
// A faint grey border around the glyphs (thin, relative to fontSize) plus bold
// weight keeps the solid white label legible against bright stadium/zone
// backgrounds without the heavy black badge look.
const RING_LABEL_OUTLINE = 0.014; // outline width relative to fontSize
const RING_LABEL_OUTLINE_COLOR = '#9aa3ad'; // muted grey

// A second, thinner white trace the pitch leaves behind it: a round, soft
// ribbon under the colored tail. It fades gradually once the pitch reaches the
// plate, easing down to WHITE_TRACE_MIN_OPACITY so the traced path dims but
// never fully disappears.
const WHITE_TRACE_COLOR = [1, 1, 1];

// Pixelated billow particles kicked up behind the ball as it flies: small
// axis-aligned boxes (a retro "pixel" look) that spawn along the trajectory,
// then billow outward/upward, recede slightly, grow, and fade as they age.
const BILLOW_MAX_COUNT = 32; // fixed instanced capacity for the debug slider
// Spawn each billow particle slightly BEFORE its activation time along the
// trajectory, so it first pops in behind the ball (further back on its path)
// instead of right at the ball's position.

// All pitches emit a layer of white billow particles; the amount scales with
// pitch speed (nearly nothing at slow speeds ramping up to the full layer on
// fast pitches), so velocity reads as a hotter, brighter wake.
const BILLOW_WHITE_MAX_CAPACITY = 16; // fixed instanced capacity for the debug slider
// The white wake is its own layer: fine, additive-blended spark particles
// that glow as they billow. It stays nearly absent below 85 mph
// (BILLOW_WHITE_MIN_MULT) and once the pitch exceeds
// BILLOW_WHITE_THRESHOLD_MPH (85 mph) both the particle count and the alpha
// ramp up to full by 105 mph — so only genuinely fast pitches leave a heavy
// white wake.
const BILLOW_WHITE_JITTER_MIN = 0.95;  // white particles render near full alpha (vs 0.7 base)

// Golden spark layer: emitted only by the fastest pitches (at/over
// GOLD_SPARK_THRESHOLD_MPH, i.e. >= 99 mph), layered on top of the usual
// white/yellow-red billows, so a 99+ mph pitch reads as a distinct golden
// wake. Below the threshold the layer is written with alpha 0, so no stale
// sparks linger.
const GOLD_SPARK_MAX_COUNT = 16; // fixed instanced capacity for the debug slider
// The hawk-eye ring at the strike zone and its spike halo are golden only
// for pitches strictly above this speed (100+ mph club). Below it the ring
// shares the trail's yellow→red color, so only the billows read golden at
// 99–100 mph.
const GOLD_SPARK_COLOR = [1, 0.8, 0.18]; // bright warm gold
// Twinkle: each spark flickers on its own per-particle phase. Depth is lower
// than the old blue sparks so the golden stays bright instead of dipping dark.
const GOLD_SPARK_TWINKLE_SPEED = 30; // rad/s — fast sparkle
const GOLD_SPARK_TWINKLE_DEPTH = 0.28; // alpha swing around the base
const GOLD_SPARK_TWINKLE_PHASE = 2.4; // per-particle phase spread

// Billow color is graded by the pitch's release speed: yellow at SPEED_MIN_MPH
// lerping to red at SPEED_MAX_MPH.
const SPEED_COLOR_SLOW = [1, 0.85, 0.2];
const SPEED_COLOR_FAST = [1, 0.12, 0.04];
const SPEED_MIN_MPH = 70;
const SPEED_MAX_MPH = 105;

// Custom shader for the instanced trail: each instance supplies its own color
// and alpha. ``instanceMatrix`` is declared automatically because three.js
// defines USE_INSTANCING for ShaderMaterial on an InstancedMesh.
const TRAIL_VERTEX_SHADER = `
attribute vec3 aColor;
attribute float aAlpha;
varying vec3 vColor;
varying float vAlpha;

void main() {
    vColor = aColor;
    vAlpha = aAlpha;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;

const TRAIL_FRAGMENT_SHADER = `
varying vec3 vColor;
varying float vAlpha;

void main() {
    gl_FragColor = vec4(vColor, vAlpha);
}
`;

// Shared builder for the instanced trail geometry: a base shape plus
// per-instance color/alpha buffers. The colored tail uses a box and the white
// trace uses a sphere (rounder, so it reads as a soft ribbon rather than a
// square tube); each layer gets its own buffers so they can fade independently.
function createTrailGeometry(makeBaseGeometry) {
    const geometry = makeBaseGeometry();
    const colorAttr = new THREE.InstancedBufferAttribute(
        new Float32Array(TRAIL_MAX_PARTICLES * 3), 3,
    );
    colorAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aColor', colorAttr);
    const alphaAttr = new THREE.InstancedBufferAttribute(
        new Float32Array(TRAIL_MAX_PARTICLES), 1,
    );
    alphaAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aAlpha', alphaAttr);
    return geometry;
}

// Shared material builder for the instanced trail layers.
function createTrailMaterial() {
    return new THREE.ShaderMaterial({
        vertexShader: TRAIL_VERTEX_SHADER,
        fragmentShader: TRAIL_FRAGMENT_SHADER,
        transparent: true,
        depthWrite: false,
    });
}

// Shared builders for the billow particle layers: per-pitch random seeds
// (delay spread across the last third of the flight, random billow
// direction, size/alpha jitter) plus their spawn points sampled along the
// trajectory.
function makeBillowSeeds(count, flightDuration, settings = getTuning().pitch) {
    const seeds = [];
    const span = Math.min(settings.billowSpawnSpan, Math.max(flightDuration, 0.01));
    for (let i = 0; i < count; i++) {
        const frac = count > 1 ? i / (count - 1) : 0;
        // Map the 0..1 spread onto the last third of the flight so nothing
        // emits until the ball is 2/3 of the way to home plate.
        const delayFrac = settings.billowStartFraction + (1 - settings.billowStartFraction) * frac;
        const ang = Math.random() * Math.PI * 2;
        const spread = 0.35 + Math.random() * 0.65;
        seeds.push({
            delay: delayFrac * span,
            dx: Math.cos(ang) * spread,
            dy: Math.sin(ang) * spread * 0.7 + 0.3,
            jitter: 0.8 + Math.random() * 0.4,
            alphaJitter: 0.7 + Math.random() * 0.3,
        });
    }
    return seeds;
}

function makeBillowSpawns(trajectoryData, seeds, settings = getTuning().pitch) {
    if (!trajectoryData || trajectoryData.length === 0) return [];
    // Sample slightly before each seed's activation time so the particle first
    // appears behind the ball rather than right at its current position.
    return seeds.map((seed) => sampleTrajectoryAtTime(trajectoryData, seed.delay - settings.billowSpawnBehind));
}

// Write one billow layer's per-instance transforms, alphas, and colors for the
// current sim time. `alphaMultiplier` hides the layer (0) without leaving
// stale particles on screen (used for the white layer on slow pitches). `opts`
// overrides the shared billow look (size/growth/opacity/spread) for layers
// like the golden 100+ mph sparks that want a finer, quicker sparkle.
function writeBillowLayer(mesh, geometry, seeds, spawns, simTime, color, dummy, alphaMultiplier = 1, opts = {}) {
    const settings = getTuning().pitch;
    const {
        baseScale = settings.billowBaseScale,
        scaleGrowth = settings.billowScaleGrowth,
        opacity = settings.billowOpacity,
        spread = settings.billowSpread,
        backDrift = settings.billowBackDrift,
        life = settings.billowLife,
        fadeInTime = settings.billowFadeIn,
        limit = spawns.length,
        alphaJitterMin = 0.7,
        // Per-particle flicker for layers like the golden sparks: each instance
        // pulses on its own sine phase so the layer sparkles instead of
        // holding steady. depth 0..1 scales the swing; 0 disables it.
        twinkle = null,
    } = opts;
    const colorAttr = geometry.getAttribute('aColor');
    const alphaAttr = geometry.getAttribute('aAlpha');
    const colors = colorAttr.array;
    const alphas = alphaAttr.array;

    // `limit` lets a layer emit fewer particles than its capacity (the rest
    // stay hidden at alpha 0) — used to scale the emitted count with pitch
    // speed (see getSpeedDensityFrac) and to let the golden spark layer take
    // over the white wake above 99 mph instead of stacking them.
    const active = Math.min(limit, spawns.length);

    for (let i = 0; i < spawns.length; i++) {
        const seed = seeds[i];
        const age = simTime - seed.delay;
        alphas[i] = 0;
        if (i >= active) continue;
        if (age < 0) continue;
        const ageP = age / Math.max(0.001, life);
        if (ageP >= 1) continue;

        const fadeIn = Math.min(age / Math.max(0.001, fadeInTime), 1);
        const fadeOut = 1 - ageP * ageP * (3 - 2 * ageP); // smoothstep out
        // alphaJitterMin lifts a layer's dimmest particles (the shared seeds
        // jitter alpha down to 0.7) so layers like the white wake stay strong.
        const jitter = Math.max(seed.alphaJitter, alphaJitterMin);
        // Twinkle: flicker the spark's alpha and size on its own sine phase.
        // Defaults to 1 (no-op) so the shared billow layers are unaffected.
        let twinkleFactor = 1;
        if (twinkle) {
            twinkleFactor = 1 - twinkle.depth + twinkle.depth * (
                0.5 + 0.5 * Math.sin(simTime * twinkle.speed + i * twinkle.phase)
            );
        }
        alphas[i] = opacity * fadeIn * fadeOut * jitter * alphaMultiplier * twinkleFactor;

        const spawn = spawns[i];
        dummy.position.set(
            spawn.x + seed.dx * spread * age,
            spawn.y + seed.dy * spread * age,
            spawn.z - backDrift * age,
        );
        // Size rides the twinkle too (at a dampened depth) so sparks visibly
        // pulse rather than only dimming.
        dummy.scale.setScalar(
            baseScale * seed.jitter * (1 + scaleGrowth * age)
            * (1 - 0.25 + 0.25 * twinkleFactor),
        );
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        colors[i * 3] = color[0];
        colors[i * 3 + 1] = color[1];
        colors[i * 3 + 2] = color[2];
    }
    colorAttr.needsUpdate = true;
    alphaAttr.needsUpdate = true;
    mesh.instanceMatrix.needsUpdate = true;
}

// Real baseball model (ported from solomon-gumball's public/assets/ball.glb)
// with the seams spinning around the true spin axis. SPIN_SPEED_SCALE slows
// the true RPM so the seam rotation — and its axis — reads on screen; at full
// speed a 2200 RPM pitch is a featureless blur.
const BALL_MODEL_URL = '/models/ball.glb';
const DEFAULT_SPIN_RATE_RPM = 2000;

// Warm the GLTF cache so the first pitch doesn't suspend for long.
useGLTF.preload(BALL_MODEL_URL);

// The baseball model, cloned so the shared useGLTF cache isn't mutated by the
// per-frame spins (geometry/material stay shared across clones).
const Baseball = React.forwardRef(({ opacity, ...props }, ref) => {
    const { scene } = useGLTF(BALL_MODEL_URL);
    const model = useMemo(() => scene.clone(true), [scene]);
    // Dim the ball for tunneling overlays. The GLTF cache shares materials
    // across clones, so clone each material before mutating transparency /
    // opacity — otherwise the normal pitch ball and the spin-axis panel ball
    // would dim too.
    React.useLayoutEffect(() => {
        const materialInfos = [];
        model.traverse((obj) => {
            if (!obj.isMesh) return;
            const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
            const dimmed = materials.map((mat) => {
                const copy = mat.clone();
                copy.transparent = opacity != null && opacity < 1;
                copy.opacity = opacity ?? 1;
                copy.needsUpdate = true;
                // Remember each clone's pristine color so the burning-ball
                // frame loop can lerp it toward a warm glow and back.
                materialInfos.push({ material: copy, baseColor: copy.color.clone() });
                return copy;
            });
            obj.material = Array.isArray(obj.material) ? dimmed : dimmed[0];
        });
        // Hand the cloned materials to the frame loop (Pitch) so it can tint
        // the ball's surface warm orange while the ring of fire is active.
        model.userData.baseballMaterials = materialInfos;
    }, [model, opacity]);
    return <primitive object={model} ref={ref} {...props} />;
});

// Sample the physics trajectory at the given simulation time by linearly
// interpolating between the surrounding data points. The trajectory points
// carry their own `t` timestamps, so advancing `simTime` through them follows
// the ball's real (non-uniform) speed profile — it decelerates into the plate
// — instead of striding along the path at a constant spatial speed.
function sampleTrajectoryAtTime(trajectoryData, simTime) {
    if (!trajectoryData || trajectoryData.length === 0) return null;

    const first = trajectoryData[0];
    const last = trajectoryData[trajectoryData.length - 1];

    // Clamp to the trajectory's own time domain.
    if (simTime <= first.t) {
        return new THREE.Vector3(first.x, first.z, -first.y);
    }
    if (simTime >= last.t) {
        return new THREE.Vector3(last.x, last.z, -last.y);
    }

    // Binary search for the bracketing samples (the data is time-ordered).
    let lo = 0;
    let hi = trajectoryData.length - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (trajectoryData[mid].t <= simTime) {
            lo = mid;
        } else {
            hi = mid;
        }
    }

    const p1 = trajectoryData[lo];
    const p2 = trajectoryData[hi];
    const span = p2.t - p1.t;
    const frac = span > 0 ? (simTime - p1.t) / span : 0;

    return new THREE.Vector3(
        THREE.MathUtils.lerp(p1.x, p2.x, frac),
        THREE.MathUtils.lerp(p1.z, p2.z, frac),
        THREE.MathUtils.lerp(-p1.y, -p2.y, frac),
    );
}

// Hawk-eye crossing marker: a flat, semi-transparent white ring (a 2D donut)
// in the strike-zone plane at the Statcast-measured crossing spot — the same
// indicator format as solomon-gumball's StrikeZone (RingGeometry with a 2.0 in
// inner and 2.8 in outer radius, DoubleSide). One mesh with one uniform
// material reads as a single object and fades as a whole.
const RING_INNER_RADIUS = (2.0 / 12) * 0.3048; // 2.0 in → m — ring inner radius
const RING_OUTER_RADIUS = (2.8 / 12) * 0.3048; // 2.8 in → m — ring outer radius
// Ring appearance animation: the marker flashes in with a brief scale overshoot
// at the moment the pitch is batted (the impact pulse), then eases gradually
// down to RING_SETTLED_OPACITY — a bit more opaque than the white trace's
// settled level, so the marker stays legible after the fade-out. It holds
// there through the batted-ball flight and eases out when the play replays.
// Ring spikes: short, thin light-beam-like spikes that radiate from the
// hawk-eye ring. On impact they burst outward from the ring like a shockwave,
// then swing upward and drift away while fading — a character level-up effect.
// Gated by the same particles toggle (showBillows) as the trail billows.
const RING_SPIKE_MAX_COUNT = 32;
const RING_SPIKE_RADIUS = RING_INNER_RADIUS; // spikes start at the ring's inner edge
// Beams lance out of the ring's circumference but stop before 2.5× the ring
// radius: their outer tip never passes this distance from the ring center.
const RING_SPIKE_MAX_REACH = RING_OUTER_RADIUS * 2.5;
const RING_SPIKE_COLOR = [1, 0.42, 0.04]; // fallback orange-red beam
const IMPACT_WHITE = [1.5, 1.5, 1.5];    // dazzling white-hot beam (overdriven so additive blooms it)
const IMPACT_YELLOWISH = [1.15, 1.0, 0.6]; // only slightly cooled so beams read white against the fire
// The impact beams are deliberately kept near-white so they stay crisp and
// legible on top of the orange/crimson impact flames, flashing white-hot and
// cooling only faintly toward the beam's tail.
const IMPACT_BEAM_COLOR_STOPS = [IMPACT_WHITE, IMPACT_YELLOWISH];

// Give every impact beam an independent sample along the white → faint yellow
// beam gradient (cooling only slightly), so the beams read white-hot and pop
// against the red-orange impact flames instead of vanishing into them.
function randomImpactBeamColor() {
    const position = Math.random() * (IMPACT_BEAM_COLOR_STOPS.length - 1);
    const index = Math.min(Math.floor(position), IMPACT_BEAM_COLOR_STOPS.length - 2);
    const localT = position - index;
    const from = IMPACT_BEAM_COLOR_STOPS[index];
    const to = IMPACT_BEAM_COLOR_STOPS[index + 1];
    return [
        THREE.MathUtils.lerp(from[0], to[0], localT),
        THREE.MathUtils.lerp(from[1], to[1], localT),
        THREE.MathUtils.lerp(from[2], to[2], localT),
    ];
}

// Lingering beams retain the warmer white → faint-yellow range, matching the
// whiter impact beams so both read as cool white against the fire.
function randomImpactParticleColor() {
    const t = Math.random();
    const from = t < 0.5 ? IMPACT_WHITE : IMPACT_YELLOWISH;
    const to = t < 0.5 ? IMPACT_YELLOWISH : IMPACT_WHITE;
    const localT = (t % 0.5) * 2;
    return [
        THREE.MathUtils.lerp(from[0], to[0], localT),
        THREE.MathUtils.lerp(from[1], to[1], localT),
        THREE.MathUtils.lerp(from[2], to[2], localT),
    ];
}

// Smoke color and sampling controls live in the tuning store so the debug
// drawer can adjust the palette and distribution without changing source.
function randomSmokeColor(settings = getTuning().pitch) {
    const colorStops = [
        [settings.smokeWhiteR, settings.smokeWhiteG, settings.smokeWhiteB],
        [settings.smokeRedR, settings.smokeRedG, settings.smokeRedB],
        [settings.smokeGreyR, settings.smokeGreyG, settings.smokeGreyB],
        [settings.smokeBlackR, settings.smokeBlackG, settings.smokeBlackB],
    ];
    const total = colorStops.length - 1;
    const whiteWindow = THREE.MathUtils.clamp(settings.smokeWhiteWindow, 0, total);
    const redWindowTop = THREE.MathUtils.clamp(
        Math.max(whiteWindow, settings.smokeRedWindowTop),
        whiteWindow,
        total,
    );
    const position = Math.random() < settings.smokeWhiteShare
        ? Math.random() * whiteWindow
        : Math.random() < settings.smokeRedShare
            ? whiteWindow + Math.random() * (redWindowTop - whiteWindow)
            : redWindowTop + Math.pow(Math.random(), Math.max(0.001, settings.smokeGreyBlackPower)) * (total - redWindowTop);
    const index = Math.min(Math.floor(position), total - 1);
    const localT = position - index;
    const from = colorStops[index];
    const to = colorStops[index + 1];
    return [
        THREE.MathUtils.lerp(from[0], to[0], localT),
        THREE.MathUtils.lerp(from[1], to[1], localT),
        THREE.MathUtils.lerp(from[2], to[2], localT),
    ];
}

// Impact burst settings are read from the runtime tuning store in the frame loop.
// 100+ mph ring spikes: thicker, no rotation, expand outward until they fade
const RING_SPIKE_WIDTH_100 = 0.008;   // impact beam thickness (wide enough to read over the fire sheet)
const RING_SPIKE_HEIGHT_100 = 0.0375; // impact beam length (halved; box height along +Y, capped at 2.5× ring radius)
const RING_SPIKE_DEPTH_100 = 0.008;   // impact beam depth
// Lingering particles for 100+ mph: float upward from random ring spots.
// Keep this layer restrained so the impact ring stays readable beneath it.
const RING_LINGER_MAX_COUNT = 32;
const RING_LINGER_HEIGHT = 0.021;     // 30% shorter lingering beam
// After the impact flash, thin the lingering beams so the drift reads sparse:
// keep the full count for the first 0.5s, then emit only a fraction of them.
const RING_LINGER_COLOR = IMPACT_YELLOWISH; // fallback warm impact color

// Small neutral smoke puffs for 100+ mph impacts. Each seed gets a stable
// grey/black-weighted white→red→grey→black color and recycles around the ring
// while drifting upward.
const SMOKE_MAX_COUNT = 16;
// Puffs keep inflating as they age while their tuned opacity boost makes
// bright plumes read distinctly against the darker smoke.
// Smoke spawns only on the ring's perimeter rather than across the inner disk,
// with a small inward spread so the outward drift keeps puffs hugging the ring
// instead of immediately spilling past it.
const SMOKE_START_RADIUS = RING_OUTER_RADIUS;
// Lateral (sideways) drift is kept small; upward rise dominates so the smoke
// climbs faster than it drifts sideways.

// Burning-ball ring: a fierce ring of fire that wraps around the 100+ mph ball
// as it nears the plate, so the pitch reads as burning hot. It fades in around
// the same moment the tail billows start emitting (last third of the flight),
// rides the ball to the zone, and vanishes with it on contact. It's built
// from two concentric rings: a thick bright orange core and a wider, softer
// outer glow halo, both billboarded to always face the camera.
const BURN_RING_INNER_RADIUS = 0.069;  // just outside the ~0.064 m ball model
const BURN_RING_OUTER_RADIUS = 0.088;  // thicker core band (~19 mm) hugging the ball
// Radial fire gradient across the core band: deep crimson at the inner rim
// (the flame's base, hugging the ball) flaring to dazzling fiery orange at
// the outer rim. The orange is overdriven past 1.0 so additive blending
// blooms it into a hot glare.
const BURN_RING_INNER_COLOR = [0.82, 0.06, 0.04]; // deep crimson undertone
const BURN_RING_OUTER_COLOR = [1.35, 0.62, 0.07]; // dazzling fiery orange
const BURN_RING_GLOW_INNER_RADIUS = 0.088;
const BURN_RING_GLOW_OUTER_RADIUS = 0.13; // wide soft halo flaring past the core
const BURN_RING_GLOW_COLOR = [0.8, 0.06, 0.035]; // deep crimson under-glow
// Ignition swell: the halo's radius puffs outward by this fraction of the
// ignition surge excess (surge - 1), so the fire visibly swells as it ignites.
const BURN_RING_SWELL = 0.12;
// The fiery trail's glints widen by this fraction of the surge excess, so
// the whole wake swells with the ring the instant the ball hits the zone.
const BURN_TRAIL_SWELL = 0.45;
// Heat shimmer: a faint, camera-facing disc around the burning ball whose
// scrolling concentric ripples read like air shimmering over hot metal. It
// fakes the heat-haze look procedurally (no framebuffer pass), so it stays
// scoped to the burn ball instead of re-plumbing the whole scene's render.
const BURN_SHIMMER_RADIUS = 0.21; // ~2.6× the ball radius
const BURN_SHIMMER_VERTEX = `
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const BURN_SHIMMER_FRAGMENT = `
uniform float uTime;
uniform float uOpacity;
varying vec2 vUv;
void main() {
    // Radial distance from the disc center (the ball), normalized to the
    // disc's edge.
    vec2 c = vUv - 0.5;
    float d = length(c) * 2.0;
    // Soft disc mask, brightest around the ball and fading to nothing at the
    // disc's edge.
    float disc = smoothstep(0.95, 0.3, d);
    // Concentric heat waves: layered scrolling ripples at different radial
    // frequencies and scroll speeds, with an angular wobble, so the fringe
    // pattern shimmers outward from the ball like heat rising off it.
    float ang = atan(c.y, c.x);
    float w1 = sin(d * 46.0 - uTime * 5.5);
    float w2 = sin(d * 92.0 - uTime * 9.0 + ang * 2.0);
    float w3 = sin(d * 23.0 - uTime * 2.6 + ang * 5.0);
    float shimmer = 0.5 + 0.5 * (w1 * 0.5 + w2 * 0.3 + w3 * 0.2);
    // Faint, warm crimson haze — barely tints what's behind the ball.
    gl_FragColor = vec4(vec3(0.9, 0.15, 0.05), shimmer * disc * uOpacity);
}
`;
// Sparkler sparks: tiny red-orange glints shed radially off the burn ring
// while it flares, like droplets of fire flying off a spinning sparkler.
const BURN_SPARK_MAX_COUNT = 24;
const BURN_SPARK_COLOR_HEAD = [1, 0.65, 0.12]; // dazzling orange spark at birth
const BURN_SPARK_COLOR_TAIL = [0.88, 0.09, 0.04]; // cooling to deep crimson as it dies
// Impact fire burst: a sheet of fire that spreads radially out of the
// strike-zone ring the instant a 100+ mph pitch reaches the zone, like the
// impact igniting the air around the crossing spot. White-hot at birth,
// cooling through orange to deep red as it lances outward.
const IMPACT_FIRE_MAX_COUNT = 28;
// Trailing ember wisps: each fire blob drags short, dimmer, redder echoes
// of itself (positions recomputed from the burst math a few frames behind),
// so the burst reads as a thick flame instead of isolated dots.
const IMPACT_FIRE_WISP_PER_BLOB = 2;
const IMPACT_FIRE_WISP_LAGS = [0.05, 0.1]; // seconds behind the blob
const IMPACT_FIRE_TOTAL = IMPACT_FIRE_MAX_COUNT * (1 + IMPACT_FIRE_WISP_PER_BLOB);
// Impact fire palette matches the ring of fire: dazzling orange at birth,
// cooling through vivid orange to the same deep crimson undertone.
const IMPACT_FIRE_COLOR_ORANGE = [1.15, 0.6, 0.08]; // dazzling fire orange at birth
const IMPACT_FIRE_COLOR_ORANGE_MID = [0.95, 0.24, 0.04]; // vivid ember orange
const IMPACT_FIRE_COLOR_RED = [0.7, 0.04, 0.035]; // deep crimson undertone
// The halo is built with enough angular segments that its edge can undulate
// per-vertex into irregular flame tongues (see the frame loop), instead of a
// static uniform circle.
const BURN_RING_HALO_SEGMENTS = 96;
// Fiery ribbon trail: a short chain of hot glints dragged behind the burning
// ball, sampled from the trajectory just behind it each frame. It fades out
// with distance so the burning pitch leaves a short comet-like flame instead
// of a full-length trail.
const BURN_TRAIL_MAX_COUNT = 32;
// Ribbon colors: dazzling orange at the ball, cooling through orange to deep
// crimson at the tail (matching the ring's palette), so the flame reads hot
// at the leading edge.
const BURN_TRAIL_COLOR_HEAD = [1, 0.65, 0.12]; // dazzling orange at the ball
const BURN_TRAIL_COLOR_TAIL = [0.88, 0.09, 0.04]; // deep crimson as it trails

// Tiny glowing ember particles for 100+ mph impacts: small hot orange-red
// glints that pop off the ring as it cools (settle/steady phases) and drift
// upward, reading like sparks from a cooling ember. Distinct from the
// lingering beams (which are thin upright light-slivers) and the smoke
// (which is soft, neutral-coloured, non-additive).
const RING_EMBER_MAX_COUNT = 16;
const EMBER_YELLOW = [1, 0.7, 0.15];  // freshly-shed warm yellow
const EMBER_ORANGE = [1, 0.5, 0.07];  // mid-life orange-red
const EMBER_RED = [1, 0.24, 0.03];    // cooling red
const RING_EMBER_COLOR = EMBER_ORANGE; // fallback hot ember

// Give each ember an independent sample along the yellow → orange → red
// gradient so the shed sparks read at different cooling stages.
function randomEmberColor() {
    const t = Math.random();
    const from = t < 0.5 ? EMBER_YELLOW : EMBER_ORANGE;
    const to = t < 0.5 ? EMBER_ORANGE : EMBER_RED;
    const localT = (t % 0.5) * 2;
    return [
        THREE.MathUtils.lerp(from[0], to[0], localT),
        THREE.MathUtils.lerp(from[1], to[1], localT),
        THREE.MathUtils.lerp(from[2], to[2], localT),
    ];
}

// Supersonic-crack ripple: the expanding shock ring on a 100+ mph impact.
// The ring's material is a shader whose outer rim burns white-hot (the shock
// front) over an orange body, with fine concentric ripples racing outward
// along the band, so the expanding ring reads as a crack flash instead of a
// flat colored donut. The screen-space distortion pass in Scene (fed via
// util/impactDistortion.js) bends the scenery behind it on the same clock.
const RIPPLE_VERTEX = `
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const RIPPLE_FRAGMENT = `
uniform float uOpacity;
uniform float uTime;
uniform float uBandStart;
varying vec2 vUv;
void main() {
    // Radial band position: 0 at the inner rim, 1 at the outer rim. The
    // ring's uv is planar (normalized to the outer radius), so the band
    // spans from uBandStart (inner rim) to 1 (outer rim).
    vec2 c = vUv - 0.5;
    float r = length(c) * 2.0;
    float t = clamp((r - uBandStart) / max(0.0001, 1.0 - uBandStart), 0.0, 1.0);
    // Translucent shock band: the shock front is a pressure wave, not
    // light — no white-hot rim, no bright edge line. A faint orange tint
    // that fades toward the outer rim keeps the band readable without
    // reading as light. Purely additive-feel: mostly alpha, little color.
    float front = smoothstep(0.82, 0.98, t);
    float body = smoothstep(0.0, 0.82, t);
    vec3 col = vec3(1.0, 0.55, 0.12) * body * 0.55;
    // Fine concentric ripples racing outward along the band (subtle,
    // texture only — no brightening).
    col *= 0.88 + 0.12 * sin(t * 120.0 - uTime * 90.0);
    float alpha = (0.28 * body + 0.16 * front) * uOpacity;
    gl_FragColor = vec4(col, alpha);
}
`;

export const Pitch = ({ pitchData, defaultPitchData, replayKey = 0, crossingPlane = 'mid', onCrossings, onArrival, overlay = false, showRingLabel = true, showColoredTail = true, showBillows = true, impactEffect = 'beams' }) => {
    const pitchTuning = useTuning().pitch;
    const ballRef = useRef();
    // Tracks whether the physics ball has reached the plate in the current
    // playback cycle. The crossing ring appears only once the pitch has
    // arrived (been batted), persists through the batted-ball flight, and is
    // removed when the cycle wraps so the next play starts clean.
    const arrivedRef = useRef(false);
    // Sim time at which the current pitch reached the plate; -1 until then.
    // Drives the white trace's gradual post-arrival fade.
    const arrivedAtRef = useRef(-1);
    // Ring appearance animation: 'idle' (hidden) -> 'pulse' (impact flash on
    // arrival) -> 'steady' -> 'fadeout' (replay reset) -> 'idle'.
    const ringAnim = useRef({ phase: 'idle', t: 0 });
    const rippleAnim = useRef({ active: false, t: 0 });
    const impactFireAnim = useRef({ active: false, t: 0 });
    const ringGroupRef = useRef();
    const ringMeshRef = useRef();
    const rippleMeshRef = useRef();
    // Two instanced layers: the colored fading tail, and a persistent white
    // trace underneath it. Both are revealed progressively as the ball flies to
    // the plate and cleared when the play replays (cycle wraps).
    const trailMeshRef = useRef();
    const whiteTraceMeshRef = useRef();
    // Comparison ring label group: its visibility mirrors the ring (hidden
    // until the pitch reaches the strike zone, cleared when the windup starts)
    // so the label toggles with the trajectory overlays in comparison mode.
    const ringLabelGroupRef = useRef();
    // True once the pitcher has restarted his windup this cycle, so the
    // persistent white trace clears then instead of lingering to the wrap.
    const whiteTraceClearedRef = useRef(false);
    // True once the pitcher has restarted his windup this cycle, so the
    // hawk-eye crossing ring fades out then instead of lingering through the
    // windup to the wrap.
    const ringClearedRef = useRef(false);
    const billowMeshRef = useRef();
    const whiteBillowMeshRef = useRef();
    const goldSparkMeshRef = useRef();
    const ringSpikeMeshRef = useRef();
    const ringLingerMeshRef = useRef();
    const smokeMeshRef = useRef();
    const ringEmberMeshRef = useRef();
    const burnRingRef = useRef();
    const burnRingGlowRef = useRef();
    // The group holding the ring of fire: the ball's position is copied onto
    // it each frame and its quaternion is set to the camera's so the ring's
    // plane always faces the camera directly.
    const burnRingGroupRef = useRef();
    const burnShimmerRef = useRef();
    // Elapsed sim time since the ball entered the zone, for the ignition
    // surge (Infinity = not ignited this cycle).
    const burnIgniteTimeRef = useRef(Infinity);
    const burnTrailMeshRef = useRef();
    const burnSparkMeshRef = useRef();
    const impactFireMeshRef = useRef();
    // Elapsed real time since the ring appeared, for lingering particle emission
    const ringAliveClockRef = useRef(0);
    // The 8 strike-zone lines (4 outer border + 2 inner vertical + 2 inner
    // horizontal grid lines): collected so the ring's glow can briefly
    // illuminate them, then cool them back to white with the ring.
    const zoneLineRefs = useRef([]);
    // Reusable scratch colors for the zone-line illumination (no per-frame
    // allocs): the ring's live glow color (white-hot → ember gold) is written
    // each frame and shared by the ring mesh, the strike-zone lines, and the
    // smoke so the whole impact reads as one heat source.
    const ringGlowColor = useMemo(() => new THREE.Color(1, 1, 1), []);
    const zoneLineWhite = useMemo(() => new THREE.Color(1, 1, 1), []);
    const zoneLineTint = useMemo(() => new THREE.Color(), []);
    // Fire-colored zone glow: the strike-zone grid flashes dazzling orange at
    // the crossing spot on impact, cooling to the deep crimson undertone
    // toward the zone's edges, so the grid reads as radiating heat.
    const zoneHeatGlowHot = useMemo(() => new THREE.Color(1.25, 0.55, 0.06), []);
    const zoneHeatGlowCool = useMemo(() => new THREE.Color(0.7, 0.05, 0.04), []);

    // Each geometry carries its own per-instance color/alpha attributes; the
    // custom ShaderMaterial renders each instance with its own color and
    // opacity so the two layers can fade independently.
    const trailGeometry = useMemo(() => createTrailGeometry(() => new THREE.BoxGeometry(1, 1, 1)), []);
    const whiteTraceGeometry = useMemo(() => createTrailGeometry(() => new THREE.SphereGeometry(0.5, 12, 8)), []);
    const trailMaterial = useMemo(() => createTrailMaterial(), []);
    const whiteTraceMaterial = useMemo(() => createTrailMaterial(), []);
    const billowGeometry = useMemo(() => createTrailGeometry(() => new THREE.BoxGeometry(1, 1, 1)), []);
    const billowMaterial = useMemo(() => createTrailMaterial(), []);
    const billowDummy = useMemo(() => new THREE.Object3D(), []);
    const whiteBillowGeometry = useMemo(() => createTrailGeometry(() => new THREE.BoxGeometry(1, 1, 1)), []);
    // The white wake renders additively so overlapping particles brighten
    // each other into glowing glints instead of flat white boxes.
    const whiteBillowMaterial = useMemo(() => {
        const material = createTrailMaterial();
        material.blending = THREE.AdditiveBlending;
        return material;
    }, []);
    const whiteBillowDummy = useMemo(() => new THREE.Object3D(), []);
    // The golden sparks are octahedra (sharp diamond shards) instead of the
    // square billow boxes, and render additively so overlapping sparks bloom
    // into a bright golden glow.
    const goldSparkGeometry = useMemo(() => createTrailGeometry(() => new THREE.OctahedronGeometry(0.5, 0)), []);
    const goldSparkMaterial = useMemo(() => {
        const material = createTrailMaterial();
        material.blending = THREE.AdditiveBlending;
        return material;
    }, []);
    const goldSparkDummy = useMemo(() => new THREE.Object3D(), []);
    // Ring spikes are thin elongated boxes (light-beam slivers) rather than
    // round glints, and additive so overlapping beams bloom.
    // 100+ mph ring spikes (thicker beams) — separate geometry so the size
    // switch doesn't mutate the shared buffer mid-frame.
    const ringSpikeGeometry100 = useMemo(() => createTrailGeometry(() => new THREE.BoxGeometry(RING_SPIKE_WIDTH_100, RING_SPIKE_HEIGHT_100, RING_SPIKE_DEPTH_100)), []);
    const ringSpikeMaterial100 = useMemo(() => {
        const material = createTrailMaterial();
        material.blending = THREE.AdditiveBlending;
        return material;
    }, []);
    const ringSpikeDummy = useMemo(() => new THREE.Object3D(), []);
    // Lingering particles for 100+ mph: thin upward-pointing beams
    const ringLingerGeometry = useMemo(
        () => createTrailGeometry(() => new THREE.BoxGeometry(
            pitchTuning.ringLingerWidth,
            RING_LINGER_HEIGHT,
            pitchTuning.ringLingerWidth,
        )),
        [pitchTuning.ringLingerWidth],
    );
    const ringLingerMaterial = useMemo(() => {
        const material = createTrailMaterial();
        material.blending = THREE.AdditiveBlending;
        return material;
    }, []);
    const ringLingerDummy = useMemo(() => new THREE.Object3D(), []);
    // Smoke uses the same box primitive as the tail billows for a pixel-like
    // silhouette, with normal transparent blending instead of additive glow.
    const smokeGeometry = useMemo(() => createTrailGeometry(() => new THREE.BoxGeometry(1, 1, 1)), []);
    const smokeMaterial = useMemo(() => createTrailMaterial(), []);
    const smokeDummy = useMemo(() => new THREE.Object3D(), []);
    // Embers are tiny octahedra (sharp hot glints) rendered additively so
    // overlapping embers bloom into a warm glow instead of flat orange boxes.
    const ringEmberGeometry = useMemo(() => createTrailGeometry(() => new THREE.OctahedronGeometry(0.5, 0)), []);
    const ringEmberMaterial = useMemo(() => {
        const material = createTrailMaterial();
        material.blending = THREE.AdditiveBlending;
        return material;
    }, []);
    const ringEmberDummy = useMemo(() => new THREE.Object3D(), []);
    // The hawk-eye ring: a flat RingGeometry donut (2.0–2.8 in, matching the
    // solomon-gumball StrikeZone indicator) with one unlit DoubleSide material,
    // so it reads as a continuous object, fades uniformly, and stays visible
    // from either side. Drawn on top (depthTest off). Its color is set per
    // pitch from the same speed ramp as the tail (see speedTrailColor), so the
    // ring left at the strike zone matches the pitch's tail color. RingGeometry
    // lies in the x–y plane by default, which is the ring's plane.
    const ringGeometry = useMemo(
        () => new THREE.RingGeometry(RING_INNER_RADIUS, RING_OUTER_RADIUS, 48),
        [],
    );
    const rippleGeometry = useMemo(
        () => new THREE.RingGeometry(
            RING_OUTER_RADIUS - pitchTuning.rippleWidth * 0.5,
            RING_OUTER_RADIUS + pitchTuning.rippleWidth * 0.5,
            64,
        ),
        [pitchTuning.rippleWidth],
    );
    const rippleMaterial = useMemo(() => new THREE.ShaderMaterial({
        vertexShader: RIPPLE_VERTEX,
        fragmentShader: RIPPLE_FRAGMENT,
        uniforms: {
            uOpacity: { value: 0 },
            uTime: { value: 0 },
            // Inner rim of the ring band as a fraction of the outer radius
            // (the uv's planar normalization), so the shader can map the
            // band to 0..1 regardless of the tuned width.
            uBandStart: {
                value: (RING_OUTER_RADIUS - pitchTuning.rippleWidth * 0.5)
                    / (RING_OUTER_RADIUS + pitchTuning.rippleWidth * 0.5),
            },
        },
        transparent: true,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
    }), [pitchTuning.rippleWidth]);
    const ringMaterial = useMemo(() => new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
        opacity: 0,
    }), []);
    // The burning-ball ring: a thin donut in the x–y plane, billboarded to
    // face the camera, additive so it glows fiercely over the ball.
    const burnRingGeometry = useMemo(() => {
        const geometry = new THREE.RingGeometry(BURN_RING_INNER_RADIUS, BURN_RING_OUTER_RADIUS, 48);
        // RingGeometry emits the inner rim's vertices first (theta 0..48),
        // then the outer rim's (phiSegments = 1, inner-to-outer), so paint
        // the inner rim deep crimson and the outer rim dazzling orange to
        // bake the radial fire gradient in — no per-frame color work.
        const positionCount = geometry.attributes.position.count;
        const innerCount = positionCount / 2;
        const colors = new Float32Array(positionCount * 3);
        for (let i = 0; i < positionCount; i++) {
            const c = i < innerCount ? BURN_RING_INNER_COLOR : BURN_RING_OUTER_COLOR;
            colors[i * 3] = c[0];
            colors[i * 3 + 1] = c[1];
            colors[i * 3 + 2] = c[2];
        }
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        return geometry;
    }, []);
    const burnRingMaterial = useMemo(() => new THREE.MeshBasicMaterial({
        // White so the per-vertex crimson→orange gradient passes through
        // untouched; brightness is driven by opacity × additive blending.
        color: 0xffffff,
        vertexColors: true,
        transparent: true,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: 0,
    }), []);
    const burnRingGlowGeometry = useMemo(
        () => new THREE.RingGeometry(
            BURN_RING_GLOW_INNER_RADIUS, BURN_RING_GLOW_OUTER_RADIUS,
            BURN_RING_HALO_SEGMENTS, 1,
        ),
        [],
    );
    const burnRingGlowMaterial = useMemo(() => new THREE.MeshBasicMaterial({
        color: new THREE.Color(...BURN_RING_GLOW_COLOR),
        transparent: true,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: 0,
    }), []);
    // Scratch copy of the halo's pristine outer-rim positions. The frame loop
    // undulates them per-angle each frame to make the halo flare like an
    // asymmetric flame (layered detuned sines), and restores them when the
    // ring is off so the warp never carries into the next burn cycle.
    const burnHaloBasePositions = useMemo(() => {
        const positions = burnRingGlowGeometry.attributes.position.array;
        const base = new Float32Array(positions.length);
        base.set(positions);
        return base;
    }, [burnRingGlowGeometry]);
    // Scratch color for the ball's heat tint (no per-frame allocs).
    const burnTintColor = useMemo(() => new THREE.Color(0.92, 0.2, 0.05), []);
    // Scratch vectors for projecting the ball's spin axis into the ring's
    // camera-facing plane (no per-frame allocs).
    const burnCamFwd = useMemo(() => new THREE.Vector3(), []);
    const burnCamRight = useMemo(() => new THREE.Vector3(), []);
    const burnCamUp = useMemo(() => new THREE.Vector3(), []);
    const burnAxisProj = useMemo(() => new THREE.Vector3(), []);
    // The fiery ribbon: round additive glints (spheres) so overlapping
    // particles bloom into a continuous flame ribbon rather than chunky boxes.
    const burnTrailGeometry = useMemo(
        () => createTrailGeometry(() => new THREE.SphereGeometry(0.5, 8, 6)),
        [],
    );
    const burnTrailMaterial = useMemo(() => {
        const material = createTrailMaterial();
        material.blending = THREE.AdditiveBlending;
        return material;
    }, []);
    const burnTrailDummy = useMemo(() => new THREE.Object3D(), []);
    // Heat-shimmer disc: a camera-facing plane with a procedural ripple
    // shader that shimmers like air over hot metal (see BURN_SHIMMER_*).
    const burnShimmerGeometry = useMemo(
        () => new THREE.PlaneGeometry(BURN_SHIMMER_RADIUS * 2, BURN_SHIMMER_RADIUS * 2),
        [],
    );
    const burnShimmerMaterial = useMemo(() => new THREE.ShaderMaterial({
        vertexShader: BURN_SHIMMER_VERTEX,
        fragmentShader: BURN_SHIMMER_FRAGMENT,
        uniforms: { uTime: { value: 0 }, uOpacity: { value: 0 } },
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
    }), []);
    // Sparkler sparks shed radially off the burn ring: tiny additive
    // octahedron glints (mirroring the golden spark layer's sharp shards).
    const burnSparkGeometry = useMemo(() => createTrailGeometry(() => new THREE.OctahedronGeometry(0.5, 0)), []);
    const burnSparkMaterial = useMemo(() => {
        const material = createTrailMaterial();
        material.blending = THREE.AdditiveBlending;
        return material;
    }, []);
    const burnSparkDummy = useMemo(() => new THREE.Object3D(), []);
    // Per-pitch sparkler seeds: each slot runs its own repeating emission
    // cycle with its own spray angle, so sparks keep shedding all around the
    // ring the whole time it flares.
    // Impact fire burst layer: a short-lived radial burst of fire particles
    // from the strike-zone ring on impact, triggered once per arrival.
    // Round blobs (not shards): the fire burst is a voluminous, blooming
    // sheet of flame — deliberately distinct from the impact beams, which are
    // thin straight light slivers.
    const impactFireGeometry = useMemo(() => createTrailGeometry(() => new THREE.SphereGeometry(0.5, 8, 6)), []);
    const impactFireMaterial = useMemo(() => {
        const material = createTrailMaterial();
        material.blending = THREE.AdditiveBlending;
        return material;
    }, []);
    const impactFireDummy = useMemo(() => new THREE.Object3D(), []);
    // Per-pitch burst seeds: each particle has its own direction, spread
    // speed, small stagger, and flight time, so the burst fans out unevenly.
    const impactFireSeeds = useMemo(() => {
        return Array.from({ length: IMPACT_FIRE_MAX_COUNT }, (_, i) => ({
            angle: Math.random() * Math.PI * 2,
            speed: 0.55 + Math.random() * 0.95, // radial spread speed (deliberately slow)
            delay: (i / IMPACT_FIRE_MAX_COUNT) * 0.1 + Math.random() * 0.02,
            life: 0.3 + Math.random() * 0.25, // per-particle flight time
            rise: 0.3 + Math.random() * 0.7,
            scaleJitter: 0.6 + Math.random() * 0.8,
            alphaJitter: 0.7 + Math.random() * 0.3,
            twinklePhase: Math.random() * Math.PI * 2,
        }));
    }, [pitchData]);

    const burnSparkSeeds = useMemo(() => {
        return Array.from({ length: BURN_SPARK_MAX_COUNT }, (_, i) => ({
            // Spread the slots across the life cycle so emission is continuous
            // rather than all sparks born at once.
            phase: (i / BURN_SPARK_MAX_COUNT) + Math.random() * 0.05,
            angle: Math.random() * Math.PI * 2,
            // rad/s — the ring sprays sparks around as the fire rotates.
            angularSpeed: 1.5 + Math.random() * 3.5,
            // How far each spark flies outward.
            flareSpeed: 0.8 + Math.random() * 1.2,
            rise: 0.3 + Math.random() * 0.7,
            scaleJitter: 0.6 + Math.random() * 0.8,
            alphaJitter: 0.7 + Math.random() * 0.3,
            twinklePhase: Math.random() * Math.PI * 2,
            colorMix: Math.random(),
        }));
    }, [pitchData]);

    // Per-pitch random billow seeds (stable per pitch): each particle emits at
    // its own delay spread across the whole flight, so the cloud trails the
    // entire pitch path instead of bunching at the release point.
    const flightDuration = useMemo(() => {
        const trajectoryData = pitchData?.trajectory;
        if (!trajectoryData || trajectoryData.length === 0) return 0.4;
        return trajectoryData[trajectoryData.length - 1]?.t || 0.4;
    }, [pitchData]);

    const billowSeeds = useMemo(
        () => makeBillowSeeds(BILLOW_MAX_COUNT, flightDuration, pitchTuning),
        [flightDuration, pitchTuning],
    );
    const billowSpawns = useMemo(
        () => makeBillowSpawns(pitchData?.trajectory, billowSeeds, pitchTuning),
        [pitchData, billowSeeds, pitchTuning],
    );

    // White billow layer, emitted by every pitch (amount scales with speed).
    // Seeds are generated for the full capacity; the emitted count is gated by
    // `limit` in the frame loop (fewer particles under 90 mph).
    const whiteBillowSeeds = useMemo(
        () => makeBillowSeeds(BILLOW_WHITE_MAX_CAPACITY, flightDuration, pitchTuning),
        [flightDuration, pitchTuning],
    );
    const whiteBillowSpawns = useMemo(
        () => makeBillowSpawns(pitchData?.trajectory, whiteBillowSeeds, pitchTuning),
        [pitchData, whiteBillowSeeds, pitchTuning],
    );

    // Golden spark layer, emitted only by 99+ mph pitches (see
    // GOLD_SPARK_THRESHOLD_MPH). Same billow mechanics, finer look.
    const goldSparkSeeds = useMemo(
        () => makeBillowSeeds(GOLD_SPARK_MAX_COUNT, flightDuration, pitchTuning),
        [flightDuration, pitchTuning],
    );
    const goldSparkSpawns = useMemo(
        () => makeBillowSpawns(pitchData?.trajectory, goldSparkSeeds, pitchTuning),
        [pitchData, goldSparkSeeds, pitchTuning],
    );

    // Per-pitch ring spike seeds: evenly spaced around the ring with slight
    // angle jitter and Z scatter so the formation looks organic, not
    // mechanically perfect. The angle is rotated by a per-pitch offset (from
    // the release speed) so each pitch gets its own deterministic pattern.
    const ringSpikeSeeds = useMemo(() => {
        const speedOffset = ((pitchData?.speed_mph ?? 90) % 360) * (Math.PI / 180);
        return Array.from({ length: RING_SPIKE_MAX_COUNT }, (_, i) => ({
            angle: speedOffset + (i / RING_SPIKE_MAX_COUNT) * Math.PI * 2
                + (Math.random() - 0.5) * 0.12, // small angle jitter
            scaleJitter: 0.7 + Math.random() * 0.6,
            // Slight per-beam length variation for a more organic impact burst
            lengthJitter: 0.82 + Math.random() * 0.36,
            // Each spike starts drifting at a slightly different speed for variety
            driftSpeed: pitchTuning.ringSpikeDriftSpeed * (0.7 + Math.random() * 0.6),
            zOffset: (Math.random() - 0.5) * 0.015, // slight depth scatter
            color: randomImpactBeamColor(),
        }));
    }, [pitchData, pitchTuning]);

    // Lingering particles for 100+ mph: randomly placed around the ring,
    // each activates at its own delay after the ring appears, then floats
    // upward and fades. New ones keep appearing while the ring is visible.
    const ringLingerSeeds = useMemo(() => {
        return Array.from({ length: RING_LINGER_MAX_COUNT }, (_, i) => ({
            angle: Math.random() * Math.PI * 2,
            // Stagger a short repeating emission cycle; each particle gets a
            // fresh random ring position so the ring keeps sparkling all around.
            delay: (i / RING_LINGER_MAX_COUNT) * pitchTuning.ringLingerSpawnSpan,
            driftSpeed: 0.12 + Math.random() * (0.35 - 0.12),
            scaleJitter: 0.6 + Math.random() * 0.8,
            alphaJitter: 0.7 + Math.random() * 0.3,
            zOffset: (Math.random() - 0.5) * 0.02,
            color: randomImpactParticleColor(),
        }));
    }, [pitchData, pitchTuning]);

    // Ember particles for 100+ mph: each sheds from a random ring spot on a
    // short repeating cycle (while the ring is cooling/settled), rises
    // upward with a little lateral drift, twinkles on its own phase, and
    // fades as it cools.
    const ringEmberSeeds = useMemo(() => {
        return Array.from({ length: RING_EMBER_MAX_COUNT }, (_, i) => {
            const driftAngle = Math.random() * Math.PI * 2;
            return {
                angle: Math.random() * Math.PI * 2,
                // Stagger the emission cycle so embers keep shedding from
                // different points around the ring.
                delay: (i / RING_EMBER_MAX_COUNT) * pitchTuning.emberSpawnSpan,
                riseSpeed: pitchTuning.emberRiseSpeed * (0.7 + Math.random() * 0.6),
                driftSpeed: pitchTuning.emberDriftSpeed * (0.5 + Math.random() * 1),
                driftAngle,
                scaleJitter: 0.6 + Math.random() * 0.8,
                alphaJitter: 0.7 + Math.random() * 0.3,
                zOffset: (Math.random() - 0.5) * 0.02,
                // Per-ember twinkle so the embers flicker independently like
                // sparks, not in lockstep.
                twinklePhase: Math.random() * Math.PI * 2,
                twinkleSpeed: pitchTuning.emberTwinkleSpeed * (0.7 + Math.random() * 0.6),
                color: randomEmberColor(),
                // Per-ember glow jitter: an independent per-channel offset on
                // the ring-glow target (each in -0.5..0.5, scaled by the
                // emberGlowJitter tuning) plus a per-ember strength factor on
                // the glow mix, so sparks shed at the same moment don't all
                // pick up one identical ring shade.
                glowJitter: [Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5],
                glowAmountJitter: 1 - pitchTuning.emberGlowAmountJitter + Math.random() * 2 * pitchTuning.emberGlowAmountJitter,
            };
        });
    }, [pitchData, pitchTuning]);

    const smokeSeeds = useMemo(() => {
        return Array.from({ length: SMOKE_MAX_COUNT }, () => {
            const startAngle = Math.random() * Math.PI * 2;
            // Sample only near the ring's outer edge (a narrow inward spread),
            // so smoke emits on the perimeter instead of across the centre.
            const startRadius = SMOKE_START_RADIUS * (1 - pitchTuning.smokePerimeterSpread * Math.random());
            const driftAngle = Math.random() * Math.PI * 2;
            const driftSpeed = pitchTuning.smokeDriftMin + Math.random() * (pitchTuning.smokeDriftMax - pitchTuning.smokeDriftMin);
            const color = randomSmokeColor(pitchTuning);
            const luminance = 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
            const isWhite = luminance > pitchTuning.smokeWhiteLuminanceThreshold;
            // Only white puffs get a variable opacity bump (the bright plumes
            // pop); black keeps the standard shared opacity line. White also
            // earns a dedicated extra bump so the plumes read clearly whiter.
            // A brighter white puff spawns modestly smaller (scale inverse to
            // boost) so a dense, bright plume starts slightly compact.
            const boost = isWhite
                ? (1 + Math.random() * pitchTuning.smokeToneBoostMax) * (1 + pitchTuning.smokeWhiteBoost)
                : 1;
            const whiteScaleFactor = isWhite
                ? 1 / (1 + (boost - 1) * pitchTuning.smokeWhiteOpacityShrink)
                : 1;
            return {
                delay: Math.random() * pitchTuning.smokeSpawnSpan,
                startAngle,
                radius: startRadius,
                startZ: (Math.random() - 0.5) * 0.014,
                driftX: Math.cos(driftAngle) * driftSpeed,
                driftZ: Math.sin(driftAngle) * driftSpeed * 0.35,
                swaySpeed: pitchTuning.smokeSwaySpeedMin + Math.random() * (pitchTuning.smokeSwaySpeedMax - pitchTuning.smokeSwaySpeedMin),
                swayAmp: pitchTuning.smokeSwayAmplitudeMin + Math.random() * (pitchTuning.smokeSwayAmplitudeMax - pitchTuning.smokeSwayAmplitudeMin),
                swayPhase: Math.random() * Math.PI * 2,
                riseSpeed: pitchTuning.smokeRiseMin + Math.random() * (pitchTuning.smokeRiseMax - pitchTuning.smokeRiseMin),
                scaleJitter: 0.7 + Math.random() * 0.7,
                alphaJitter: 0.65 + Math.random() * 0.35,
                boost,
                whiteScaleFactor,
                color,
            };
        });
    }, [pitchData, pitchTuning]);

    // Start each new pitch back at the release point, with both trail layers
    // cleared so they can grow behind the ball as it flies.
    React.useLayoutEffect(() => {
        arrivedRef.current = false;
        arrivedAtRef.current = -1;
        whiteTraceClearedRef.current = false;
        ringClearedRef.current = false;
        ringAnim.current.phase = 'idle';
        ringAnim.current.t = 0;
        rippleAnim.current.active = false;
        rippleAnim.current.t = 0;
        // A new pitch must never leave the screen-space distortion pass
        // armed from a previous impact.
        impactDistortion.active = false;
        impactFireAnim.current.active = false;
        impactFireAnim.current.t = 0;
        if (impactFireMeshRef.current) {
            const alphaAttr = impactFireGeometry.getAttribute('aAlpha');
            alphaAttr.array.fill(0);
            alphaAttr.needsUpdate = true;
        }
        // A new pitch starts fresh at the release point: undo the previous
        // pitch's arrival (which hid the ball when it reached the plate), so
        // the new flight is visible immediately instead of waiting for the
        // next cycle wrap.
        if (ballRef.current) ballRef.current.visible = true;
        if (trailMeshRef.current) {
            const alphaAttr = trailGeometry.getAttribute('aAlpha');
            alphaAttr.array.fill(0);
            alphaAttr.needsUpdate = true;
        }
        if (whiteTraceMeshRef.current) {
            const alphaAttr = whiteTraceGeometry.getAttribute('aAlpha');
            alphaAttr.array.fill(0);
            alphaAttr.needsUpdate = true;
        }
        if (billowMeshRef.current) {
            const alphaAttr = billowGeometry.getAttribute('aAlpha');
            alphaAttr.array.fill(0);
            alphaAttr.needsUpdate = true;
        }
        if (whiteBillowMeshRef.current) {
            const alphaAttr = whiteBillowGeometry.getAttribute('aAlpha');
            alphaAttr.array.fill(0);
            alphaAttr.needsUpdate = true;
        }
        if (goldSparkMeshRef.current) {
            const alphaAttr = goldSparkGeometry.getAttribute('aAlpha');
            alphaAttr.array.fill(0);
            alphaAttr.needsUpdate = true;
        }
        if (ringSpikeGeometry100) {
            const alphaAttr = ringSpikeGeometry100.getAttribute('aAlpha');
            alphaAttr.array.fill(0);
            alphaAttr.needsUpdate = true;
        }
        if (ringLingerMeshRef.current) {
            const alphaAttr = ringLingerGeometry.getAttribute('aAlpha');
            alphaAttr.array.fill(0);
            alphaAttr.needsUpdate = true;
        }
        if (smokeMeshRef.current) {
            const alphaAttr = smokeGeometry.getAttribute('aAlpha');
            alphaAttr.array.fill(0);
            alphaAttr.needsUpdate = true;
        }
        if (ringEmberMeshRef.current) {
            const alphaAttr = ringEmberGeometry.getAttribute('aAlpha');
            alphaAttr.array.fill(0);
            alphaAttr.needsUpdate = true;
        }
        // Lingering slots are reset with the ring and therefore stop as soon
        // as the pitch trail/ring is cleared for the next wind-up.
        ringAliveClockRef.current = 0;
        // Hide the hawk-eye ring until the arrival pulse eases it in, and the
        // comparison label with it.
        ringMaterial.opacity = 0;
        rippleMaterial.uniforms.uOpacity.value = 0;
        impactDistortion.active = false;
        if (ringMeshRef.current) ringMeshRef.current.visible = false;
        if (rippleMeshRef.current) rippleMeshRef.current.visible = false;
        if (ringLabelGroupRef.current) ringLabelGroupRef.current.visible = false;
        // Restore the strike-zone lines to white so a fresh pitch starts clean.
        for (const line of zoneLineRefs.current) {
            if (line && line.material && line.material.color) line.material.color.copy(zoneLineWhite);
        }
        // Hide the burning-ball ring until the ball is well into its flight.
        if (burnRingRef.current) burnRingRef.current.visible = false;
        if (burnRingGlowRef.current) burnRingGlowRef.current.visible = false;
        if (burnRingGroupRef.current) {
            burnRingGroupRef.current.position.set(0, 0, 0);
            burnRingGroupRef.current.quaternion.identity();
        }
        burnRingMaterial.opacity = 0;
        burnRingGlowMaterial.opacity = 0;
        burnShimmerMaterial.uniforms.uOpacity.value = 0;
        burnIgniteTimeRef.current = Infinity;
        if (burnShimmerRef.current) burnShimmerRef.current.visible = false;
        if (burnTrailMeshRef.current) {
            const alphaAttr = burnTrailGeometry.getAttribute('aAlpha');
            alphaAttr.array.fill(0);
            alphaAttr.needsUpdate = true;
        }
        if (burnSparkMeshRef.current) {
            const alphaAttr = burnSparkGeometry.getAttribute('aAlpha');
            alphaAttr.array.fill(0);
            alphaAttr.needsUpdate = true;
        }
    }, [pitchData, replayKey, trailGeometry, whiteTraceGeometry, billowGeometry, whiteBillowGeometry, goldSparkGeometry, ringSpikeGeometry100, ringLingerGeometry, smokeGeometry, ringEmberGeometry, burnTrailGeometry, burnSparkGeometry, impactFireGeometry, burnShimmerMaterial, ringMaterial, rippleMaterial, burnRingMaterial, burnRingGlowMaterial, zoneLineWhite]);
    
    // Memoize the line points so we don't recreate them every render
    const linePoints = useMemo(() => {
        const trajectoryData = pitchData?.trajectory;
        if (!trajectoryData || trajectoryData.length === 0) return [];
        // Map trajectory dicts {x, y, z} to THREE.Vector3
        return trajectoryData.map(p => new THREE.Vector3(p.x, p.z, -p.y));
    }, [pitchData]);

    // Particle samples for the pitch path, ported from solomon-gumball's
    // PitchArc but sampled much more densely (every TRAIL_SAMPLE_STEP s) and
    // rendered smaller so it reads as a continuous trajectory. Each sample
    // keeps its sim time so the frame loop can fade it in as the ball flies
    // past and fade it out again as it ages behind the ball.
    //
    // The particle count scales with pitch speed: the sample step widens for
    // slower pitches (30% of the full count at 70 mph) up to the full dense
    // sampling at 90+ mph, so velocity reads as a hotter, denser trail.
    const particlePoints = useMemo(() => {
        const trajectoryData = pitchData?.trajectory;
        if (!trajectoryData || trajectoryData.length === 0) return [];
        const speed = pitchData?.speed_mph ?? 90;
        const densityFrac = getSpeedDensityFrac(speed, pitchTuning);
        const sampleStep = pitchTuning.trailSampleStep / densityFrac;
        const pts = [];
        for (let i = 0; i < TRAIL_MAX_PARTICLES; i++) {
            const t = i * sampleStep;
            const pos = sampleTrajectoryAtTime(trajectoryData, t);
            if (!pos) break;
            if (pos.z >= FRONT_OF_PLATE_Z) break;
            pts.push({ pos, t });
        }
        return pts;
    }, [pitchData, pitchTuning]);

    // Write each particle's transform + color into the instanced buffers once
    // per pitch. Alphas stay at 0 until the frame loop fades each particle in
    // as the ball passes its sample time.
    React.useLayoutEffect(() => {
        const dummy = new THREE.Object3D();

        // Tail color is constant along the whole flight, picked from a speed
        // ramp: yellowish-white at 70 mph → crimson red at 99 mph. The hawk-eye
        // ring at the strike zone shares this exact color below 100 mph, then
        // flips to the golden spark color only for pitches strictly above
        // 100 mph (GOLD_RING_THRESHOLD_MPH). The tail's
        // custom shader writes its color raw, so pass the same values as sRGB
        // on the ring's MeshBasicMaterial (which converts linear→sRGB at
        // output) to keep the two visually identical.
        const speed = pitchData?.speed_mph ?? 90;
        const trailColor = speedTrailColor(speed);
        const ringColor = speed > pitchTuning.goldRingThresholdMph ? GOLD_SPARK_COLOR : trailColor;
        if (ringMaterial) {
            ringMaterial.color.setRGB(ringColor[0], ringColor[1], ringColor[2], THREE.SRGBColorSpace);
        }

        const writeLayer = (mesh, colorAttr, alphaAttr, isWhite) => {
            if (!mesh) return;
            const colors = colorAttr.array;
            const alphas = alphaAttr.array;

            for (let i = 0; i < TRAIL_MAX_PARTICLES; i++) {
                if (i < particlePoints.length) {
                    const p = particlePoints[i];
                    const isLead = i === 0;
                    dummy.position.copy(p.pos);
                    dummy.scale.setScalar(
                        isWhite
                            ? pitchTuning.whiteTraceScale
                            : (isLead ? pitchTuning.trailLeadScale : pitchTuning.trailParticleScale),
                    );
                    dummy.rotation.set(0, 0, 0);
                    dummy.updateMatrix();
                    mesh.setMatrixAt(i, dummy.matrix);
                    if (isWhite) {
                        colors[i * 3] = WHITE_TRACE_COLOR[0];
                        colors[i * 3 + 1] = WHITE_TRACE_COLOR[1];
                        colors[i * 3 + 2] = WHITE_TRACE_COLOR[2];
                    } else {
                        // Constant color along the whole tail (set by speed).
                        colors[i * 3] = trailColor[0];
                        colors[i * 3 + 1] = trailColor[1];
                        colors[i * 3 + 2] = trailColor[2];
                    }
                }
                alphas[i] = 0;
            }

            mesh.instanceMatrix.needsUpdate = true;
            colorAttr.needsUpdate = true;
            alphaAttr.needsUpdate = true;
            // Only the active samples are drawn; the rest stay hidden in the buffer.
            mesh.count = particlePoints.length;
        };

        writeLayer(
            trailMeshRef.current,
            trailGeometry.getAttribute('aColor'),
            trailGeometry.getAttribute('aAlpha'),
            false,
        );
        writeLayer(
            whiteTraceMeshRef.current,
            whiteTraceGeometry.getAttribute('aColor'),
            whiteTraceGeometry.getAttribute('aAlpha'),
            true,
        );
    }, [particlePoints, pitchData, pitchTuning, trailGeometry, whiteTraceGeometry, ringMaterial]);

    // Ghost trajectory: default (neutral) environment, shown in purple when in compare mode
    const ghostLinePoints = useMemo(() => {
        const traj = defaultPitchData?.trajectory;
        if (!traj || traj.length === 0) return [];
        return traj.map(p => new THREE.Vector3(p.x, p.z, -p.y));
    }, [defaultPitchData]);

    // Spin axis in world space, reconstructed by the backend from the 50-ft
    // kinematics (rad/s, sim frame remapped to our world: x = first-base side,
    // y = up, z = toward the plate). The reference app's spinClockHand formula
    // was never validated (its spin call is commented out) and real data shows
    // it spins fastballs backwards, so we use the backend's physically-correct
    // vector instead.
    const spinAxis = useMemo(() => {
        const a = pitchData?.spin_axis;
        if (!Array.isArray(a) || a.length !== 3) return null;
        const v = new THREE.Vector3(a[0], a[1], a[2]);
        return v.lengthSq() > 1e-8 ? v.normalize() : null;
    }, [pitchData]);
    
    // Camera for explicit ring-of-fire facing: we copy the camera's world
    // quaternion onto the burn-ring group every frame so the ring's plane
    // always points straight at the camera, regardless of nesting.
    const burnCamera = useThree((state) => state.camera);

    useFrame((state, delta) => {
        const settings = getTuning().pitch;
        const trajectoryData = pitchData?.trajectory;
        if (!trajectoryData || trajectoryData.length === 0 || !ballRef.current) return;

        const simDuration = trajectoryData[trajectoryData.length - 1]?.t || 0.4;
        if (!(simDuration > 0)) return;

        // Playback on the shared pitch + batted-ball cycle, scaled by the same
        // time scale as the batter and batted ball so they stay in sync: the
        // ball follows the trajectory's own timestamps, then holds at the plate
        // (sampleTrajectoryAtTime clamps past the end) while the batted ball
        // completes its arc before the cycle wraps.
        const loopDuration = getCycleDuration();
        const { time: currentSimTime, wrapped } = stepSimulation(delta, state.clock.elapsedTime);
        // The pitcher restarts his windup just before the cycle wraps (the
        // release lands exactly on the wrap). Clear the persistent white trace
        // there so it's gone while he winds up instead of lingering until the
        // ball leaves his hand again at the wrap.
        const windupStart = Math.max(simDuration, loopDuration - getBallReleaseTime());
        if (!wrapped && !whiteTraceClearedRef.current && currentSimTime >= windupStart) {
            whiteTraceClearedRef.current = true;
        }
        // The pitcher restarts his windup here (before the wrap): yank the
        // hawk-eye crossing ring at the same instant the persistent white
        // trace clears above, so the strike zone is left clean the moment the
        // windup begins instead of lingering until the cycle wraps.
        if (!wrapped && !ringClearedRef.current && currentSimTime >= windupStart) {
            ringClearedRef.current = true;
            ringAnim.current.phase = 'idle';
            ringAnim.current.t = 0;
            ringMaterial.opacity = 0;
            if (ringMeshRef.current) ringMeshRef.current.visible = false;
            if (ringGroupRef.current) ringGroupRef.current.scale.setScalar(1);
            // Hide the comparison ring label with the ring as the trajectories
            // clear for the windup.
            if (ringLabelGroupRef.current) ringLabelGroupRef.current.visible = false;
        }
        const position = sampleTrajectoryAtTime(trajectoryData, currentSimTime);
        if (position) {
            ballRef.current.position.copy(position);

            // Spin the seams around the Statcast spin axis, held fixed in
            // world space for the flight (rotateOnWorldAxis) and slowed from
            // true RPM so the rotation axis reads on screen.
            if (spinAxis) {
                const rpm = pitchData?.spin_rate ?? DEFAULT_SPIN_RATE_RPM;
                const angle = rpm * ((2 * Math.PI) / 60) * settings.spinSpeedScale * delta * getTimeScale();
                ballRef.current.rotateOnWorldAxis(spinAxis, angle);
            }

            // Arrival is marked the moment the pitch crosses the front edge of
            // home plate (the same instant the batter connects on contact), and
            // it comes back to the release point when the cycle wraps. A pitch
            // the bat actually meets hands off to the batted ball there, while
            // a take or swing-and-miss keeps flying through the strike zone and
            // is only hidden once it passes the back tip of the plate (into the
            // catcher).
            if (wrapped) {
                // The play replays: clear the arrival state so the next pitch
                // starts clean and ease the ring out. The particle trail is
                // rebuilt from the release point on the following frames by the
                // progressive reveal below (the clock has wrapped to ~0).
                arrivedRef.current = false;
                arrivedAtRef.current = -1;
                whiteTraceClearedRef.current = false;
                ringClearedRef.current = false;
                ballRef.current.visible = true;
                if (ringAnim.current.phase !== 'idle') {
                    ringAnim.current.phase = 'fadeout';
                    ringAnim.current.t = 0;
                }
                rippleAnim.current.active = false;
                rippleAnim.current.t = 0;
                rippleMaterial.uniforms.uOpacity.value = 0;
                impactDistortion.active = false;
                if (rippleMeshRef.current) rippleMeshRef.current.visible = false;
                // Safety: never let the label survive a cycle wrap even if the
                // windup-clearing path above was skipped (very short cycles).
                if (ringLabelGroupRef.current) ringLabelGroupRef.current.visible = false;
            } else if (!arrivedRef.current && position.z >= FRONT_OF_PLATE_Z) {
                // The pitch has reached the plate: flash in the crossing ring
                // with an impact pulse. The full particle trail is already
                // visible here because it grew behind the ball during the
                // flight.
                arrivedRef.current = true;
                arrivedAtRef.current = currentSimTime;
                ringAnim.current.phase = 'pulse';
                ringAnim.current.t = 0;
                // Supersonic crack: on the 100+ mph impact an expanding
                // ripple ring (a shader ring that snaps outward and fades
                // sharply) reads as the shock front, and the screen-space
                // distortion pass in Scene bends the scenery behind it — the
                // "crack" without a permanent full-screen pass. Both run on
                // the same sim clock (see the frame loop below).
                if ((pitchData?.speed_mph ?? 90) >= pitchTuning.goldRingThresholdMph) {
                    rippleAnim.current.active = true;
                    rippleAnim.current.t = 0;
                    if (rippleMeshRef.current) {
                        rippleMeshRef.current.visible = true;
                        rippleMeshRef.current.scale.setScalar(1);
                    }
                    // Arm the distortion pass immediately so the scenery
                    // behind the plate kicks the instant the pitch arrives.
                    if (!overlay && hawkeyeCrossingM) {
                        impactDistortion.active = true;
                        impactDistortion.time = 0;
                        impactDistortion.pos.set(hawkeyeCrossingM[0], hawkeyeCrossingM[1], FRONT_OF_PLATE_Z);
                        impactDistortion.radius = RING_OUTER_RADIUS;
                        impactDistortion.life = settings.rippleLife;
                    }
                }
                // Impact fire burst: a sheet of white-hot → red fire lances
                // radially out of the ring the instant the 100+ mph pitch hits
                // the zone.
                if (!overlay && showBillows && (pitchData?.speed_mph ?? 90) >= pitchTuning.goldRingThresholdMph) {
                    impactFireAnim.current.active = true;
                    impactFireAnim.current.t = 0;
                }
                // Ignition surge: the ring of fire flashes brighter for a
                // split second as the ball enters the zone, like fuel igniting.
                if ((pitchData?.speed_mph ?? 90) >= pitchTuning.goldRingThresholdMph) {
                    burnIgniteTimeRef.current = 0;
                }
                // The pitch has reached the strike zone: pop the comparison
                // label in with the ring.
                if (ringLabelGroupRef.current) ringLabelGroupRef.current.visible = true;
                // Notify the app so it can reveal the ball/strike outcome (or,
                // for contact, leave the hit/run/out reveal to the batted-ball
                // choreography). Fires once per arrival (reset on the wrap).
                if (!overlay && onArrival) onArrival();
            }

            // Hide the pitch ball once the bat has actually made contact, or —
            // for a take / swing-and-miss — once it has traveled through the
            // strike zone and reached the back of home plate.
            const madeContact = pitchData?.is_contact != null
                ? !!pitchData.is_contact
                : !!pitchData?.swing;
            if (arrivedRef.current && (madeContact || position.z >= BACK_OF_PLATE_Z)) {
                ballRef.current.visible = false;
            }

            // Ring of fire: a thick bright orange core ring plus a wider soft
            // glow halo wrapping the 100+ mph ball as it nears the zone. It
            // fades in around the same moment the tail billows start emitting
            // (the last third of the flight), rides the ball to the plate, and
            // dies with it on contact. Both rings sit in a group whose
            // quaternion is snapped to the camera each frame, so the ring
            // plane always faces the camera directly.
            // The ignition surge shared by the whole blaze: the ring's core
            // opacity, its flame tongues, and the fiery trail all read the
            // same value, so the wake swells with the ring as it ignites.
            let burnSurge = 1;
            if (burnRingGroupRef.current) {
                // How strongly the ball's surface warms with the flame (0 when
                // the ring is off, so the tint cools back to the seam white).
                let ballTint = 0;
                const burnOn = (pitchData?.speed_mph ?? 90) >= settings.goldRingThresholdMph
                    && !overlay && ballRef.current.visible;
                if (burnOn) {
                    // Fade in just before the billow emission window (which
                    // opens at billowStartFraction of the flight) so the ring
                    // is already glowing when the sparks start flying.
                    const burnStart = Math.max(0, simDuration * settings.burnRingStartFraction);
                    const burnElapsed = currentSimTime - burnStart;
                    const fadeIn = THREE.MathUtils.clamp(burnElapsed / Math.max(0.001, settings.burnRingFadeTime), 0, 1);
                    // Fierce flicker: two detuned fast sines so the flame
                    // crackles rather than holding a flat ring.
                    const flick = (0.5 + 0.5 * Math.sin(currentSimTime * settings.burnRingFlickerSpeed))
                        * (0.5 + 0.5 * Math.sin(currentSimTime * settings.burnRingFlickerSpeed * 1.7 + 1.3));
                    const flicker = 1 - settings.burnRingFlickerAmount + settings.burnRingFlickerAmount * flick;
                    // Ignition surge: the fire flashes brighter for a split
                    // second right as the ball enters the zone, then settles
                    // back to its crackle — like fuel igniting.
                    burnIgniteTimeRef.current += delta * getTimeScale();
                    const ignite = Math.exp(-burnIgniteTimeRef.current * settings.burnIgniteRate);
                    const surge = 1 + settings.burnIgniteAmount * ignite;
                    burnSurge = surge;
                    const coreOpacity = settings.burnRingOpacity * fadeIn * flicker * surge;
                    burnRingMaterial.opacity = coreOpacity;
                    // One shared angular phase for the whole blaze: the halo's
                    // pulse, its rotating flame tongues, and the ball's surface
                    // tint all ride the same sine, so the fire reads as a
                    // single rotating blaze instead of independently-flickering
                    // layers.
                    const flamePhase = currentSimTime * settings.burnRingFlameSpeed;
                    const haloPulse = 0.5 + 0.5 * Math.sin(flamePhase * 1.3 + 0.7);
                    // The halo trails the core's flicker, dimmer and a touch
                    // more laggy so it reads as the glow spilling off the rim.
                    const haloOpacity = coreOpacity * settings.burnRingGlowAmount * haloPulse;
                    burnRingGlowMaterial.opacity = haloOpacity;
                    // Project the ball's spin axis into the ring's plane (the
                    // camera-facing plane) so the flame tongues flare harder
                    // along the spin axis than across it — the fire reads as
                    // wrapping the ball's rotation rather than a flat disc.
                    // The ring group's quaternion equals the camera's, so local
                    // X/Y map to the camera's right/up; the projected axis
                    // angle is measured in that right/up basis.
                    burnCamFwd.set(0, 0, -1).applyQuaternion(burnCamera.quaternion);
                    burnCamRight.set(1, 0, 0).applyQuaternion(burnCamera.quaternion);
                    burnCamUp.set(0, 1, 0).applyQuaternion(burnCamera.quaternion);
                    let axisAngle = null;
                    if (spinAxis) {
                        burnAxisProj.copy(spinAxis)
                            .addScaledVector(burnCamFwd, -spinAxis.dot(burnCamFwd));
                        if (burnAxisProj.lengthSq() > 1e-6) {
                            burnAxisProj.normalize();
                            axisAngle = Math.atan2(
                                burnAxisProj.dot(burnCamUp),
                                burnAxisProj.dot(burnCamRight),
                            );
                        }
                    }
                    // Asymmetric flame pattern: undulate the halo's outer rim
                    // per angle with layered detuned sines, so the glow flares
                    // unevenly and licks around the ball like real fire instead
                    // of a uniform circle. The inner rim stays fixed at the
                    // core band.
                    const haloPositions = burnRingGlowGeometry.attributes.position.array;
                    const outerStart = BURN_RING_HALO_SEGMENTS + 1;
                    const outerCount = BURN_RING_HALO_SEGMENTS + 1;
                    const flameAmount = settings.burnRingFlameAmount;
                    const axisBias = settings.burnRingAxisBias;
                    // Ignition swell: the same surge that flashes the blaze
                    // brighter also briefly widens the flame tongues (the
                    // undulation amplitude rides `surge`) and puffs the whole
                    // halo radius outward, so the fire visibly swells the
                    // instant it ignites at the zone.
                    const haloPuff = 1 + BURN_RING_SWELL * (surge - 1);
                    for (let i = 0; i < outerCount; i++) {
                        const vi = (outerStart + i) * 3;
                        const angle = (i / BURN_RING_HALO_SEGMENTS) * Math.PI * 2;
                        const l1 = Math.sin(angle * 3 + flamePhase);
                        const l2 = Math.sin(angle * 7 + flamePhase * 1.6 + 1.7);
                        const l3 = Math.sin(angle * 2 - flamePhase * 0.8 + 4.2);
                        // Weighted toward the two fast layers so the rim ripples
                        // unevenly rather than breathing as one circle. The
                        // tongue amplitude rides the ignition surge, so the
                        // tongues swell outward and settle back with the flash.
                        let und = 1 + flameAmount * surge * (0.4 * l1 + 0.35 * l2 + 0.25 * l3);
                        // Scale the tongue strength by how aligned each rim
                        // direction is with the projected spin axis: full flare
                        // along the axis, quieter across it (burnRingAxisBias).
                        if (axisAngle != null) {
                            const cosA = Math.cos(angle - axisAngle);
                            und = 1 + flameAmount * surge
                                * (1 + axisBias * (2 * cosA * cosA - 1))
                                * (0.4 * l1 + 0.35 * l2 + 0.25 * l3);
                        }
                        haloPositions[vi] = burnHaloBasePositions[vi] * und * haloPuff;
                        haloPositions[vi + 1] = burnHaloBasePositions[vi + 1] * und * haloPuff;
                    }
                    burnRingGlowGeometry.attributes.position.needsUpdate = true;
                    const ringVisible = coreOpacity > 0.001;
                    if (burnRingRef.current) burnRingRef.current.visible = ringVisible;
                    if (burnRingGlowRef.current) burnRingGlowRef.current.visible = ringVisible;
                    // Position the group at the ball, then snap its rotation to
                    // the camera so the ring plane faces the camera directly
                    // (a pure rotation about the ball, never a sheared offset).
                    burnRingGroupRef.current.position.copy(position);
                    burnRingGroupRef.current.quaternion.copy(burnCamera.quaternion);
                    // Heat shimmer: drift the ripple shader and fade it in with
                    // the flame, breathing with the halo pulse (and the ignition
                    // surge).
                    burnShimmerMaterial.uniforms.uTime.value = currentSimTime * settings.burnShimmerSpeed;
                    burnShimmerMaterial.uniforms.uOpacity.value = settings.burnShimmerOpacity * fadeIn * (0.6 + 0.4 * haloPulse) * surge;
                    if (burnShimmerRef.current) burnShimmerRef.current.visible = true;
                    // The ball's surface warms with the same halo pulse, so
                    // the whole blaze breathes as one: warmest at full flare,
                    // cooling as the flame tongues settle (never fully
                    // extinguishing while burning).
                    // Crimson flare: the tint also surges when the flame
                    // tongues at the spin-axis direction flare hardest, so the
                    // ball's crimson glow intensifies in step with the fire
                    // licking around it. The ignition surge boosts it too.
                    let flare = 0.5;
                    if (axisAngle != null) {
                        const f1 = Math.sin(axisAngle * 3 + flamePhase);
                        const f2 = Math.sin(axisAngle * 7 + flamePhase * 1.6 + 1.7);
                        const f3 = Math.sin(axisAngle * 2 - flamePhase * 0.8 + 4.2);
                        flare = 0.5 + 0.5 * (0.4 * f1 + 0.35 * f2 + 0.25 * f3);
                    }
                    ballTint = Math.min(1,
                        settings.ballHeatTint * fadeIn * (0.55 + 0.45 * haloPulse)
                            * (1 + settings.burnCrimsonGlow * flare) * surge,
                    );
                } else {
                    if (burnRingRef.current) burnRingRef.current.visible = false;
                    if (burnRingGlowRef.current) burnRingGlowRef.current.visible = false;
                    burnRingMaterial.opacity = 0;
                    burnRingGlowMaterial.opacity = 0;
                    burnShimmerMaterial.uniforms.uOpacity.value = 0;
                    if (burnShimmerRef.current) burnShimmerRef.current.visible = false;
                    // Restore the halo's pristine round rim (only when warped)
                    // so the flame shape never carries into the next burn.
                    const haloPositions = burnRingGlowGeometry.attributes.position.array;
                    if (haloPositions[(BURN_RING_HALO_SEGMENTS + 1) * 3]
                        !== burnHaloBasePositions[(BURN_RING_HALO_SEGMENTS + 1) * 3]) {
                        haloPositions.set(burnHaloBasePositions);
                        burnRingGlowGeometry.attributes.position.needsUpdate = true;
                    }
                }
                // Warm the ball's surface with the ring's flame, and cool it
                // back to its pristine seams whenever the ring is off.
                if (ballRef.current?.userData?.baseballMaterials) {
                    const ballMats = ballRef.current.userData.baseballMaterials;
                    for (let m = 0; m < ballMats.length; m++) {
                        ballMats[m].material.color
                            .copy(ballMats[m].baseColor)
                            .lerp(burnTintColor, ballTint);
                    }
                }
            }

            // Fiery ribbon trail behind the burning ball: a short chain of
            // hot glints sampled from the trajectory just behind the ball
            // each frame, fading out with distance so the pitch drags a
            // comet-like flame instead of a full-length trail. Gated by the
            // same burn conditions as the ring above.
            if (burnTrailMeshRef.current) {
                const burnOn = (pitchData?.speed_mph ?? 90) >= settings.goldRingThresholdMph
                    && !overlay && ballRef.current.visible;
                const trailAlphaAttr = burnTrailGeometry.getAttribute('aAlpha');
                const trailColorAttr = burnTrailGeometry.getAttribute('aColor');
                const trailAlphas = trailAlphaAttr.array;
                const trailColors = trailColorAttr.array;
                const trailCount = Math.min(BURN_TRAIL_MAX_COUNT, Math.max(0, Math.round(settings.burnTrailCount)));
                const trailStep = Math.max(0.001, settings.burnTrailStep);
                const burnStart = Math.max(0, simDuration * settings.burnRingStartFraction);
                const fadeIn = burnOn
                    ? THREE.MathUtils.clamp((currentSimTime - burnStart) / Math.max(0.001, settings.burnRingFadeTime), 0, 1)
                    : 0;
                for (let i = 0; i < BURN_TRAIL_MAX_COUNT; i++) {
                    trailAlphas[i] = 0;
                    if (!burnOn || i >= trailCount) continue;
                    // Sample the trajectory at times just behind the ball: the
                    // newest glint sits at the ball, older ones trail back.
                    const sampleT = currentSimTime - (i + 1) * trailStep;
                    if (sampleT < 0) continue;
                    const trailPos = sampleTrajectoryAtTime(trajectoryData, sampleT);
                    if (!trailPos) continue;
                    // Fade out with distance behind the ball so the ribbon is
                    // short and tapers to nothing.
                    const distP = (i + 1) / Math.max(1, trailCount);
                    const tailFade = 1 - distP * distP * (3 - 2 * distP);
                    // Per-glint twinkle so the flame crackles like the ring.
                    const flick = 0.7 + 0.3 * Math.sin(currentSimTime * settings.burnRingFlickerSpeed + i * 2.4);
                    // Ignition swell: the glints flash brighter and widen
                    // with the ring's surge, so the whole wake visibly swells
                    // as it ignites, then settles back with the ring.
                    trailAlphas[i] = settings.burnTrailOpacity * fadeIn * tailFade * flick * burnSurge;
                    burnTrailDummy.position.copy(trailPos);
                    burnTrailDummy.rotation.set(0, 0, 0);
                    burnTrailDummy.scale.setScalar(
                        settings.burnTrailScale * (0.6 + 0.4 * tailFade)
                            * (1 + BURN_TRAIL_SWELL * (burnSurge - 1)),
                    );
                    burnTrailDummy.updateMatrix();
                    burnTrailMeshRef.current.setMatrixAt(i, burnTrailDummy.matrix);
                    // Dazzling orange at the ball, cooling through orange to
                    // deep crimson at the tail.
                    const colorMix = distP;
                    trailColors[i * 3] = THREE.MathUtils.lerp(BURN_TRAIL_COLOR_HEAD[0], BURN_TRAIL_COLOR_TAIL[0], colorMix);
                    trailColors[i * 3 + 1] = THREE.MathUtils.lerp(BURN_TRAIL_COLOR_HEAD[1], BURN_TRAIL_COLOR_TAIL[1], colorMix);
                    trailColors[i * 3 + 2] = THREE.MathUtils.lerp(BURN_TRAIL_COLOR_HEAD[2], BURN_TRAIL_COLOR_TAIL[2], colorMix);
                }
                trailAlphaAttr.needsUpdate = true;
                trailColorAttr.needsUpdate = true;
                burnTrailMeshRef.current.instanceMatrix.needsUpdate = true;
            }

            // Sparkler: tiny red-orange glints shed radially off the burn ring
            // while it flares, like droplets of fire flying off a spinning
            // sparkler. Each slot runs its own short emission cycle (spread
            // across the slots), spraying outward from its own angle with a
            // little rise, and cools red as it flies. Gated by the same burn
            // conditions as the ring and trail.
            if (burnSparkMeshRef.current) {
                const sparkOn = (pitchData?.speed_mph ?? 90) >= settings.goldRingThresholdMph
                    && !overlay && ballRef.current.visible;
                const sparkAlphaAttr = burnSparkGeometry.getAttribute('aAlpha');
                const sparkColorAttr = burnSparkGeometry.getAttribute('aColor');
                const sparkAlphas = sparkAlphaAttr.array;
                const sparkColors = sparkColorAttr.array;
                const sparkCount = Math.min(BURN_SPARK_MAX_COUNT, Math.max(0, Math.round(settings.burnSparkCount)));
                const sparkLife = Math.max(0.001, settings.burnSparkLife);
                const burnStart = Math.max(0, simDuration * settings.burnRingStartFraction);
                const fadeIn = sparkOn
                    ? THREE.MathUtils.clamp((currentSimTime - burnStart) / Math.max(0.001, settings.burnRingFadeTime), 0, 1)
                    : 0;
                for (let i = 0; i < BURN_SPARK_MAX_COUNT; i++) {
                    sparkAlphas[i] = 0;
                    if (!sparkOn || i >= sparkCount) continue;
                    const seed = burnSparkSeeds[i];
                    const age = (currentSimTime + seed.phase * sparkLife) % sparkLife;
                    const lifeP = age / sparkLife;
                    const fadeOut = 1 - lifeP * lifeP * (3 - 2 * lifeP);
                    const twinkle = 0.6 + 0.4 * Math.sin(age * 40 + seed.twinklePhase);
                    // Ignition surge: the sparks flash brighter, spray wider
                    // from the ring, and fling further with the surge, so the
                    // whole blaze swells together at the zone.
                    sparkAlphas[i] = settings.burnSparkOpacity * fadeIn * fadeOut * seed.alphaJitter * twinkle * burnSurge;
                    // Spray outward from the ring along the spark's own angle,
                    // swung around as the fire rotates, with a little rise. The
                    // surge widens both the launch radius and the flight spread.
                    const sparkAngle = seed.angle + currentSimTime * seed.angularSpeed;
                    const surgeSpread = 1 + BURN_TRAIL_SWELL * (burnSurge - 1);
                    const dist = (BURN_RING_OUTER_RADIUS + lifeP * (0.04 + seed.flareSpeed * 0.02)) * surgeSpread;
                    const posX = Math.cos(sparkAngle) * dist;
                    const posY = Math.sin(sparkAngle) * dist + lifeP * seed.rise * 0.03;
                    // Sparks are instanced at the scene root, so add the ball's
                    // world position to follow it down the flight path.
                    burnSparkDummy.position.set(position.x + posX, position.y + posY, position.z);
                    burnSparkDummy.rotation.set(0, 0, 0);
                    burnSparkDummy.scale.setScalar(
                        settings.burnSparkScale * seed.scaleJitter * (1 - lifeP * 0.6) * surgeSpread,
                    );
                    burnSparkDummy.updateMatrix();
                    burnSparkMeshRef.current.setMatrixAt(i, burnSparkDummy.matrix);
                    // Hot red-orange at birth, cooling through deep red as the
                    // spark flies.
                    const colorMix = seed.colorMix * lifeP;
                    sparkColors[i * 3] = THREE.MathUtils.lerp(BURN_SPARK_COLOR_HEAD[0], BURN_SPARK_COLOR_TAIL[0], colorMix);
                    sparkColors[i * 3 + 1] = THREE.MathUtils.lerp(BURN_SPARK_COLOR_HEAD[1], BURN_SPARK_COLOR_TAIL[1], colorMix);
                    sparkColors[i * 3 + 2] = THREE.MathUtils.lerp(BURN_SPARK_COLOR_HEAD[2], BURN_SPARK_COLOR_TAIL[2], colorMix);
                }
                sparkAlphaAttr.needsUpdate = true;
                sparkColorAttr.needsUpdate = true;
                burnSparkMeshRef.current.instanceMatrix.needsUpdate = true;
            }

            // Progressive reveal for both trail layers, driven by the same
            // time-ordered particle samples:
            //   * colored tail — fades from TRAIL_MAX_OPACITY to 0 as it ages
            //     behind the ball (solomon-gumball's trailing ribbon);
            //   * white trace — visible once traced, then eases from
            //     WHITE_TRACE_OPACITY down to WHITE_TRACE_MIN_OPACITY after the
            //     pitch reaches the plate (dimming the traced path without
            //     removing it).
            if (trailMeshRef.current || whiteTraceMeshRef.current) {
                const tailAlphaAttr = trailGeometry.getAttribute('aAlpha');
                const whiteAlphaAttr = whiteTraceGeometry.getAttribute('aAlpha');
                const tailAlphas = tailAlphaAttr.array;
                const whiteAlphas = whiteAlphaAttr.array;
                const fadeRate = 1 / Math.max(0.001, settings.trailFadeTime);

                let whiteFade = 1;
                if (arrivedAtRef.current >= 0) {
                    const sinceArrival = currentSimTime - arrivedAtRef.current;
                    whiteFade = 1 - Math.min(sinceArrival / Math.max(0.001, settings.whiteTraceFadeTime), 1);
                }
                const trailFactor = overlay ? settings.overlayTrailFactor : 1;
                const traceFactor = overlay ? settings.overlayTraceFactor : 1;
                const whiteAlphaNow = (settings.whiteTraceMinOpacity
                    + (settings.whiteTraceOpacity - settings.whiteTraceMinOpacity) * whiteFade) * traceFactor;

                for (let i = 0; i < particlePoints.length; i++) {
                    const age = currentSimTime - particlePoints[i].t;
                    let tailAlpha = 0;
                    if (age >= 0) {
                        tailAlpha = settings.trailMaxOpacity * trailFactor * (1 - age * fadeRate);
                        if (tailAlpha < 0) tailAlpha = 0;
                    }
                    tailAlphas[i] = tailAlpha;
                    whiteAlphas[i] = (age >= 0 && !whiteTraceClearedRef.current) ? whiteAlphaNow : 0;
                }
                tailAlphaAttr.needsUpdate = true;
                whiteAlphaAttr.needsUpdate = true;
            }

            // Pixelated billow particles: each emits at its own delay spread
            // across the whole flight (at its spawn point on the trajectory),
            // then billows outward/upward, recedes slightly, grows, and fades.
            // Color is lerped from yellow (slow) to red (fast) by the pitch's
            // release speed, like a speed-graded exhaust. Every pitch also
            // emits a white billow layer whose amount scales with speed.
            if (billowMeshRef.current && billowSpawns.length > 0) {
                const speed = pitchData?.speed_mph ?? 90;
                const speedFrac = THREE.MathUtils.clamp(
                    (speed - SPEED_MIN_MPH) / (SPEED_MAX_MPH - SPEED_MIN_MPH), 0, 1,
                );
                const color = [
                    THREE.MathUtils.lerp(SPEED_COLOR_SLOW[0], SPEED_COLOR_FAST[0], speedFrac),
                    THREE.MathUtils.lerp(SPEED_COLOR_SLOW[1], SPEED_COLOR_FAST[1], speedFrac),
                    THREE.MathUtils.lerp(SPEED_COLOR_SLOW[2], SPEED_COLOR_FAST[2], speedFrac),
                ];
                // The yellow→red billow count scales with pitch speed on the
                // same ramp as the trail (30% at 70 mph → 100% at 90+ mph).
                // The golden spark layer now swaps in for the white wake above
                // 99 mph (see the white limit below), so the yellow→red billows
                // stay at their full speed-graded count.
                const billowDensityFrac = getSpeedDensityFrac(speed, settings);
                const billowLimit = Math.min(BILLOW_MAX_COUNT, Math.round(settings.billowCount * billowDensityFrac));
                writeBillowLayer(
                    billowMeshRef.current, billowGeometry, billowSeeds, billowSpawns,
                    currentSimTime, color, billowDummy,
                    1, { limit: billowLimit },
                );
                if (whiteBillowMeshRef.current && whiteBillowSpawns.length > 0) {
                    // White-layer amount stays nearly absent until 85 mph, then
                    // ramps to full by 105 mph — so only genuinely fast pitches
                    // leave a heavy white wake. The white particles are fine
                    // additive glints, smaller than the yellow/red billows.
                    const whiteSpeedFrac = THREE.MathUtils.clamp(
                        (speed - settings.whiteBillowThresholdMph) / Math.max(0.001, SPEED_MAX_MPH - settings.whiteBillowThresholdMph), 0, 1,
                    );
                    const whiteMult = THREE.MathUtils.lerp(
                        settings.whiteBillowMinMultiplier, settings.whiteBillowMaxMultiplier, whiteSpeedFrac,
                    );
                    // Above 85 mph the emitted count ramps up too (4 → 16 by
                    // 105 mph), so fast pitches throw more white particles.
                    let whiteLimit = Math.round(THREE.MathUtils.lerp(
                        settings.whiteBillowCount, settings.whiteBillowCountMax, whiteSpeedFrac,
                    ));
                    // At/above 99 mph the golden spark layer takes over this
                    // many white particles, so a 99+ mph wake reads golden
                    // instead of white while the total particle density stays
                    // the same.
                if (speed >= settings.goldSparkThresholdMph) {
                    whiteLimit = Math.max(0, whiteLimit - settings.goldSparkCount);
                }
                    writeBillowLayer(
                        whiteBillowMeshRef.current, whiteBillowGeometry, whiteBillowSeeds, whiteBillowSpawns,
                        currentSimTime, [1, 1, 1], whiteBillowDummy,
                        whiteMult,
                        {
                            baseScale: 0.02,
                            opacity: 1,
                            limit: whiteLimit,
                            alphaJitterMin: BILLOW_WHITE_JITTER_MIN,
                        },
                    );
                }
                // Golden sparks: only pitches at/over 99 mph emit them; below
                // the threshold the alpha multiplier keeps the layer
                // invisible.
                if (goldSparkMeshRef.current && goldSparkSpawns.length > 0) {
                    const goldMult = speed >= settings.goldSparkThresholdMph ? 1 : 0;
                    writeBillowLayer(
                        goldSparkMeshRef.current, goldSparkGeometry, goldSparkSeeds, goldSparkSpawns,
                        currentSimTime, GOLD_SPARK_COLOR, goldSparkDummy,
                        goldMult,
                        {
                            baseScale: 0.034,
                            scaleGrowth: 3,
                            opacity: 1.15,
                            limit: Math.min(GOLD_SPARK_MAX_COUNT, Math.max(0, Math.round(settings.goldSparkCount))),
                            alphaJitterMin: 1,
                            twinkle: {
                                speed: GOLD_SPARK_TWINKLE_SPEED,
                                depth: GOLD_SPARK_TWINKLE_DEPTH,
                                phase: GOLD_SPARK_TWINKLE_PHASE,
                            },
                        },
                    );
                }
            }

            // Advance the supersonic-crack ripple in the same simulation
            // clock as the ring, so it begins exactly on arrival and respects
            // slow-mo. The ring snaps outward fast (ease-out) while its
            // opacity decays sharply from a white-hot birth flash, and the
            // screen-space distortion pass rides the same clock so the
            // scenery behind the plate bends with the crack.
            if (rippleAnim.current.active) {
                rippleAnim.current.t += delta * getTimeScale();
                const rippleP = Math.min(rippleAnim.current.t / Math.max(0.001, settings.rippleLife), 1);
                const rippleEase = 1 - Math.pow(1 - rippleP, 3);
                const rippleOpacity = settings.rippleOpacity * Math.exp(-5 * rippleP);
                const rippleScale = THREE.MathUtils.lerp(1, settings.rippleMaxScale, rippleEase);
                if (rippleMeshRef.current) {
                    rippleMeshRef.current.scale.setScalar(rippleScale);
                    rippleMeshRef.current.material.uniforms.uOpacity.value = rippleOpacity;
                    rippleMeshRef.current.material.uniforms.uTime.value = rippleAnim.current.t * 30;
                    rippleMeshRef.current.visible = rippleOpacity > 0.001;
                }
                // Publish the live shock state so the distortion pass bends
                // the scenery behind the expanding ring.
                if (!overlay && hawkeyeCrossingM) {
                    impactDistortion.active = true;
                    impactDistortion.time = rippleAnim.current.t;
                    impactDistortion.pos.set(hawkeyeCrossingM[0], hawkeyeCrossingM[1], FRONT_OF_PLATE_Z);
                    impactDistortion.radius = RING_OUTER_RADIUS * rippleScale;
                    impactDistortion.life = settings.rippleLife;
                }
                if (rippleP >= 1) {
                    // The ring flash is done, but the screen-space shockwave
                    // keeps rolling out at SHOCK_SWEEP_FACTOR times the
                    // ring's speed (the pass reaches off-screen in
                    // SHOCK_SWEEP_FACTOR × the ripple life), so keep the anim
                    // running as a pure shock clock until it has swept past
                    // the frame.
                    rippleMaterial.uniforms.uOpacity.value = 0;
                    if (rippleMeshRef.current) rippleMeshRef.current.visible = false;
                    if (rippleAnim.current.t >= settings.rippleLife * SHOCK_SWEEP_FACTOR) {
                        rippleAnim.current.active = false;
                        rippleAnim.current.t = 0;
                        impactDistortion.active = false;
                    }
                }
            }

            // Impact fire burst: white-hot → red fire lances radially out of
            // the strike-zone ring the instant a 100+ mph pitch reaches the
            // zone. Runs on the same simulation clock as the ring (respects
            // slow-mo), triggered once per arrival, and dies out a beat after
            // the white-hot flash.
            if (impactFireAnim.current.active && hawkeyeCrossingM && impactFireMeshRef.current) {
                impactFireAnim.current.t += delta * getTimeScale();
                const fireAlphaAttr = impactFireGeometry.getAttribute('aAlpha');
                const fireColorAttr = impactFireGeometry.getAttribute('aColor');
                const fireAlphas = fireAlphaAttr.array;
                const fireColors = fireColorAttr.array;
                const originX = hawkeyeCrossingM[0];
                const originY = hawkeyeCrossingM[1];
                const originZ = FRONT_OF_PLATE_Z;
                let stillActive = false;
                // The first IMPACT_FIRE_MAX_COUNT slots are the main blobs;
                // the rest are trailing ember wisps (IMPACT_FIRE_WISP_PER_BLOB
                // per blob), recomputed from the same burst math at a small
                // time lag so they hug each blob's path without history
                // buffers.
                for (let i = 0; i < IMPACT_FIRE_TOTAL; i++) {
                    fireAlphas[i] = 0;
                    const blobSlot = i % IMPACT_FIRE_MAX_COUNT;
                    const kind = Math.floor(i / IMPACT_FIRE_MAX_COUNT);
                    const seed = impactFireSeeds[blobSlot];
                    const lag = kind === 0 ? 0 : IMPACT_FIRE_WISP_LAGS[kind - 1];
                    const age = impactFireAnim.current.t - seed.delay - lag;
                    if (age < 0 || age >= seed.life) continue;
                    if (kind === 0) stillActive = true;
                    const lifeP = age / seed.life;
                    const fadeIn = Math.min(age / 0.06, 1);
                    const fadeOut = 1 - lifeP * lifeP * (3 - 2 * lifeP);
                    const twinkle = 0.7 + 0.3 * Math.sin(age * 30 + seed.twinklePhase);
                    // Wisps are dimmer echoes of their blob.
                    const wispFade = kind === 0 ? 1 : 0.5 * (1 - lag / seed.life);
                    fireAlphas[i] = settings.impactFireOpacity * fadeIn * fadeOut * seed.alphaJitter * twinkle * wispFade;
                    const fireCol = kind === 0 ? 1 : THREE.MathUtils.clamp(0.75 + lag, 0, 1);
                    // Lance radially out of the ring, easing out slowly (power
                    // 0.85 so the burst crawls out rather than snapping), with
                    // a little rise and a lateral swirl — the fire licks
                    // sideways as it spreads, unlike the beams' dead-straight
                    // radial lances.
                    const dist = RING_OUTER_RADIUS + Math.pow(lifeP, 0.85) * seed.speed * settings.impactFireSpread;
                    const swirl = lifeP * 0.7 * Math.sin(age * 4 + seed.twinklePhase);
                    const fireAngle = seed.angle + swirl;
                    const posX = originX + Math.cos(fireAngle) * dist;
                    const posY = originY + Math.sin(fireAngle) * dist + lifeP * seed.rise * 0.05;
                    // Slight depth so the burst reads as a voluminous fireball
                    // sheet instead of a flat in-plane spray.
                    const posZ = originZ + (seed.twinklePhase - Math.PI) * 0.015 * lifeP;
                    impactFireDummy.position.set(posX, posY, posZ);
                    impactFireDummy.rotation.set(0, 0, 0);
                    // Fire blobs grow as they spread; wisps stay small and
                    // shrink toward the tail.
                    const wispScale = kind === 0 ? 1 : 0.55;
                    impactFireDummy.scale.setScalar(settings.impactFireScale * seed.scaleJitter * (1 + lifeP * 1.4) * wispScale);
                    impactFireDummy.updateMatrix();
                    impactFireMeshRef.current.setMatrixAt(i, impactFireDummy.matrix);
                    // Dazzling orange at birth, cooling through ember orange
                    // to the deep crimson undertone as the burst lances
                    // outward. Wisps run cooler: their color progress is
                    // pushed forward by the lag so the trail reads as fire
                    // already cooling behind the blob.
                    const colorLifeP = kind === 0 ? lifeP : Math.min(1, lifeP + lag / seed.life);
                    let fireR;
                    let fireG;
                    let fireB;
                    if (colorLifeP < 0.45) {
                        const k = colorLifeP / 0.45;
                        fireR = THREE.MathUtils.lerp(IMPACT_FIRE_COLOR_ORANGE[0], IMPACT_FIRE_COLOR_ORANGE_MID[0], k);
                        fireG = THREE.MathUtils.lerp(IMPACT_FIRE_COLOR_ORANGE[1], IMPACT_FIRE_COLOR_ORANGE_MID[1], k);
                        fireB = THREE.MathUtils.lerp(IMPACT_FIRE_COLOR_ORANGE[2], IMPACT_FIRE_COLOR_ORANGE_MID[2], k);
                    } else {
                        const k = (colorLifeP - 0.45) / 0.55;
                        fireR = THREE.MathUtils.lerp(IMPACT_FIRE_COLOR_ORANGE_MID[0], IMPACT_FIRE_COLOR_RED[0], k);
                        fireG = THREE.MathUtils.lerp(IMPACT_FIRE_COLOR_ORANGE_MID[1], IMPACT_FIRE_COLOR_RED[1], k);
                        fireB = THREE.MathUtils.lerp(IMPACT_FIRE_COLOR_ORANGE_MID[2], IMPACT_FIRE_COLOR_RED[2], k);
                    }
                    fireColors[i * 3] = fireR * fireCol;
                    fireColors[i * 3 + 1] = fireG * fireCol;
                    fireColors[i * 3 + 2] = fireB * fireCol;
                }
                fireAlphaAttr.needsUpdate = true;
                fireColorAttr.needsUpdate = true;
                impactFireMeshRef.current.instanceMatrix.needsUpdate = true;
                if (!stillActive) {
                    impactFireAnim.current.active = false;
                    impactFireAnim.current.t = 0;
                }
            }

            // Advance the ring's appearance animation (impact pulse on arrival,
            // gradual settle to the white trace's opacity, fade-out on replay
            // reset) using the shared time scale so it stays in sync with the
            // playback speed.
            const anim = ringAnim.current;
            if (anim.phase !== 'idle') {
                anim.t += delta * getTimeScale();
                let finalOpacity = 0;
                let scale = 1;
                if (anim.phase === 'pulse') {
                    const p = Math.min(anim.t / Math.max(0.001, settings.ringPulseTime), 1);
                    const ease = 1 - Math.pow(1 - p, 3); // ease-out cubic
                    finalOpacity = settings.ringMaxOpacity * ease;
                    // Start large & transparent, shrink to normal size while gaining opacity
                    scale = 1 + settings.ringPulseOvershoot * (1 - ease);
                    if (p >= 1) {
                        anim.phase = 'settle';
                        anim.t = 0;
                    }
                } else if (anim.phase === 'settle') {
                    // Hold at the white-hot flash for ringHoldTime, then ease
                    // gradually from the impact flash down to
                    // RING_SETTLED_OPACITY — a bit more opaque than the white
                    // trace's settled level, so the marker stays legible after
                    // the fade-out of the impact flash.
                    const hold = Math.max(0, settings.ringHoldTime);
                    const settleT = Math.max(0, anim.t - hold);
                    const p = Math.min(settleT / Math.max(0.001, settings.ringSettleTime), 1);
                    const ease = p * p * (3 - 2 * p); // smoothstep out
                    finalOpacity = THREE.MathUtils.lerp(
                        settings.ringMaxOpacity, settings.ringSettledOpacity, ease,
                    );
                    scale = 1;
                    if (p >= 1) anim.phase = 'steady';
                } else if (anim.phase === 'steady') {
                    finalOpacity = settings.ringSettledOpacity;
                    scale = 1;
                } else if (anim.phase === 'fadeout') {
                    const p = Math.min(anim.t / Math.max(0.001, settings.ringFadeTime), 1);
                    finalOpacity = settings.ringSettledOpacity * (1 - p * p * (3 - 2 * p));
                    scale = 1;
                    if (p >= 1) anim.phase = 'idle';
                }
                // Blazing-hot ring for 100+ mph: white-hot on impact, cooling
                // through yellow as the ring settles. The glow color is
                // written to ringGlowColor and shared by the ring mesh, the
                // strike-zone lines, and the smoke so the whole impact reads
                // as one heat source.
                const pitchSpd = pitchData?.speed_mph ?? 90;
                if (pitchSpd >= settings.goldRingThresholdMph) {
                    // Store the glow in plain sRGB 0..1 values (no color-space
                    // conversion): the smoke instanced shader reads them raw,
                    // and the ring mesh re-applies SRGBColorSpace at the end.
                    if (anim.phase === 'pulse') {
                        // Pure white-hot during the impact flash.
                        ringGlowColor.setRGB(1, 1, 1);
                    } else if (anim.phase === 'settle') {
                        // Hold pure white-hot for ringHoldTime after the
                        // impact flash, then cool white → gold as the ring
                        // settles to ember-yellow.
                        const hold = Math.max(0, settings.ringHoldTime);
                        const coolT = Math.max(0, anim.t - hold);
                        const coolP = Math.min(coolT / Math.max(0.001, settings.ringSettleTime), 1);
                        const coolEase = coolP * coolP * (3 - 2 * coolP);
                        ringGlowColor.setRGB(
                            THREE.MathUtils.lerp(1, GOLD_SPARK_COLOR[0], coolEase),
                            THREE.MathUtils.lerp(1, GOLD_SPARK_COLOR[1], coolEase),
                            THREE.MathUtils.lerp(1, GOLD_SPARK_COLOR[2], coolEase),
                        );
                    } else if (anim.phase === 'steady') {
                        // Settled ember gold with a brief, subtle
                        // orange-red flicker so the cooling ring reads
                        // alive rather than flat. Two detuned sines give
                        // an organic, non-mechanical pulse.
                        const flick = (0.5 + 0.5 * Math.sin(anim.t * settings.ringFlickerSpeed))
                            * (0.5 + 0.5 * Math.sin(anim.t * settings.ringFlickerSpeed * 1.7 + 1.3));
                        const flickerMix = flick * settings.ringFlickerDepth;
                        ringGlowColor.setRGB(
                            THREE.MathUtils.lerp(GOLD_SPARK_COLOR[0], EMBER_ORANGE[0], flickerMix),
                            THREE.MathUtils.lerp(GOLD_SPARK_COLOR[1], EMBER_ORANGE[1], flickerMix),
                            THREE.MathUtils.lerp(GOLD_SPARK_COLOR[2], EMBER_ORANGE[2], flickerMix),
                        );
                    } else {
                        // Fadeout: full ember gold.
                        ringGlowColor.setRGB(
                            GOLD_SPARK_COLOR[0], GOLD_SPARK_COLOR[1], GOLD_SPARK_COLOR[2],
                        );
                    }
                }
                if (ringMeshRef.current) {
                    ringMeshRef.current.material.opacity = finalOpacity;
                    ringMeshRef.current.visible = finalOpacity > 0.001;
                    if (pitchSpd >= settings.goldRingThresholdMph) {
                        ringMeshRef.current.material.color.setRGB(
                            ringGlowColor.r, ringGlowColor.g, ringGlowColor.b,
                            THREE.SRGBColorSpace,
                        );
                    }
                }
                if (ringGroupRef.current) ringGroupRef.current.scale.setScalar(scale);
            }
            const pitchSpeed = pitchData?.speed_mph ?? 90;
            const is100Plus = pitchSpeed >= settings.goldRingThresholdMph;
            // Heat glow: the strike-zone lines are illuminated by the ring's
            // live glow color (white-hot → ember gold), tinted toward it while
            // the ring is hot and easing back to plain white once it cools.
            // Only the 100+ mph treatment heats up (the ring is white there).
            if (is100Plus) {
                // 0..1 heat of the impact flash: 1 at the white-hot peak,
                // easing to 0 once the ring has fully settled.
                let heat = 0;
                if (anim.phase === 'pulse') {
                    const p = Math.min(anim.t / Math.max(0.001, settings.ringPulseTime), 1);
                    heat = 1 - Math.pow(1 - p, 3); // ease-out cubic
                } else if (anim.phase === 'settle') {
                    // The lines stay hot during the white-hot hold, then ease
                    // back down as the ring cools.
                    const hold = Math.max(0, settings.ringHoldTime);
                    const p = Math.min(Math.max(0, anim.t - hold) / Math.max(0.001, settings.ringSettleTime), 1);
                    const ease = p * p * (3 - 2 * p);
                    heat = 1 - ease; // cools back down
                }
                // Fire-colored radial glow: the strike-zone grid flashes
                // dazzling orange at the crossing spot on impact, fading to
                // the deep crimson undertone toward the zone's edges — each
                // line tinted brighter the closer it sits to the impact
                // point, so the zone reads as radiating heat outward from a
                // single source.
                if (zoneLineRefs.current.length > 0 && is100Plus) {
                    const tintP = heat * settings.zoneHeatTint;
                    const cx = hawkeyeCrossingM ? hawkeyeCrossingM[0] : 0;
                    const cy = hawkeyeCrossingM ? hawkeyeCrossingM[1] : (szTopM + szBottomM) / 2;
                    // Falloff radius spans roughly the zone's half-diagonal so
                    // the inner grid glows hottest and the outer border cools.
                    const radialRadius = Math.max(0.001, Math.hypot(szHalfW, (szTopM - szBottomM) / 2));
                    for (let i = 0; i < zoneLineRefs.current.length; i++) {
                        const line = zoneLineRefs.current[i];
                        if (!line || !line.material || !line.material.color) continue;
                        const mid = zoneLineMidpoints[i];
                        // Distance from the crossing spot to the line's
                        // midpoint, normalized 0 (at impact) → 1 (zone edge).
                        const distP = Math.max(0, Math.min(1, Math.hypot(mid[0] - cx, mid[1] - cy) / radialRadius));
                        // Radial ramp: hottest near the impact point, cooling
                        // smoothly toward the deep crimson at the zone's edge.
                        const ramp = 1 - distP * distP * (3 - 2 * distP);
                        // Blend hot-set with a radial dampening from a common
                        // (trailing) heat: the glow pulls inwards as heat drops.
                        zoneLineTint.lerpColors(zoneHeatGlowCool, zoneHeatGlowHot, ramp);
                        line.material.color.setRGB(
                            zoneLineWhite.r * (1 - tintP)
                                + zoneLineTint.r * tintP,
                            zoneLineWhite.g * (1 - tintP)
                                + zoneLineTint.g * tintP,
                            zoneLineWhite.b * (1 - tintP)
                                + zoneLineTint.b * tintP,
                            THREE.SRGBColorSpace,
                        );
                    }
                }
            }
            // Advance ring-alive clock: accumulates real time while the ring
            // is visible, resets when it goes idle, so lingering particles
            // can use it for continuous emission.
            if (anim.phase !== 'idle' && !ringClearedRef.current && !whiteTraceClearedRef.current) {
                ringAliveClockRef.current += delta * getTimeScale();
            } else {
                ringAliveClockRef.current = 0;
                if (ringLingerMeshRef.current) {
                    const lingerAlphaAttr = ringLingerGeometry.getAttribute('aAlpha');
                    lingerAlphaAttr.array.fill(0);
                    lingerAlphaAttr.needsUpdate = true;
                }
                if (smokeMeshRef.current) {
                    const smokeAlphaAttr = smokeGeometry.getAttribute('aAlpha');
                    smokeAlphaAttr.array.fill(0);
                    smokeAlphaAttr.needsUpdate = true;
                }
                if (ringEmberMeshRef.current) {
                    const emberAlphaAttr = ringEmberGeometry.getAttribute('aAlpha');
                    emberAlphaAttr.array.fill(0);
                    emberAlphaAttr.needsUpdate = true;
                }
            }
            // Ring spikes: only for 100+ mph pitches — thicker beams that
            // expand outward + lingering upward particles around the ring.
            // Below 100 mph there are no ring particles at all.
            if (is100Plus && (ringSpikeMeshRef.current || ringLingerMeshRef.current || smokeMeshRef.current)) {
                const ringVisible = anim.phase !== 'idle';
                const burst = anim.phase === 'pulse'
                    ? Math.sin(Math.min(anim.t / Math.max(0.001, settings.ringPulseTime), 1) * Math.PI)
                    : 0;
                const ringFade = anim.phase === 'fadeout'
                    ? Math.max(0, 1 - anim.t / Math.max(0.001, settings.ringFadeTime))
                    : 1;

                // === 100+ mph: thicker, expanding, no rotation ===
                const expandAge = ringAliveClockRef.current;
                // Expand outward from the ring: burst distance then keep growing.
                const expandDist = RING_OUTER_RADIUS * settings.ringSpikeBurstFactor * burst
                    + settings.ringSpikeExpandSpeed * Math.max(0, expandAge - settings.ringPulseTime * 0.3);
                // Fade: bright through the pulse, then ease out as they expand
                const burstBrightness = anim.phase === 'pulse'
                    ? Math.min(anim.t / Math.max(0.001, settings.ringPulseTime * 0.12), 1)
                    : 1;
                const expandFade = expandAge > settings.ringPulseTime * 0.3
                    ? Math.max(0, 1 - (expandAge - settings.ringPulseTime * 0.3) / Math.max(0.001, settings.ringSpikeFade))
                    : 1;
                const driftFade = Math.max(0, 1 - Math.max(0, expandAge - settings.ringPulseTime) / Math.max(0.001, settings.ringSpikeDriftFade));
                const spikeFade100 = burstBrightness * expandFade * driftFade * ringFade;
                if (ringSpikeMeshRef.current) {
                    const spike100ColorAttr = ringSpikeGeometry100.getAttribute('aColor');
                const spike100AlphaAttr = ringSpikeGeometry100.getAttribute('aAlpha');
                const spike100Colors = spike100ColorAttr.array;
                const spike100Alphas = spike100AlphaAttr.array;
                const spikeLimit = Math.min(RING_SPIKE_MAX_COUNT, Math.max(0, Math.round(settings.ringSpikeCount)));
                for (let i = 0; i < RING_SPIKE_MAX_COUNT; i++) {
                    const seed = ringSpikeSeeds[i];
                    const alpha = ringVisible && i < spikeLimit
                        ? settings.ringSpikeOpacity * spikeFade100 * seed.scaleJitter
                        : 0;
                    spike100Alphas[i] = alpha;
                    // The seed pool is fixed at max capacity, but the active
                    // count is tunable. Re-map visible slots to the selected
                    // count so reducing the count still covers the entire
                    // perimeter instead of taking only the first arc of the
                    // max-capacity ring.
                    const activeFraction = i / Math.max(1, spikeLimit);
                    const seedFraction = i / RING_SPIKE_MAX_COUNT;
                    const spikeAngle = seed.angle + (activeFraction - seedFraction) * Math.PI * 2;
                    // Scale grows as the spike expands for a light-beam feel
                    const expandScale = 1 + burst * 0.6 + Math.max(0, expandAge - settings.ringPulseTime * 0.3) * 1.8;
                    // Beam length along its long +Y axis at this frame's
                    // expansion (the box's base height × Y scale).
                    const beamLen = RING_SPIKE_HEIGHT_100 * seed.scaleJitter * expandScale * seed.lengthJitter;
                    // Anchor the beam's INNER end on the ring circumference and
                    // extend it outward only (the box is centered, so shift the
                    // center out by half the beam length). The beams lance out
                    // of the ring's edge instead of straddling the center, and
                    // their outer tip is capped at 2× the ring radius so they
                    // stop short of the ring's footprint.
                    const innerEnd = RING_SPIKE_RADIUS + expandDist;
                    const clampedLen = Math.max(0, Math.min(beamLen, RING_SPIKE_MAX_REACH - innerEnd));
                    const radialDist = innerEnd + clampedLen * 0.5;
                    const baseX = Math.cos(spikeAngle) * radialDist;
                    const baseY = Math.sin(spikeAngle) * radialDist;
                    ringSpikeDummy.position.set(baseX, baseY, seed.zOffset);
                    ringSpikeDummy.scale.set(
                        seed.scaleJitter,
                        clampedLen / RING_SPIKE_HEIGHT_100,
                        seed.scaleJitter,
                    );
                    // The box's long local axis is +Y. Rotate it so that axis
                    // follows the exact radial vector from the ring center to
                    // this beam's current position.
                    const radialRotZ = Math.atan2(baseY, baseX) - Math.PI / 2;
                    ringSpikeDummy.rotation.set(0, 0, radialRotZ);
                    ringSpikeDummy.updateMatrix();
                    ringSpikeMeshRef.current.setMatrixAt(i, ringSpikeDummy.matrix);
                    const spikeColor = seed.color || RING_SPIKE_COLOR;
                    spike100Colors[i * 3] = spikeColor[0];
                    spike100Colors[i * 3 + 1] = spikeColor[1];
                    spike100Colors[i * 3 + 2] = spikeColor[2];
                }
                spike100ColorAttr.needsUpdate = true;
                spike100AlphaAttr.needsUpdate = true;
                    ringSpikeMeshRef.current.instanceMatrix.needsUpdate = true;
                }

                // === Lingering particles: keep emitting upward from random ring spots ===
                if (ringLingerMeshRef.current) {
                    const lingerColorAttr = ringLingerGeometry.getAttribute('aColor');
                    const lingerAlphaAttr = ringLingerGeometry.getAttribute('aAlpha');
                    const lingerColors = lingerColorAttr.array;
                    const lingerAlphas = lingerAlphaAttr.array;
                    const lingerTime = ringAliveClockRef.current;
                    // Keep emitting the lingering beams at full opacity for as
                    // long as the impact ring stays alive, but thin them out to
                    // a fraction of the count once the initial 0.5s flash has
                    // passed so the fading drift reads sparse.
                    const lingerCount = Math.min(RING_LINGER_MAX_COUNT, Math.max(0, Math.round(settings.ringLingerCount)));
                    const lingeringLimit = lingerTime < settings.ringLingerLateAt
                        ? lingerCount
                        : Math.max(0, Math.round(lingerCount * settings.ringLingerLateFraction));
                    const lingeringOpacity = settings.ringLingerOpacity;
                    const emissionCycle = Math.max(0.001, settings.ringLingerSpawnSpan);
                    for (let i = 0; i < RING_LINGER_MAX_COUNT; i++) {
                        const seed = ringLingerSeeds[i];
                        if (i >= lingeringLimit) {
                            lingerAlphas[i] = 0;
                            continue;
                        }
                        // Recycle each slot continuously while the ring remains
                        // alive. A new random angle is selected per cycle so
                        // emissions cover different points around the full ring.
                        const cycle = Math.floor(Math.max(0, lingerTime - seed.delay) / emissionCycle);
                        const age = lingerTime - seed.delay - cycle * emissionCycle;
                        const cycleAngle = seed.angle + cycle * 2.399963229728653;
                        const angleJitter = Math.sin(cycle * 12.9898 + i * 78.233) * 0.5 + 0.5;
                        const emissionAngle = cycleAngle + angleJitter * Math.PI * 2;
                        lingerAlphas[i] = 0;
                        if (!ringVisible || age < 0) continue;
                        const lifeP = age / Math.max(0.001, settings.ringLingerLife);
                        if (lifeP >= 1) continue;
                        const fadeIn = Math.min(age / Math.max(0.001, settings.ringLingerFadeIn), 1);
                        const fadeOut = 1 - lifeP * lifeP * (3 - 2 * lifeP);
                        // The lingering beams pulse in sync with the ring's
                        // steady-phase ember flicker (the same two detuned
                        // sines), so the whole impact breathes together.
                        let lingerPulse = 1;
                        if (anim.phase === 'steady') {
                            const flick = (0.5 + 0.5 * Math.sin(anim.t * settings.ringFlickerSpeed))
                                * (0.5 + 0.5 * Math.sin(anim.t * settings.ringFlickerSpeed * 1.7 + 1.3));
                            lingerPulse = 1 + (flick * 2 - 1) * settings.lingerPulseAmount;
                        }
                        lingerAlphas[i] = lingeringOpacity * fadeIn * fadeOut * seed.alphaJitter * ringFade * lingerPulse;
                        const posX = Math.cos(emissionAngle) * RING_OUTER_RADIUS;
                        const posY = Math.sin(emissionAngle) * RING_OUTER_RADIUS + seed.driftSpeed * age;
                        ringLingerDummy.position.set(posX, posY, seed.zOffset);
                        // Stay upright (no rotation)
                        ringLingerDummy.rotation.set(0, 0, 0);
                        const lingerScale = seed.scaleJitter * (1 + age * 0.8);
                        ringLingerDummy.scale.setScalar(lingerScale);
                        ringLingerDummy.updateMatrix();
                        ringLingerMeshRef.current.setMatrixAt(i, ringLingerDummy.matrix);
                        const lingerColor = seed.color || RING_LINGER_COLOR;
                        lingerColors[i * 3] = lingerColor[0];
                        lingerColors[i * 3 + 1] = lingerColor[1];
                        lingerColors[i * 3 + 2] = lingerColor[2];
                    }
                    lingerColorAttr.needsUpdate = true;
                    lingerAlphaAttr.needsUpdate = true;
                    ringLingerMeshRef.current.instanceMatrix.needsUpdate = true;
                }

                // Smoke puffs use a single non-additive layer so their neutral
                // colors stay soft and cloudy instead of becoming more beams.
                if (smokeMeshRef.current) {
                    const smokeColorAttr = smokeGeometry.getAttribute('aColor');
                    const smokeAlphaAttr = smokeGeometry.getAttribute('aAlpha');
                    const smokeColors = smokeColorAttr.array;
                    const smokeAlphas = smokeAlphaAttr.array;
                    const smokeTime = ringAliveClockRef.current;
                    const smokeCycle = Math.max(0.001, settings.smokeSpawnSpan);
                    const smokeLimit = Math.min(SMOKE_MAX_COUNT, Math.max(0, Math.round(settings.smokeCount)));
                    for (let i = 0; i < smokeSeeds.length; i++) {
                        const seed = smokeSeeds[i];
                        smokeAlphas[i] = 0;
                        if (i >= smokeLimit) continue;
                        const cycle = Math.floor(Math.max(0, smokeTime - seed.delay) / smokeCycle);
                        const age = smokeTime - seed.delay - cycle * smokeCycle;
                        if (!ringVisible || age < 0 || age >= settings.smokeLife) continue;
                        const cycleAngle = seed.startAngle + cycle * 2.399963229728653;
                        const angleJitter = Math.sin(cycle * 12.9898 + i * 78.233) * 0.5 + 0.5;
                        const emissionAngle = cycleAngle + angleJitter * Math.PI * 2;
                        const lifeP = age / Math.max(0.001, settings.smokeLife);
                        const fadeIn = Math.min(age / Math.max(0.001, settings.smokeFadeIn), 1);
                        // Billowing, feathered dissipation: the plume holds its
                        // body through mid-life, then feathers off with a soft,
                        // irregular tail (a sub-linear power for fullness plus a
                        // wobbling billow instead of a uniform smoothstep), so the
                        // smoke dissipates less evenly.
                        const feathered = Math.pow(Math.max(0, 1 - lifeP), 0.55);
                        const billow = 0.85 + 0.15 * Math.sin(lifeP * Math.PI * 5 + seed.swayPhase);
                        const fadeOut = feathered * billow;
                        // Puffs keep growing as they age, and their opacity eases
                        // down as they inflate so bigger clouds read more wispy.
                        const growth = 1 + settings.smokeScaleGrowth * lifeP;
                        const growFade = 1 / (1 + settings.smokeGrowthFade * lifeP);
                        // Keep the impact smoke translucent so the ember
                        // particles remain visible through the ring.
                        let alpha = settings.smokeOpacity * 0.65 * seed.alphaJitter * fadeIn * fadeOut * growFade * ringFade;
                        // Only white puffs vary upward from the shared minimum;
                        // black keeps the standard opacity line.
                        alpha *= seed.boost;
                        smokeAlphas[i] = alpha;
                        const radius = seed.radius * (1 + age * 0.35);
                        // Drift outward/up plus a small sinusoidal sideways
                        // wobble so each puff veers randomly left/right.
                        const sway = Math.sin(age * seed.swaySpeed + seed.swayPhase) * seed.swayAmp;
                        smokeDummy.position.set(
                            Math.cos(emissionAngle) * radius + seed.driftX * age + sway,
                            Math.sin(emissionAngle) * radius + seed.riseSpeed * age,
                            seed.startZ + seed.driftZ * age,
                        );
                        // Brighter (more opaque) white puffs spawn smaller.
                        const smokeScale = seed.scaleJitter * growth * seed.whiteScaleFactor;
                        smokeDummy.scale.setScalar(settings.smokeBaseScale * smokeScale);
                        smokeDummy.rotation.set(0, 0, 0);
                        smokeDummy.updateMatrix();
                        smokeMeshRef.current.setMatrixAt(i, smokeDummy.matrix);
                        const smokeColor = seed.color;
                        // The ring line illuminates the smoke: young puffs
                        // are lit by the ring's live glow color (white-hot on
                        // the flash, cooling through ember gold), then fall
                        // back toward their neutral tone as they rise away.
                        // The tint is strongest at birth and eases off over
                        // the puff's life, so the smoke reads as rising off
                        // the still-hot ring.
                        const warmMix = Math.pow(1 - lifeP, Math.max(0.001, settings.smokeWarmFalloff))
                            * settings.smokeWarmAmount;
                        smokeColors[i * 3] = THREE.MathUtils.lerp(smokeColor[0], ringGlowColor.r, warmMix);
                        smokeColors[i * 3 + 1] = THREE.MathUtils.lerp(smokeColor[1], ringGlowColor.g, warmMix);
                        smokeColors[i * 3 + 2] = THREE.MathUtils.lerp(smokeColor[2], ringGlowColor.b, warmMix);
                    }
                    smokeColorAttr.needsUpdate = true;
                    smokeAlphaAttr.needsUpdate = true;
                    smokeMeshRef.current.instanceMatrix.needsUpdate = true;
                }

                // Embers: tiny hot glints shed from the ring as it cools
                // (settle/steady/fadeout — never during the white-hot impact
                // flash). Each rises with a little lateral drift, twinkles
                // on its own phase, and fades as it cools.
                if (ringEmberMeshRef.current) {
                    const emberColorAttr = ringEmberGeometry.getAttribute('aColor');
                    const emberAlphaAttr = ringEmberGeometry.getAttribute('aAlpha');
                    const emberColors = emberColorAttr.array;
                    const emberAlphas = emberAlphaAttr.array;
                    const emberTime = ringAliveClockRef.current;
                    const emberCycle = Math.max(0.001, settings.emberSpawnSpan);
                    const emberLimit = Math.min(RING_EMBER_MAX_COUNT, Math.max(0, Math.round(settings.emberCount)));
                    // No embers during the pulse: they only appear as the
                    // ring starts cooling off.
                    const emberActive = ringVisible && anim.phase !== 'pulse';
                    for (let i = 0; i < RING_EMBER_MAX_COUNT; i++) {
                        const seed = ringEmberSeeds[i];
                        emberAlphas[i] = 0;
                        if (!emberActive || i >= emberLimit) continue;
                        const cycle = Math.floor(Math.max(0, emberTime - seed.delay) / emberCycle);
                        const age = emberTime - seed.delay - cycle * emberCycle;
                        if (age < 0 || age >= settings.emberLife) continue;
                        const lifeP = age / Math.max(0.001, settings.emberLife);
                        const fadeIn = Math.min(age / Math.max(0.001, settings.emberFadeIn), 1);
                        const fadeOut = 1 - lifeP * lifeP * (3 - 2 * lifeP);
                        // Twinkle: each ember flickers on its own phase so
                        // the shed sparks read alive rather than static dots.
                        const twinkle = 0.5 + 0.5 * Math.sin(age * seed.twinkleSpeed + seed.twinklePhase);
                        const twinkleFactor = 1 - 0.35 + 0.35 * twinkle;
                        // Birth pop: each ember snaps briefly larger and
                        // brighter right after shedding (a tiny burst), then
                        // settles — the pop is shared by the scale and the
                        // alpha below so the burst reads as one hot snap.
                        const pop = Math.exp(-age * settings.emberPopRate);
                        const alphaPop = 1 + settings.emberPopOpacity * pop;
                        emberAlphas[i] = settings.emberOpacity * fadeIn * fadeOut * seed.alphaJitter * twinkleFactor * alphaPop * ringFade;
                        const cycleAngle = seed.angle + cycle * 2.399963229728653;
                        const angleJitter = Math.sin(cycle * 12.9898 + i * 78.233) * 0.5 + 0.5;
                        const emissionAngle = cycleAngle + angleJitter * Math.PI * 2;
                        // Scatter: each ember pops outward from the ring along
                        // its emission angle with a fast ease-out (a tiny
                        // burst), on top of the steady upward rise + lateral
                        // drift.
                        const scatterT = Math.min(age / Math.max(0.001, settings.emberScatterTime), 1);
                        const scatterEase = 1 - Math.pow(1 - scatterT, 3); // ease-out cubic
                        const scatterDist = settings.emberScatterSpeed * scatterEase;
                        const posX = Math.cos(emissionAngle) * (RING_OUTER_RADIUS + scatterDist)
                            + Math.cos(seed.driftAngle) * seed.driftSpeed * age;
                        const posY = Math.sin(emissionAngle) * (RING_OUTER_RADIUS + scatterDist) + seed.riseSpeed * age;
                        ringEmberDummy.position.set(posX, posY, seed.zOffset);
                        ringEmberDummy.rotation.set(0, 0, 0);
                        const popScale = 1 + settings.emberPopAmount * pop;
                        const emberScale = seed.scaleJitter * popScale * (1 + age * 0.6) * (0.75 + 0.25 * twinkle);
                        ringEmberDummy.scale.setScalar(settings.emberBaseScale * emberScale);
                        ringEmberDummy.updateMatrix();
                        ringEmberMeshRef.current.setMatrixAt(i, ringEmberDummy.matrix);
                        const emberColor = seed.color || RING_EMBER_COLOR;
                        // The ring line illuminates the embers: each spark
                        // picks up the ring's live glow color (white-hot on
                        // the flash, cooling through ember gold) so sparks
                        // match the ring's heat, then cools back toward its
                        // own red as it ages. Strongest at birth, easing off
                        // over the ember's life.
                        // The glow target is the ring's live color nudged by
                        // this ember's own per-channel jitter, so sparks at
                        // the same moment land on slightly different shades
                        // (warmer/cooler, brighter/dimmer) instead of one
                        // identical ring tint. The mix strength also varies
                        // per ember so some bleed the ring color more than
                        // others.
                        const emberGlowMix = Math.pow(1 - lifeP, Math.max(0.001, settings.emberGlowFalloff))
                            * settings.emberGlowAmount * seed.glowAmountJitter;
                        const jitterScale = settings.emberGlowJitter;
                        const glowR = THREE.MathUtils.clamp(ringGlowColor.r + seed.glowJitter[0] * jitterScale, 0, 1);
                        const glowG = THREE.MathUtils.clamp(ringGlowColor.g + seed.glowJitter[1] * jitterScale, 0, 1);
                        const glowB = THREE.MathUtils.clamp(ringGlowColor.b + seed.glowJitter[2] * jitterScale, 0, 1);
                        emberColors[i * 3] = THREE.MathUtils.lerp(emberColor[0], glowR, emberGlowMix);
                        emberColors[i * 3 + 1] = THREE.MathUtils.lerp(emberColor[1], glowG, emberGlowMix);
                        emberColors[i * 3 + 2] = THREE.MathUtils.lerp(emberColor[2], glowB, emberGlowMix);
                    }
                    emberColorAttr.needsUpdate = true;
                    emberAlphaAttr.needsUpdate = true;
                    ringEmberMeshRef.current.instanceMatrix.needsUpdate = true;
                }
            }
        }
    });

    // Calculations for geometry and crossing markers
    const targetZ = crossingPlane === 'front' ? FRONT_OF_PLATE_Z : MID_PLATE_Z;

    const szTopM = ((pitchData?.strike_zone_top) || 3.5) * 0.3048;
    const szBottomM = ((pitchData?.strike_zone_bottom) || 1.5) * 0.3048;
    const szWidthM = 0.4318; 
    const szHalfW = szWidthM / 2;
    const szHeight = szTopM - szBottomM;
    const thirdW = szWidthM / 3;
    const thirdH = szHeight / 3;

    // The 8 strike-zone line midpoints (in the zone group's local x–y plane,
    // which shares world x–y since the group is only translated in z). Used
    // each frame to apply a fire-colored radial glow that fades with each
    // line's distance from the crossing spot, so the zone heats brightest
    // near the impact point and cools outward. [0] is just a placeholder for
    // the 1-based outer/inner indexing below.
    const zoneLineMidpoints = useMemo(() => {
        const innerVX = [-szHalfW + thirdW, szHalfW - thirdW];
        const innerHY = [szBottomM + thirdH, szBottomM + 2 * thirdH];
        // Indexed to match zoneLineRefs: 0=bottom border, 1=top border,
        // 2=left border, 3=right border, 4–5=inner verticals, 6–7=inner
        // horizontals. Midpoints use the line's static center coordinate and
        // 0 for its sweeping axis where applicable.
        return [
            [0, szBottomM], [0, szTopM], [-szHalfW, (szBottomM + szTopM) / 2], [szHalfW, (szBottomM + szTopM) / 2],
            [innerVX[0], (szBottomM + szTopM) / 2], [innerVX[1], (szBottomM + szTopM) / 2],
            [0, innerHY[0]], [0, innerHY[1]],
        ];
    }, [szHalfW, szBottomM, szTopM, thirdW, thirdH]);

    // Statcast crossing marker: use targetZ for consistency across all three dots
    const hasMidCrossing = pitchData?.statcast_px_mid != null && pitchData?.statcast_pz_mid != null;
    const hasStatcastCrossing = hasMidCrossing || (pitchData?.statcast_px != null && pitchData?.statcast_pz != null);
    const statcastPx = crossingPlane === 'front' ? pitchData?.statcast_px : (pitchData?.statcast_px_mid ?? pitchData?.statcast_px);
    const statcastPz = crossingPlane === 'front' ? pitchData?.statcast_pz : (pitchData?.statcast_pz_mid ?? pitchData?.statcast_pz);
    const statcastCrossingM = (hasStatcastCrossing && statcastPx != null && statcastPz != null)
        ? [statcastPx * 0.3048, statcastPz * 0.3048, targetZ]
        : null;

    // Hawk-Eye (Statcast) measured crossing, projected onto the front of the
    // strike zone. The hollow ring marks this reference spot when the physics
    // pitch arrives at the plate.
    const hawkeyeCrossingM = useMemo(() => {
        const px = pitchData?.statcast_px;
        const pz = pitchData?.statcast_pz;
        if (px == null || pz == null) return null;
        return [px * 0.3048, pz * 0.3048, FRONT_OF_PLATE_Z];
    }, [pitchData]);

    // Comparison overlay: the speed + pitch-type label under this pitch's ring
    // (e.g. "98 · SI"), drawn plain white broadcast-style. Computed only for
    // overlays so normal playback keeps the strike zone clean.
    const pitchTypeLabel = overlay
        ? (() => {
            const type = pitchData?.pitch_type || pitchData?.pitch_type_description || null;
            if (!type) return null;
            const speed = pitchData?.speed_mph;
            if (speed != null) return `${Math.round(speed)} · ${type}`;
            return type;
        })()
        : null;

    // Physics simulation crossing marker — evaluated at targetZ to match the selected plane
    let simCrossingM = null;
    for (let i = 0; i < linePoints.length - 1; i++) {
        const p1 = linePoints[i];
        const p2 = linePoints[i+1];
        if (p1.z <= targetZ && p2.z > targetZ) {
            const t = (targetZ - p1.z) / (p2.z - p1.z);
            const crossX = p1.x + t * (p2.x - p1.x);
            const crossY = p1.y + t * (p2.y - p1.y);
            simCrossingM = [crossX, crossY, targetZ];
            break;
        }
    }
    if (!simCrossingM && linePoints.length > 0) {
        const lastP = linePoints[linePoints.length - 1];
        simCrossingM = [lastP.x, lastP.y, targetZ];
    }

    // Ghost (default env) crossing marker — evaluated at targetZ to match the selected plane
    let ghostCrossingM = null;
    for (let i = 0; i < ghostLinePoints.length - 1; i++) {
        const p1 = ghostLinePoints[i];
        const p2 = ghostLinePoints[i + 1];
        if (p1.z <= targetZ && p2.z > targetZ) {
            const tg = (targetZ - p1.z) / (p2.z - p1.z);
            ghostCrossingM = [p1.x + tg * (p2.x - p1.x), p1.y + tg * (p2.y - p1.y), targetZ];
            break;
        }
    }
    if (!ghostCrossingM && ghostLinePoints.length > 0) {
        const lp = ghostLinePoints[ghostLinePoints.length - 1];
        ghostCrossingM = [lp.x, lp.y, targetZ];
    }

    // Notify parent about crossing positions (Hook always executes at top level)
    React.useEffect(() => {
        if (onCrossings) {
            onCrossings({
                red:    simCrossingM    ? { x: simCrossingM[0],    z: simCrossingM[1]    } : null,
                purple: ghostCrossingM  ? { x: ghostCrossingM[0],  z: ghostCrossingM[1]  } : null,
                blue:   statcastCrossingM ? { x: statcastCrossingM[0], z: statcastCrossingM[1] } : null,
            });
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [simCrossingM?.[0], simCrossingM?.[1], ghostCrossingM?.[0], ghostCrossingM?.[1], statcastCrossingM?.[0], statcastCrossingM?.[1]]);

    if (!pitchData || linePoints.length === 0) return null;

    return (
        <group>
            {/* Particle trail of the pitch path (ported from solomon-gumball's
                PitchArc, made denser and thicker): a persistent translucent
                white trace underneath, and a speed-graded tail that runs
                white→yellow→red along the flight (white far behind the ball,
                red-hot at the ball; slow pitches skew white/yellow, fast ones
                yellow/red). All layers are revealed progressively as the ball
                flies to the plate, stay visible through the batted-ball flight,
                and clear when the play replays. Pixelated billow particles are
                kicked up behind the ball, colored yellow→red by pitch speed,
                plus a fine golden spark layer on 100+ mph pitches. */}
            {particlePoints.length > 0 && (
                <>
                    <instancedMesh
                        ref={whiteTraceMeshRef}
                        args={[whiteTraceGeometry, whiteTraceMaterial, TRAIL_MAX_PARTICLES]}
                        renderOrder={1}
                        frustumCulled={false}
                    />
                    {showColoredTail && (
                        <instancedMesh
                            ref={trailMeshRef}
                            args={[trailGeometry, trailMaterial, TRAIL_MAX_PARTICLES]}
                            renderOrder={2}
                            frustumCulled={false}
                        />
                    )}
                    {/* Billow particles are skipped for tunneling overlays so
                        the overlaid trajectories read clearly, and can be
                        disabled entirely from the playback panel. */}
                    {!overlay && showBillows && (
                        <>
                            <instancedMesh
                                ref={billowMeshRef}
                                args={[billowGeometry, billowMaterial, BILLOW_MAX_COUNT]}
                                renderOrder={3}
                                frustumCulled={false}
                            />
                            <instancedMesh
                                ref={whiteBillowMeshRef}
                                args={[whiteBillowGeometry, whiteBillowMaterial, BILLOW_WHITE_MAX_CAPACITY]}
                                renderOrder={4}
                                frustumCulled={false}
                            />
                            <instancedMesh
                                ref={goldSparkMeshRef}
                                args={[goldSparkGeometry, goldSparkMaterial, GOLD_SPARK_MAX_COUNT]}
                                renderOrder={5}
                                frustumCulled={false}
                            />
                        </>
                    )}
                </>
            )}

            {/* Ghost Trajectory: default (neutral) environment in purple */}
            {ghostLinePoints.length > 0 && (
                <Line
                    points={ghostLinePoints}
                    color="#cc44ff"
                    lineWidth={2}
                    transparent={true}
                    opacity={0.55}
                    dashed={true}
                    dashSize={0.35}
                    gapSize={0.15}
                />
            )}
            
            {/* The baseball moving along the trajectory, spinning on the
                Statcast spin axis (see spinAxis). Suspense keeps the first
                load from blocking the rest of the scene. */}
            <React.Suspense fallback={null}>
                <Baseball ref={ballRef} opacity={overlay ? pitchTuning.overlayBallOpacity : undefined} />
            </React.Suspense>
            {/* Ring of fire for 100+ mph: a thick bright orange core ring and
                a wider soft glow halo wrapped around the ball as it nears the
                zone. Both sit in a plain group — the frame loop positions it
                at the ball and snaps its quaternion to the camera's, so the
                ring plane always faces the camera directly (no Billboard
                nesting needed). */}
            {!overlay && showBillows && (pitchData?.speed_mph ?? 90) >= pitchTuning.goldRingThresholdMph && (
                <group ref={burnRingGroupRef} position={[0, 0, 0]}>
                    <mesh
                        ref={burnRingRef}
                        geometry={burnRingGeometry}
                        material={burnRingMaterial}
                        renderOrder={2}
                        visible={false}
                    />
                    <mesh
                        ref={burnRingGlowRef}
                        geometry={burnRingGlowGeometry}
                        material={burnRingGlowMaterial}
                        renderOrder={2}
                        visible={false}
                    />
                    {/* Heat shimmer: faint procedural ripple disc riding the
                        group so it inherits the ball position + camera-facing
                        rotation. */}
                    <mesh
                        ref={burnShimmerRef}
                        geometry={burnShimmerGeometry}
                        material={burnShimmerMaterial}
                        renderOrder={3}
                        visible={false}
                    />
                </group>
            )}
            {/* Fiery ribbon trail behind the burning ball: additive round
                glints written per-frame from the trajectory just behind the
                ball (see useFrame), sharing the burn ring's gating. */}
            {!overlay && showBillows && (pitchData?.speed_mph ?? 90) >= pitchTuning.goldRingThresholdMph && (
                <instancedMesh
                    ref={burnTrailMeshRef}
                    args={[burnTrailGeometry, burnTrailMaterial, BURN_TRAIL_MAX_COUNT]}
                    renderOrder={2}
                    frustumCulled={false}
                />
            )}
            {/* Sparkler sparks shed radially off the burn ring (see useFrame),
                sharing the burn ring's gating. */}
            {!overlay && showBillows && (pitchData?.speed_mph ?? 90) >= pitchTuning.goldRingThresholdMph && (
                <instancedMesh
                    ref={burnSparkMeshRef}
                    args={[burnSparkGeometry, burnSparkMaterial, BURN_SPARK_MAX_COUNT]}
                    renderOrder={2}
                    frustumCulled={false}
                />
            )}
            
            {/* 9-Quadrant Strike Zone */}
            <group position={[0, 0, FRONT_OF_PLATE_Z]}>
                {/* Outer Border */}
                <Line ref={(el) => { zoneLineRefs.current[0] = el; }} points={[[-szHalfW, szBottomM, 0], [szHalfW, szBottomM, 0]]} color="white" lineWidth={2} />
                <Line ref={(el) => { zoneLineRefs.current[1] = el; }} points={[[-szHalfW, szTopM, 0], [szHalfW, szTopM, 0]]} color="white" lineWidth={2} />
                <Line ref={(el) => { zoneLineRefs.current[2] = el; }} points={[[-szHalfW, szBottomM, 0], [-szHalfW, szTopM, 0]]} color="white" lineWidth={2} />
                <Line ref={(el) => { zoneLineRefs.current[3] = el; }} points={[[szHalfW, szBottomM, 0], [szHalfW, szTopM, 0]]} color="white" lineWidth={2} />
                
                {/* Inner Vertical Lines */}
                <Line ref={(el) => { zoneLineRefs.current[4] = el; }} points={[[-szHalfW + thirdW, szBottomM, 0], [-szHalfW + thirdW, szTopM, 0]]} color="white" lineWidth={1} />
                <Line ref={(el) => { zoneLineRefs.current[5] = el; }} points={[[szHalfW - thirdW, szBottomM, 0], [szHalfW - thirdW, szTopM, 0]]} color="white" lineWidth={1} />
                
                {/* Inner Horizontal Lines */}
                <Line ref={(el) => { zoneLineRefs.current[6] = el; }} points={[[-szHalfW, szBottomM + thirdH, 0], [szHalfW, szBottomM + thirdH, 0]]} color="white" lineWidth={1} />
                <Line ref={(el) => { zoneLineRefs.current[7] = el; }} points={[[-szHalfW, szBottomM + 2 * thirdH, 0], [szHalfW, szBottomM + 2 * thirdH, 0]]} color="white" lineWidth={1} />
            </group>

            {/* Hawk-Eye Crossing (flat reference ring): appears only once the
                physics-simulated pitch has arrived at the front of the plate,
                at the Statcast-measured position on the strike zone. It eases
                in with an impact pulse at the moment it is batted, then fades
                gradually down to the white trace's settled opacity before
                easing out when the play replays (the cycle wraps). Opacity and
                scale are driven per-frame by the ring animation in useFrame. */}
            {hawkeyeCrossingM && (
                <group
                    ref={ringGroupRef}
                    position={[hawkeyeCrossingM[0], hawkeyeCrossingM[1], FRONT_OF_PLATE_Z]}
                >
                    <mesh
                        ref={ringMeshRef}
                        geometry={ringGeometry}
                        material={ringMaterial}
                        renderOrder={6}
                        visible={false}
                    />
                </group>
            )}
            {hawkeyeCrossingM && !overlay && showBillows && (pitchData?.speed_mph ?? 90) >= pitchTuning.goldRingThresholdMph && (() => {
                // The lingering beams and smoke are shared by both impact modes;
                // only the immediate radial beam burst is exclusive to beams.
                // The Billows toggle controls this shared particle layer in
                // both modes.
                const spikePos = [hawkeyeCrossingM[0], hawkeyeCrossingM[1], FRONT_OF_PLATE_Z];
                return (
                    <>
                        {impactEffect === 'beams' && (
                            <instancedMesh
                                ref={ringSpikeMeshRef}
                                args={[ringSpikeGeometry100, ringSpikeMaterial100, RING_SPIKE_MAX_COUNT]}
                                position={spikePos}
                                // Draw above the impact flames (2), lingering
                                // beams (8), and embers (9) so the radial beam
                                // burst always stays crisp on top of the fire.
                                renderOrder={10}
                                frustumCulled={false}
                            />
                        )}
                        <instancedMesh
                            ref={ringLingerMeshRef}
                            args={[ringLingerGeometry, ringLingerMaterial, RING_LINGER_MAX_COUNT]}
                            position={spikePos}
                            renderOrder={8}
                            frustumCulled={false}
                        />
                        <instancedMesh
                            ref={smokeMeshRef}
                            args={[smokeGeometry, smokeMaterial, SMOKE_MAX_COUNT]}
                            position={spikePos}
                            renderOrder={6}
                            frustumCulled={false}
                        />
                        <instancedMesh
                            ref={ringEmberMeshRef}
                            args={[ringEmberGeometry, ringEmberMaterial, RING_EMBER_MAX_COUNT]}
                            position={spikePos}
                            renderOrder={9}
                            frustumCulled={false}
                        />
                    </>
                );
            })()}
            {/* Impact fire burst: fire lances radially out of the ring on
                impact (see useFrame), gated to 100+ mph non-overlay playback. */}
            {hawkeyeCrossingM && !overlay && showBillows && (pitchData?.speed_mph ?? 90) >= pitchTuning.goldRingThresholdMph && (
                <instancedMesh
                    ref={impactFireMeshRef}
                    args={[impactFireGeometry, impactFireMaterial, IMPACT_FIRE_TOTAL]}
                    renderOrder={2}
                    frustumCulled={false}
                />
            )}
            {/* Cheap shockwave approximation: an expanding ripple ring mesh
                rendered on the 100+ mph impact in both impact modes, replacing
                the removed full-screen air-distortion pass (visible = false
                until the animation activates it). */}
            {hawkeyeCrossingM && !overlay && (pitchData?.speed_mph ?? 90) >= pitchTuning.goldRingThresholdMph && (
                <mesh
                    ref={rippleMeshRef}
                    geometry={rippleGeometry}
                    material={rippleMaterial}
                    position={[hawkeyeCrossingM[0], hawkeyeCrossingM[1], FRONT_OF_PLATE_Z]}
                    renderOrder={7}
                    visible={false}
                />
            )}

            {/* Comparison overlay: pitch-type label under the hawk-eye ring,
                so each overlaid pitch's ring is identified at a glance. It
                billboards to face the camera, is plain solid white with no
                border (broadcast velocity-label look), sits snugly under each
                ring, and its visibility tracks the ring (hidden until the
                pitch reaches the strike zone, cleared when the windup starts). */}
            <group ref={ringLabelGroupRef} visible={false}>
                {overlay && showRingLabel && hawkeyeCrossingM && pitchTypeLabel && (
                    <Billboard
                        position={[
                            hawkeyeCrossingM[0],
                            hawkeyeCrossingM[1] - (RING_OUTER_RADIUS + RING_LABEL_GAP),
                            FRONT_OF_PLATE_Z + RING_LABEL_OFFSET_Z,
                        ]}
                    >
                        <Text
                            fontSize={RING_OUTER_RADIUS * RING_LABEL_FONT_SCALE}
                            color="#ffffff"
                            fontWeight="bold"
                            outlineWidth={RING_LABEL_OUTLINE}
                            outlineColor={RING_LABEL_OUTLINE_COLOR}
                            anchorX="center"
                            anchorY="top"
                        >
                            {pitchTypeLabel}
                        </Text>
                    </Billboard>
                )}
            </group>
        </group>
    );
};
