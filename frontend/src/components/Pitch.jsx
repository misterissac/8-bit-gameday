import React, { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { Billboard, Line, Text, useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { getCycleDuration, getTimeScale } from '../constants/playback';
import { BALL_RELEASE_TIME } from './Pitcher';

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
const TRAIL_SAMPLE_STEP = 0.00035; // s between successive trail particles at full density
const TRAIL_MAX_PARTICLES = 2048; // fixed instanced capacity (~1s of flight)
// The number of wake particles scales with pitch speed: a 70 mph pitch
// emits 30% of the full count and the density ramps linearly up to 100% at
// 90 mph — so fast pitches leave the densest wake while slow ones leave a
// lighter one. The trail implements this by widening its sample step
// (TRAIL_SAMPLE_STEP / densityFrac) and the yellow→red billow layer by
// emitting fewer particles.
const DENSITY_MIN_MPH = 70; // 30% density at/under this speed
const DENSITY_MAX_MPH = 90; // 100% density at/above this speed
const DENSITY_MIN_FRAC = 0.3; // fraction of the full particle count at DENSITY_MIN_MPH
const DENSITY_MAX_FRAC = 1; // fraction at DENSITY_MAX_MPH and beyond

// Shared speed → density ramp for the wake layers (clamps to 30% below
// 70 mph and 100% above 90 mph).
function getSpeedDensityFrac(speed) {
    return THREE.MathUtils.clamp(
        (speed - DENSITY_MIN_MPH) / (DENSITY_MAX_MPH - DENSITY_MIN_MPH),
        DENSITY_MIN_FRAC,
        DENSITY_MAX_FRAC,
    );
}

const TRAIL_LEAD_SCALE = 0.08;
const TRAIL_PARTICLE_SCALE = 0.04; // thinner, finer tail than the old 0.06
// A particle's alpha ramps from TRAIL_MAX_OPACITY down to 0 over
// TRAIL_FADE_TIME seconds as it ages behind the ball, so the tail fades out
// like solomon-gumball's trailing ribbon instead of ending in a hard edge.
// Shorter fade time = the tail fades away faster behind the ball.
const TRAIL_FADE_TIME = 0.18; // s
const TRAIL_MAX_OPACITY = 0.5; // overall translucency
// Tunneling comparison overlay: the ball, tail, and trace all dim so several
// overlaid pitches and their trajectories stay readable at once.
const OVERLAY_BALL_OPACITY = 0.5;
const OVERLAY_TRAIL_FACTOR = 0.55;
const OVERLAY_TRACE_FACTOR = 0.55;
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
const WHITE_TRACE_SCALE = 0.018;
const WHITE_TRACE_OPACITY = 0.16;
const WHITE_TRACE_MIN_OPACITY = 0.05;
const WHITE_TRACE_FADE_TIME = 0.5; // s to ease down after the pitch arrives
const WHITE_TRACE_COLOR = [1, 1, 1];

// Pixelated billow particles kicked up behind the ball as it flies: small
// axis-aligned boxes (a retro "pixel" look) that spawn along the trajectory,
// then billow outward/upward, recede slightly, grow, and fade as they age.
const BILLOW_COUNT = 12; // yellow→red particles (kept low — the trail carries the visual weight)
const BILLOW_SPAWN_SPAN = 0.5; // s — emit across the whole flight (pitches take ~0.4s)
// Spawn each billow particle slightly BEFORE its activation time along the
// trajectory, so it first pops in behind the ball (further back on its path)
// instead of right at the ball's position.
const BILLOW_SPAWN_BEHIND = 0.025; // s — ~1 m behind at typical pitch speeds
const BILLOW_LIFE = 0.45; // s — per-particle lifetime (shorter = faster decay)
const BILLOW_FADE_IN = 0.05; // s — quick pop-in as each particle spawns
const BILLOW_SPREAD = 1.1; // m/s — outward billow rate (violent burst)
const BILLOW_BACK_DRIFT = 0.6; // m/s — recede behind the ball
const BILLOW_BASE_SCALE = 0.06; // m — starting particle size (slightly smaller)
const BILLOW_SCALE_GROWTH = 3.5; // per-second size growth while billowing
const BILLOW_OPACITY = 0.85;

// All pitches emit a layer of white billow particles; the amount scales with
// pitch speed (nearly nothing at slow speeds ramping up to the full layer on
// fast pitches), so velocity reads as a hotter, brighter wake.
const BILLOW_WHITE_COUNT = 4; // white particles at/under the threshold
const BILLOW_WHITE_COUNT_MAX = 16; // layer capacity; count ramps up above 85 mph
// The white wake is its own layer: fine, additive-blended spark particles
// that glow as they billow. It stays nearly absent below 85 mph
// (BILLOW_WHITE_MIN_MULT) and once the pitch exceeds
// BILLOW_WHITE_THRESHOLD_MPH (85 mph) both the particle count and the alpha
// ramp up to full by 105 mph — so only genuinely fast pitches leave a heavy
// white wake.
const BILLOW_WHITE_BASE_SCALE = 0.02; // finer than the yellow/red billows
const BILLOW_WHITE_OPACITY = 1.0;     // full-strength (additive = glows)
const BILLOW_WHITE_THRESHOLD_MPH = 85; // count/alpha ramp begins here
const BILLOW_WHITE_MIN_MULT = 0.1;     // white-layer alpha below 85 mph
const BILLOW_WHITE_MAX_MULT = 1;       // white-layer alpha at 105 mph
const BILLOW_WHITE_JITTER_MIN = 0.95;  // white particles render near full alpha (vs 0.7 base)

// Golden spark layer: emitted only by the fastest pitches (at/over
// GOLD_SPARK_THRESHOLD_MPH, i.e. >= 99 mph), layered on top of the usual
// white/yellow-red billows, so a 99+ mph pitch reads as a distinct golden
// wake. Below the threshold the layer is written with alpha 0, so no stale
// sparks linger.
const GOLD_SPARK_THRESHOLD_MPH = 99; // golden sparks start appearing at/above this release speed
const GOLD_SPARK_COUNT = 16; // takes over the white wake at/above 99 mph (golden:white ratio up)
// The hawk-eye ring at the strike zone and its sparkle halo are golden only
// for pitches strictly above this speed (100+ mph club). Below it the ring
// shares the trail's yellow→red color, so only the billows read golden at
// 99–100 mph.
const GOLD_RING_THRESHOLD_MPH = 100; // golden ring/sparkles only for pitches > 100 mph
const GOLD_SPARK_COLOR = [1, 0.8, 0.18]; // bright warm gold
const GOLD_SPARK_BASE_SCALE = 0.034; // slightly larger so the glow reads
const GOLD_SPARK_SCALE_GROWTH = 3.0; // stays small as it ages
const GOLD_SPARK_OPACITY = 1.15; // boosted past full-strength (additive = shine)
const GOLD_SPARK_JITTER_MIN = 1; // lift the dimmest sparks to full alpha
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

// Billow particles only start appearing once the ball is most of the way to
// home plate (the last third of the flight), so the look out of the hand
// stays clean and unobscured.
const BILLOW_START_FRACTION = 2 / 3; // fraction of the flight elapsed before emission starts

// Shared builders for the billow particle layers: per-pitch random seeds
// (delay spread across the last third of the flight, random billow
// direction, size/alpha jitter) plus their spawn points sampled along the
// trajectory.
function makeBillowSeeds(count, flightDuration) {
    const seeds = [];
    const span = Math.min(BILLOW_SPAWN_SPAN, Math.max(flightDuration, 0.01));
    for (let i = 0; i < count; i++) {
        const frac = count > 1 ? i / (count - 1) : 0;
        // Map the 0..1 spread onto the last third of the flight so nothing
        // emits until the ball is 2/3 of the way to home plate.
        const delayFrac = BILLOW_START_FRACTION + (1 - BILLOW_START_FRACTION) * frac;
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

function makeBillowSpawns(trajectoryData, seeds) {
    if (!trajectoryData || trajectoryData.length === 0) return [];
    // Sample slightly before each seed's activation time so the particle first
    // appears behind the ball rather than right at its current position.
    return seeds.map((seed) => sampleTrajectoryAtTime(trajectoryData, seed.delay - BILLOW_SPAWN_BEHIND));
}

// Write one billow layer's per-instance transforms, alphas, and colors for the
// current sim time. `alphaMultiplier` hides the layer (0) without leaving
// stale particles on screen (used for the white layer on slow pitches). `opts`
// overrides the shared billow look (size/growth/opacity/spread) for layers
// like the golden 100+ mph sparks that want a finer, quicker sparkle.
function writeBillowLayer(mesh, geometry, seeds, spawns, simTime, color, dummy, alphaMultiplier = 1, opts = {}) {
    const {
        baseScale = BILLOW_BASE_SCALE,
        scaleGrowth = BILLOW_SCALE_GROWTH,
        opacity = BILLOW_OPACITY,
        spread = BILLOW_SPREAD,
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
        const ageP = age / BILLOW_LIFE;
        if (ageP >= 1) continue;

        const fadeIn = Math.min(age / BILLOW_FADE_IN, 1);
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
            spawn.z - BILLOW_BACK_DRIFT * age,
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
export const SPIN_SPEED_SCALE = 0.1;
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
        model.traverse((obj) => {
            if (!obj.isMesh) return;
            const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
            const dimmed = materials.map((mat) => {
                const copy = mat.clone();
                copy.transparent = opacity != null && opacity < 1;
                copy.opacity = opacity ?? 1;
                copy.needsUpdate = true;
                return copy;
            });
            obj.material = Array.isArray(obj.material) ? dimmed : dimmed[0];
        });
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
const RING_PULSE_TIME = 0.35; // s — fade in + overshoot settle
const RING_SETTLE_TIME = 0.8; // s — ease from impact flash down to the settled opacity
const RING_FADE_TIME = 0.3; // s — fade out on replay reset
const RING_PULSE_OVERSHOOT = 0.8; // scale overshoot: 1.8x -> 1x
const RING_MAX_OPACITY = 0.95; // impact flash peak
const RING_SETTLED_OPACITY = 0.3; // held after the fade-down (clearly above the white trace's 0.05)
// Subtle sparkle halo the golden 100 mph ring gives off at the strike zone.
// Styled deliberately differently from the trail's golden sparks — soft round
// glints (low-poly spheres, not octahedra) in a warm white-gold, with a slow
// gentle twinkle — so the ring's glow reads as its own effect. Gated by the
// same particles toggle (showBillows) as the trail billows.
const RING_SPARKLE_COUNT = 12;
// The ring band width — sparkles can veer ~1 band width inward and outward
// from the base radius so their formation reads as organic, not a perfect
// ring.
const RING_BAND_WIDTH = RING_OUTER_RADIUS - RING_INNER_RADIUS;
const RING_SPARKLE_RADIUS = (RING_INNER_RADIUS + RING_OUTER_RADIUS) * 0.5; // ring center
const RING_SPARKLE_BURST_DISTANCE = RING_OUTER_RADIUS * 0.9; // m — bigger one-shot outward burst on impact
const RING_SPARKLE_COLOR = [1, 0.95, 0.7]; // warm white-gold glint
const RING_SPARKLE_BASE_SCALE = 0.018; // small round glints
const RING_SPARKLE_OPACITY = 0.5; // subtle
const RING_SPARKLE_TWINKLE_SPEED = 6; // rad/s — slow, gentle twinkle
const RING_SPARKLE_RADIAL_JITTER = RING_BAND_WIDTH; // m — veer ~1 band width inward/outward
const RING_SPARKLE_Z_JITTER = 0.02; // m — slight depth scatter
// After the impact burst, the sparkles drift upward and fade out like
// lingering smoke instead of settling back onto the ring.
const RING_SPARKLE_DRIFT_SPEED = 0.06; // m/s — upward drift velocity
const RING_SPARKLE_DRIFT_START = 0.08; // s — delay after pulse before drift begins
const RING_SPARKLE_DRIFT_FADE = 1.4; // s — time over which a drifting sparkle fades to zero

export const Pitch = ({ pitchData, defaultPitchData, crossingPlane = 'mid', onCrossings, onArrival, overlay = false, showRingLabel = true, showColoredTail = true, showBillows = true }) => {
    const ballRef = useRef();
    const simClock = useRef(0);
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
    const ringGroupRef = useRef();
    const ringMeshRef = useRef();
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
    const ringSparkleMeshRef = useRef();

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
    // Ring sparkles are low-poly spheres (round glints) rather than the golden
    // trail's octahedral shards, and additive so overlapping glints bloom.
    const ringSparkleGeometry = useMemo(() => createTrailGeometry(() => new THREE.SphereGeometry(0.5, 5, 5)), []);
    const ringSparkleMaterial = useMemo(() => {
        const material = createTrailMaterial();
        material.blending = THREE.AdditiveBlending;
        return material;
    }, []);
    const ringSparkleDummy = useMemo(() => new THREE.Object3D(), []);
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
    const ringMaterial = useMemo(() => new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
        opacity: 0,
    }), []);

    // Per-pitch random billow seeds (stable per pitch): each particle emits at
    // its own delay spread across the whole flight, so the cloud trails the
    // entire pitch path instead of bunching at the release point.
    const flightDuration = useMemo(() => {
        const trajectoryData = pitchData?.trajectory;
        if (!trajectoryData || trajectoryData.length === 0) return 0.4;
        return trajectoryData[trajectoryData.length - 1]?.t || 0.4;
    }, [pitchData]);

    const billowSeeds = useMemo(() => makeBillowSeeds(BILLOW_COUNT, flightDuration), [pitchData, flightDuration]);
    const billowSpawns = useMemo(() => makeBillowSpawns(pitchData?.trajectory, billowSeeds), [pitchData, billowSeeds]);

    // White billow layer, emitted by every pitch (amount scales with speed).
    // Seeds are generated for the full capacity; the emitted count is gated by
    // `limit` in the frame loop (fewer particles under 90 mph).
    const whiteBillowSeeds = useMemo(() => makeBillowSeeds(BILLOW_WHITE_COUNT_MAX, flightDuration), [pitchData, flightDuration]);
    const whiteBillowSpawns = useMemo(() => makeBillowSpawns(pitchData?.trajectory, whiteBillowSeeds), [pitchData, whiteBillowSeeds]);

    // Golden spark layer, emitted only by 99+ mph pitches (see
    // GOLD_SPARK_THRESHOLD_MPH). Same billow mechanics, finer look.
    const goldSparkSeeds = useMemo(() => makeBillowSeeds(GOLD_SPARK_COUNT, flightDuration), [pitchData, flightDuration]);
    const goldSparkSpawns = useMemo(() => makeBillowSpawns(pitchData?.trajectory, goldSparkSeeds), [pitchData, goldSparkSeeds]);

    // Per-pitch ring-sparkle seeds: evenly spaced around the ring with a little
    // radius/depth/phase jitter so the halo shimmers organically. The angle is
    // rotated by a per-pitch offset (from the release speed) so each pitch gets
    // its own deterministic pattern.
    const ringSparkleSeeds = useMemo(() => {
        const speedOffset = ((pitchData?.speed_mph ?? 90) % 360) * (Math.PI / 180);
        return Array.from({ length: RING_SPARKLE_COUNT }, (_, i) => ({
            angle: speedOffset + (i / RING_SPARKLE_COUNT) * Math.PI * 2,
            // Each sparkle gets its own per-pitch random offset within ±1 band
            // width so the formation looks scattered, not a perfect ring.
            radiusOffset: (Math.random() - 0.5) * 2 * RING_BAND_WIDTH,
            z: (Math.random() - 0.5) * RING_SPARKLE_Z_JITTER,
            phase: Math.random() * Math.PI * 2,
            speed: RING_SPARKLE_TWINKLE_SPEED * (0.7 + Math.random() * 0.6),
            scale: RING_SPARKLE_BASE_SCALE * (0.7 + Math.random() * 0.6),
        }));
    }, [pitchData]);

    // Start each new pitch back at the release point, with both trail layers
    // cleared so they can grow behind the ball as it flies.
    React.useLayoutEffect(() => {
        simClock.current = 0;
        arrivedRef.current = false;
        arrivedAtRef.current = -1;
        whiteTraceClearedRef.current = false;
        ringClearedRef.current = false;
        ringAnim.current.phase = 'idle';
        ringAnim.current.t = 0;
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
        if (ringSparkleMeshRef.current) {
            const alphaAttr = ringSparkleGeometry.getAttribute('aAlpha');
            alphaAttr.array.fill(0);
            alphaAttr.needsUpdate = true;
        }
        // Hide the hawk-eye ring until the arrival pulse eases it in, and the
        // comparison label with it.
        ringMaterial.opacity = 0;
        if (ringMeshRef.current) ringMeshRef.current.visible = false;
        if (ringLabelGroupRef.current) ringLabelGroupRef.current.visible = false;
    }, [pitchData, trailGeometry, whiteTraceGeometry, billowGeometry, whiteBillowGeometry, goldSparkGeometry, ringSparkleGeometry, ringMaterial]);
    
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
        const densityFrac = getSpeedDensityFrac(speed);
        const sampleStep = TRAIL_SAMPLE_STEP / densityFrac;
        const pts = [];
        for (let i = 0; i < TRAIL_MAX_PARTICLES; i++) {
            const t = i * sampleStep;
            const pos = sampleTrajectoryAtTime(trajectoryData, t);
            if (!pos) break;
            if (pos.z >= FRONT_OF_PLATE_Z) break;
            pts.push({ pos, t });
        }
        return pts;
    }, [pitchData]);

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
        const ringColor = speed > GOLD_RING_THRESHOLD_MPH ? GOLD_SPARK_COLOR : trailColor;
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
                        isWhite ? WHITE_TRACE_SCALE : (isLead ? TRAIL_LEAD_SCALE : TRAIL_PARTICLE_SCALE),
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
    }, [particlePoints, pitchData, trailGeometry, whiteTraceGeometry, ringMaterial]);

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
    
    useFrame((_, delta) => {
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
        const nextClock = simClock.current + delta * getTimeScale();
        const wrapped = nextClock >= loopDuration;
        simClock.current = nextClock % loopDuration;

        // The clock is already in the trajectory's real-time domain, so sample
        // the bracketing data points by their timestamps directly.
        const currentSimTime = simClock.current;
        // The pitcher restarts his windup just before the cycle wraps (the
        // release lands exactly on the wrap). Clear the persistent white trace
        // there so it's gone while he winds up instead of lingering until the
        // ball leaves his hand again at the wrap.
        const windupStart = Math.max(simDuration, loopDuration - BALL_RELEASE_TIME);
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
                const angle = rpm * ((2 * Math.PI) / 60) * SPIN_SPEED_SCALE * delta * getTimeScale();
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
                const fadeRate = 1 / TRAIL_FADE_TIME;

                let whiteFade = 1;
                if (arrivedAtRef.current >= 0) {
                    const sinceArrival = currentSimTime - arrivedAtRef.current;
                    whiteFade = 1 - Math.min(sinceArrival / WHITE_TRACE_FADE_TIME, 1);
                }
                const trailFactor = overlay ? OVERLAY_TRAIL_FACTOR : 1;
                const traceFactor = overlay ? OVERLAY_TRACE_FACTOR : 1;
                const whiteAlphaNow = (WHITE_TRACE_MIN_OPACITY
                    + (WHITE_TRACE_OPACITY - WHITE_TRACE_MIN_OPACITY) * whiteFade) * traceFactor;

                for (let i = 0; i < particlePoints.length; i++) {
                    const age = currentSimTime - particlePoints[i].t;
                    let tailAlpha = 0;
                    if (age >= 0) {
                        tailAlpha = TRAIL_MAX_OPACITY * trailFactor * (1 - age * fadeRate);
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
                const billowDensityFrac = getSpeedDensityFrac(speed);
                const billowLimit = Math.round(BILLOW_COUNT * billowDensityFrac);
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
                        (speed - BILLOW_WHITE_THRESHOLD_MPH) / (SPEED_MAX_MPH - BILLOW_WHITE_THRESHOLD_MPH), 0, 1,
                    );
                    const whiteMult = THREE.MathUtils.lerp(
                        BILLOW_WHITE_MIN_MULT, BILLOW_WHITE_MAX_MULT, whiteSpeedFrac,
                    );
                    // Above 85 mph the emitted count ramps up too (4 → 16 by
                    // 105 mph), so fast pitches throw more white particles.
                    let whiteLimit = Math.round(THREE.MathUtils.lerp(
                        BILLOW_WHITE_COUNT, BILLOW_WHITE_COUNT_MAX, whiteSpeedFrac,
                    ));
                    // At/above 99 mph the golden spark layer takes over this
                    // many white particles, so a 99+ mph wake reads golden
                    // instead of white while the total particle density stays
                    // the same.
                    if (speed >= GOLD_SPARK_THRESHOLD_MPH) {
                        whiteLimit = Math.max(0, whiteLimit - GOLD_SPARK_COUNT);
                    }
                    writeBillowLayer(
                        whiteBillowMeshRef.current, whiteBillowGeometry, whiteBillowSeeds, whiteBillowSpawns,
                        currentSimTime, [1, 1, 1], whiteBillowDummy,
                        whiteMult,
                        {
                            baseScale: BILLOW_WHITE_BASE_SCALE,
                            opacity: BILLOW_WHITE_OPACITY,
                            limit: whiteLimit,
                            alphaJitterMin: BILLOW_WHITE_JITTER_MIN,
                        },
                    );
                }
                // Golden sparks: only pitches at/over 99 mph emit them; below
                // the threshold the alpha multiplier keeps the layer
                // invisible.
                if (goldSparkMeshRef.current && goldSparkSpawns.length > 0) {
                    const goldMult = speed >= GOLD_SPARK_THRESHOLD_MPH ? 1 : 0;
                    writeBillowLayer(
                        goldSparkMeshRef.current, goldSparkGeometry, goldSparkSeeds, goldSparkSpawns,
                        currentSimTime, GOLD_SPARK_COLOR, goldSparkDummy,
                        goldMult,
                        {
                            baseScale: GOLD_SPARK_BASE_SCALE,
                            scaleGrowth: GOLD_SPARK_SCALE_GROWTH,
                            opacity: GOLD_SPARK_OPACITY,
                            alphaJitterMin: GOLD_SPARK_JITTER_MIN,
                            twinkle: {
                                speed: GOLD_SPARK_TWINKLE_SPEED,
                                depth: GOLD_SPARK_TWINKLE_DEPTH,
                                phase: GOLD_SPARK_TWINKLE_PHASE,
                            },
                        },
                    );
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
                    const p = Math.min(anim.t / RING_PULSE_TIME, 1);
                    const ease = 1 - Math.pow(1 - p, 3); // ease-out cubic
                    finalOpacity = RING_MAX_OPACITY * ease;
                    scale = 1 + RING_PULSE_OVERSHOOT * (1 - ease);
                    if (p >= 1) {
                        anim.phase = 'settle';
                        anim.t = 0;
                    }
                } else if (anim.phase === 'settle') {
                    // Ease gradually from the impact flash down to
                    // RING_SETTLED_OPACITY — a bit more opaque than the white
                    // trace's settled level, so the marker stays legible after
                    // the fade-out of the impact flash.
                    const p = Math.min(anim.t / RING_SETTLE_TIME, 1);
                    const ease = p * p * (3 - 2 * p); // smoothstep out
                    finalOpacity = THREE.MathUtils.lerp(
                        RING_MAX_OPACITY, RING_SETTLED_OPACITY, ease,
                    );
                    scale = 1;
                    if (p >= 1) anim.phase = 'steady';
                } else if (anim.phase === 'steady') {
                    finalOpacity = RING_SETTLED_OPACITY;
                    scale = 1;
                } else if (anim.phase === 'fadeout') {
                    const p = Math.min(anim.t / RING_FADE_TIME, 1);
                    finalOpacity = RING_SETTLED_OPACITY * (1 - p * p * (3 - 2 * p));
                    scale = 1;
                    if (p >= 1) anim.phase = 'idle';
                }
                if (ringMeshRef.current) {
                    ringMeshRef.current.material.opacity = finalOpacity;
                    ringMeshRef.current.visible = finalOpacity > 0.001;
                }
                if (ringGroupRef.current) ringGroupRef.current.scale.setScalar(scale);
            }
            // Golden ring sparkles: subtle glints the >100 mph ring gives off
            // at the strike zone. They burst outward once on the impact pulse,
            // then settle to a gentle twinkle while the ring is on screen.
            if (ringSparkleMeshRef.current) {
                const ringVisible = anim.phase === 'pulse' || anim.phase === 'settle' || anim.phase === 'steady';
                const elite = (pitchData?.speed_mph ?? 90) > GOLD_RING_THRESHOLD_MPH;
                const ringFactor = anim.phase === 'fadeout'
                    ? Math.max(0, 1 - anim.t / RING_FADE_TIME)
                    : 1;
                // One-shot outward burst across the ring's impact pulse: the
                // sparkles pop just outside the ring and fall back onto it.
                const burst = anim.phase === 'pulse'
                    ? Math.sin(Math.min(anim.t / RING_PULSE_TIME, 1) * Math.PI)
                    : 0;
                const sparkleColorAttr = ringSparkleGeometry.getAttribute('aColor');
                const sparkleAlphaAttr = ringSparkleGeometry.getAttribute('aAlpha');
                const sparkleColors = sparkleColorAttr.array;
                const sparkleAlphas = sparkleAlphaAttr.array;
                for (let i = 0; i < RING_SPARKLE_COUNT; i++) {
                    const seed = ringSparkleSeeds[i];
                    const twinkle = 0.5 + 0.5 * Math.sin(currentSimTime * seed.speed + seed.phase);
                    const alpha = elite && ringVisible
                        ? RING_SPARKLE_OPACITY * twinkle * ringFactor
                        : 0;
                    sparkleAlphas[i] = alpha;
                    const radius = RING_SPARKLE_RADIUS
                        + seed.radiusOffset
                        + RING_SPARKLE_BURST_DISTANCE * burst
                        + Math.sin(currentSimTime * seed.speed * 0.5 + seed.phase) * RING_SPARKLE_RADIAL_JITTER;
                    ringSparkleDummy.position.set(
                        Math.cos(seed.angle) * radius,
                        Math.sin(seed.angle) * radius,
                        seed.z,
                    );
                    ringSparkleDummy.scale.setScalar(seed.scale);
                    ringSparkleDummy.rotation.set(0, 0, 0);
                    ringSparkleDummy.updateMatrix();
                    ringSparkleMeshRef.current.setMatrixAt(i, ringSparkleDummy.matrix);
                    sparkleColors[i * 3] = RING_SPARKLE_COLOR[0];
                    sparkleColors[i * 3 + 1] = RING_SPARKLE_COLOR[1];
                    sparkleColors[i * 3 + 2] = RING_SPARKLE_COLOR[2];
                }
                sparkleColorAttr.needsUpdate = true;
                sparkleAlphaAttr.needsUpdate = true;
                ringSparkleMeshRef.current.instanceMatrix.needsUpdate = true;
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

    // Comparison overlay: the pitch-type label under this pitch's ring (e.g.
    // FF / SL / CU), drawn plain white. Computed only for overlays so normal
    // playback keeps the strike zone clean.
    const pitchTypeLabel = overlay
        ? (pitchData?.pitch_type || pitchData?.pitch_type_description || null)
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
                                args={[billowGeometry, billowMaterial, BILLOW_COUNT]}
                                renderOrder={3}
                                frustumCulled={false}
                            />
                            <instancedMesh
                                ref={whiteBillowMeshRef}
                                args={[whiteBillowGeometry, whiteBillowMaterial, BILLOW_WHITE_COUNT_MAX]}
                                renderOrder={4}
                                frustumCulled={false}
                            />
                            <instancedMesh
                                ref={goldSparkMeshRef}
                                args={[goldSparkGeometry, goldSparkMaterial, GOLD_SPARK_COUNT]}
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
                <Baseball ref={ballRef} opacity={overlay ? OVERLAY_BALL_OPACITY : undefined} />
            </React.Suspense>
            
            {/* 9-Quadrant Strike Zone */}
            <group position={[0, 0, FRONT_OF_PLATE_Z]}>
                {/* Outer Border */}
                <Line points={[[-szHalfW, szBottomM, 0], [szHalfW, szBottomM, 0]]} color="white" lineWidth={2} />
                <Line points={[[-szHalfW, szTopM, 0], [szHalfW, szTopM, 0]]} color="white" lineWidth={2} />
                <Line points={[[-szHalfW, szBottomM, 0], [-szHalfW, szTopM, 0]]} color="white" lineWidth={2} />
                <Line points={[[szHalfW, szBottomM, 0], [szHalfW, szTopM, 0]]} color="white" lineWidth={2} />
                
                {/* Inner Vertical Lines */}
                <Line points={[[-szHalfW + thirdW, szBottomM, 0], [-szHalfW + thirdW, szTopM, 0]]} color="white" lineWidth={1} />
                <Line points={[[szHalfW - thirdW, szBottomM, 0], [szHalfW - thirdW, szTopM, 0]]} color="white" lineWidth={1} />
                
                {/* Inner Horizontal Lines */}
                <Line points={[[-szHalfW, szBottomM + thirdH, 0], [szHalfW, szBottomM + thirdH, 0]]} color="white" lineWidth={1} />
                <Line points={[[-szHalfW, szBottomM + 2 * thirdH, 0], [szHalfW, szBottomM + 2 * thirdH, 0]]} color="white" lineWidth={1} />
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
            {hawkeyeCrossingM && !overlay && showBillows && (
                <instancedMesh
                    ref={ringSparkleMeshRef}
                    args={[ringSparkleGeometry, ringSparkleMaterial, RING_SPARKLE_COUNT]}
                    position={[hawkeyeCrossingM[0], hawkeyeCrossingM[1], FRONT_OF_PLATE_Z]}
                    renderOrder={7}
                    frustumCulled={false}
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
