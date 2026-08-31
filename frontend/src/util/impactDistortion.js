// Shared impact-shockwave state for the 100+ mph "supersonic crack" effect.
//
// Pitch publishes the live shock state while its impact ripple is running
// (position of the plate crossing, current shock radius, sim time since
// impact); Scene's ImpactDistortion screen-space pass reads it each frame and
// warps the rendered image around that point. A plain mutable module singleton
// (same convention as playback.js's shared positions): no React, no
// subscription — Pitch writes, Scene reads, both per frame.
import * as THREE from 'three';

// How long the screen-space shock front takes to sweep past the frame,
// expressed as a multiple of the ripple's lifetime (impactDistortion.life).
// The original sweep reached off-screen at 16× the ripple life; dividing by
// 1.3 makes the shockwave travel 30% faster (≈12.31× the life) while the
// ease-out curve and per-radius appearance stay unchanged.
export const SHOCK_SWEEP_FACTOR = 16 / 1.3;

export const impactDistortion = {
    // True while a 100+ mph impact ripple is animating.
    active: false,
    // Seconds since the impact, on the shared simulation clock (respects
    // slow-mo, so the distortion slows down with everything else).
    time: 0,
    // Lifetime of the shock in seconds (the ripple's tuned life). The
    // screen-space pass grows the shock front to off-screen at
    // SHOCK_SWEEP_FACTOR × this rate so the sweep rolls across the frame.
    life: 0.17,
    // World position of the impact (the strike-zone crossing point).
    pos: new THREE.Vector3(),
    // Current shock radius in meters (the expanding ripple ring's radius).
    radius: 0,
};