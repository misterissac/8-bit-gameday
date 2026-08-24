import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, Sky, Environment, Html } from '@react-three/drei';
import { Spherical, Vector3 } from 'three';
import { feetToM } from '../util/MathUtil';
import { getBattedBallPosition, getChaserPosition, getPlayBallPosition, setFielderCamActive } from '../constants/playback';
import { FIELD } from '../constants/field';
import { Pitch } from './Pitch';
import { Ballpark } from './Ballpark';
import { Batter } from './Batter';
import { Catcher } from './Catcher';
import { Pitcher } from './Pitcher';
import { BattedBall } from './BattedBall';

// Tracks which keys are currently held down (lowercased), the same pattern
// used by the reference ballpark app's free-cam controls.
const useKeysPressed = () => {
    const [keys] = useState(() => new Set());
    useLayoutEffect(() => {
        const handleKeyDown = (e) => { keys.add(e.key.toLowerCase()); };
        const handleKeyUp = (e) => { keys.delete(e.key.toLowerCase()); };
        document.addEventListener('keydown', handleKeyDown);
        document.addEventListener('keyup', handleKeyUp);
        return () => {
            document.removeEventListener('keydown', handleKeyDown);
            document.removeEventListener('keyup', handleKeyUp);
        };
    }, [keys]);
    return keys;
};

// Free-cam movement across the diamond, modeled on the reference ballpark
// app's useDebugControls: WASD translates the camera in its own local space
// (W forward, S back, A/D strafe), Q/E move it up/down, and Shift sprints.
// Clicking the field locks the pointer for mouse-look (yaw + pitch); scrolling
// while locked adjusts the move speed. The orbit target shifts along with the
// camera so OrbitControls keeps orbiting around where you're looking instead
// of snapping back, and the camera is clamped to the ballpark (above the
// grass, inside the outfield grass circle).
const GRASS_RADIUS = feetToM(400); // field extent, matches Ballpark.jsx
const MIN_CAM_HEIGHT = 1; // m, keep the camera above the grass
const MOVE_SPEED = 10; // m/s
const BOOST_MULT = 3;
const ROTATION_SPEED = 0.0025; // rad of look per pixel of mouse movement

// Camera view persistence: the camera position + orbit target fully define
// the view (OrbitControls keeps the camera aimed at its target), so saving
// those two vectors is enough to restore any view angle. Saved to
// localStorage (throttled, and on page unload) and restored on mount, so the
// view survives page reloads.
const CAMERA_STORAGE_KEY = 'freebuff-camera-state';
const CAMERA_SAVE_INTERVAL_MS = 1000;

const loadCameraState = () => {
    try {
        const parsed = JSON.parse(localStorage.getItem(CAMERA_STORAGE_KEY));
        if (!parsed || !Array.isArray(parsed.position) || parsed.position.length !== 3
            || !Array.isArray(parsed.target) || parsed.target.length !== 3) return null;
        return { position: parsed.position, target: parsed.target };
    } catch {
        return null;
    }
};

const saveCameraState = (position, target) => {
    try {
        localStorage.setItem(CAMERA_STORAGE_KEY, JSON.stringify({
            position: [position.x, position.y, position.z],
            target: [target.x, target.y, target.z],
        }));
    } catch {
        // localStorage can be unavailable (private browsing, quota) — ignore.
    }
};

const WASDMovement = ({ controlsRef }) => {
    const { camera, gl } = useThree();
    const keys = useKeysPressed();
    const lockedRef = useRef(false);
    const lookDelta = useRef({ x: 0, y: 0 });
    const speedScaleRef = useRef(1);
    const spherical = useMemo(() => new Spherical(), []);

    // Pointer lock: mousedown on the field locks the pointer and enables
    // mouse-look; mouseup (or Esc) releases it. OrbitControls is disabled
    // while locked so the two don't fight over the camera.
    useEffect(() => {
        const canvas = gl.domElement;
        if (!canvas.requestPointerLock) return;

        const handleMouseMove = (e) => {
            if (!lockedRef.current) return;
            lookDelta.current.x += e.movementX || 0;
            lookDelta.current.y += e.movementY || 0;
        };
        const handleWheel = (e) => {
            if (!lockedRef.current) return;
            speedScaleRef.current = Math.min(5, Math.max(0.1, speedScaleRef.current - e.deltaY / 500));
        };
        const lockPointer = async (e) => {
            if (e.button !== 0 || lockedRef.current) return;
            if (controlsRef.current) controlsRef.current.enabled = false;
            try {
                await canvas.requestPointerLock({ unadjustedMovement: true });
            } catch {
                // Some browsers need a plain request first (unadjustedMovement
                // can be blocked by permission policy).
                try {
                    await canvas.requestPointerLock();
                } catch (err2) {
                    console.error('Pointer lock unavailable:', err2);
                    if (controlsRef.current) controlsRef.current.enabled = true;
                }
            }
        };
        const releasePointer = () => {
            if (document.pointerLockElement) document.exitPointerLock();
        };
        const handleLockChange = () => {
            const isLocked = document.pointerLockElement === canvas;
            lockedRef.current = isLocked;
            lookDelta.current.x = 0;
            lookDelta.current.y = 0;
            if (controlsRef.current) controlsRef.current.enabled = !isLocked;
        };

        canvas.addEventListener('mousedown', lockPointer);
        canvas.addEventListener('mouseup', releasePointer);
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('wheel', handleWheel);
        document.addEventListener('pointerlockchange', handleLockChange);

        return () => {
            canvas.removeEventListener('mousedown', lockPointer);
            canvas.removeEventListener('mouseup', releasePointer);
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('wheel', handleWheel);
            document.removeEventListener('pointerlockchange', handleLockChange);
            if (document.pointerLockElement) document.exitPointerLock();
        };
    }, [gl, controlsRef]);

    useFrame((_, delta) => {
        // Mouse-look while the pointer is locked (yaw then pitch). Instead of
        // rotating the camera's quaternion in place, we rotate the orbit
        // target around the camera and keep the camera pointed at it. That
        // keeps OrbitControls' target consistent with the view, so releasing
        // the pointer (which re-enables OrbitControls and re-aims the camera
        // at its target) doesn't snap the camera back to the old angle.
        if (lockedRef.current && (lookDelta.current.x !== 0 || lookDelta.current.y !== 0)) {
            const target = controlsRef.current ? controlsRef.current.target : null;
            if (target) {
                const offset = target.clone().sub(camera.position);
                const dist = offset.length();
                if (dist > 1e-6) {
                    spherical.setFromVector3(offset);
                    spherical.theta -= lookDelta.current.x * ROTATION_SPEED;
                    spherical.phi += lookDelta.current.y * ROTATION_SPEED;
                    spherical.makeSafe();
                    offset.setFromSpherical(spherical);
                    target.copy(camera.position).add(offset);
                    camera.lookAt(target);
                }
            }
            lookDelta.current.x = 0;
            lookDelta.current.y = 0;
        }

        const speed = MOVE_SPEED * speedScaleRef.current * (keys.has('shift') ? BOOST_MULT : 1) * Math.min(delta, 0.1);
        const prev = camera.position.clone();

        if (keys.has('w')) camera.translateZ(-speed);
        if (keys.has('s')) camera.translateZ(speed);
        if (keys.has('a')) camera.translateX(-speed);
        if (keys.has('d')) camera.translateX(speed);
        if (keys.has('q')) camera.translateY(-speed);
        if (keys.has('e')) camera.translateY(speed);

        // Clamp to the ballpark: stay above the grass and inside the field.
        const clampPos = (pos) => {
            pos.y = Math.max(MIN_CAM_HEIGHT, pos.y);
            const horiz = Math.hypot(pos.x, pos.z);
            if (horiz > GRASS_RADIUS) {
                const scale = GRASS_RADIUS / horiz;
                pos.x *= scale;
                pos.z *= scale;
            }
        };
        clampPos(camera.position);

        // Shift the orbit target along with the (clamped) camera movement so
        // OrbitControls keeps orbiting around where you're looking.
        const moved = camera.position.clone().sub(prev);
        if (moved.lengthSq() > 0 && controlsRef.current) {
            controlsRef.current.target.add(moved);
        }
        if (controlsRef.current) clampPos(controlsRef.current.target);
    });

    return null;
};

// Saves the camera position + orbit target to localStorage (throttled to one
// write per second, plus a final write on page unload). The camera never
// moves without WASDMovement/OrbitControls updating the target alongside it,
// so these two vectors always describe the current view.
const CameraPersistence = ({ controlsRef, followActiveRef, fielderCamActiveRef }) => {
    const camera = useThree((s) => s.camera);
    const lastSaveRef = useRef(0);

    useFrame(() => {
        // Don't persist transient follow / fielder cam views; the restored
        // pre-play angle is the one that should survive reloads.
        if (followActiveRef.current) return;
        if (fielderCamActiveRef?.current) return;
        const controls = controlsRef.current;
        if (!controls) return;
        const now = performance.now();
        if (now - lastSaveRef.current < CAMERA_SAVE_INTERVAL_MS) return;
        lastSaveRef.current = now;
        saveCameraState(camera.position, controls.target);
    });

    useEffect(() => {
        const save = () => {
            if (followActiveRef.current) return;
            if (fielderCamActiveRef?.current) return;
            const controls = controlsRef.current;
            if (controls) saveCameraState(camera.position, controls.target);
        };
        window.addEventListener('beforeunload', save);
        return () => window.removeEventListener('beforeunload', save);
    }, [camera, controlsRef, followActiveRef, fielderCamActiveRef]);

    return null;
};

const CameraController = ({ snapTrigger, controlsRef }) => {
    const { camera } = useThree();
    
    useEffect(() => {
        if (snapTrigger > 0) {
            const szTopM = 3.5 * 0.3048;
            const szBottomM = 1.5 * 0.3048;
            const cy = (szTopM + szBottomM) / 2;
            
            // Position camera behind the catcher, looking at the strike zone
            camera.position.set(0, cy, 2.5);
            
            if (controlsRef.current) {
                // Front of plate is at -0.4318, back is at 0. Target the middle.
                controlsRef.current.target.set(0, cy, -0.2159);
                controlsRef.current.update();
            } else {
                camera.lookAt(0, cy, -0.2159);
            }
        }
    }, [snapTrigger, camera, controlsRef]);
    
    return null;
};

// How long the follow camera glides back to the pre-play view after a batted
// ball lands. An ease-out curve (not an instant snap) makes the restore read
// as a smooth broadcast-style move instead of a jarring cut.
const FOLLOW_RESTORE_DURATION = 0.6;

// While enabled, follows the first batted-ball flight of each live pitch by
// keeping the camera aimed at the ball, then eases back to the pre-play view
// once that first animation finishes. Reads the ball position / completion
// signal published by BattedBall (a frame later at most), so it uses the
// default render priority — a positive priority would hand the render loop to
// this component and leave the scene blank.
const FollowBattedBall = ({ controlsRef, pitchData, enabled, completeSignalRef, followActiveRef, prePlayPoseRef }) => {
    const camera = useThree((s) => s.camera);
    // idle -> following -> restoring -> restored (restored ignores the same
    // play's looped re-animations until a new play id arrives and re-arms the
    // follower).
    const modeRef = useRef('idle');
    const followedPlayIdRef = useRef(null);
    const completionHandledRef = useRef(false);
    const lastCompleteSignalRef = useRef(0);
    const originalPositionRef = useRef(null);
    const originalTargetRef = useRef(null);
    // Start pose + elapsed time for the eased restore, so each frame can
    // interpolate the camera/target back toward the pre-play view.
    const restoreStartRef = useRef(null);
    const restoreElapsedRef = useRef(0);

    const snapRestore = () => {
        const controls = controlsRef.current;
        if (!controls || !originalPositionRef.current || !originalTargetRef.current) return;
        camera.position.copy(originalPositionRef.current);
        controls.target.copy(originalTargetRef.current);
        camera.lookAt(originalTargetRef.current);
        controls.update();
        controls.enabled = true;
    };

    const beginRestore = () => {
        const controls = controlsRef.current;
        if (!controls || !originalPositionRef.current || !originalTargetRef.current) {
            // Nothing to restore from; treat the play as already settled so the
            // follower never hangs in 'following' waiting on a pose it can't
            // reconstruct.
            modeRef.current = 'restored';
            followActiveRef.current = false;
            return;
        }
        restoreStartRef.current = {
            position: camera.position.clone(),
            target: controls.target.clone(),
        };
        restoreElapsedRef.current = 0;
        modeRef.current = 'restoring';
        followActiveRef.current = false;
    };

    useFrame((_, delta) => {
        const controls = controlsRef.current;
        const playId = pitchData?.play_id ?? null;

        // A new pitch arms the follower for its first batted-ball flight. If a
        // previous play's restore ease is still running (or it was still being
        // followed), finish it instantly so the next play captures the true
        // pre-play view — never a mid-ease pose or a stale ball aim.
        if (playId !== followedPlayIdRef.current) {
            if (modeRef.current === 'following' || modeRef.current === 'restoring') snapRestore();
            followedPlayIdRef.current = playId;
            completionHandledRef.current = false;
            lastCompleteSignalRef.current = completeSignalRef.current;
            modeRef.current = 'idle';
            followActiveRef.current = false;
            restoreStartRef.current = null;
            restoreElapsedRef.current = 0;
        }

        if (!enabled) {
            // Always snap back to the pre-play angle (even if already restored)
            // and enter 'restored' mode so the follower stays dormant when
            // re-enabled — e.g. after a fielder-cam replay ends mid-play.
            snapRestore();
            followActiveRef.current = false;
            modeRef.current = 'restored';
            return;
        }

        if (modeRef.current === 'restoring') {
            if (!controls || !restoreStartRef.current || !originalPositionRef.current || !originalTargetRef.current) {
                modeRef.current = 'restored';
                followActiveRef.current = false;
                return;
            }
            restoreElapsedRef.current += Math.min(delta, 0.1);
            const t = Math.min(restoreElapsedRef.current / FOLLOW_RESTORE_DURATION, 1);
            // Ease-out cubic: fast initial recovery that settles softly.
            const ease = 1 - Math.pow(1 - t, 3);
            camera.position.lerpVectors(restoreStartRef.current.position, originalPositionRef.current, ease);
            controls.target.lerpVectors(restoreStartRef.current.target, originalTargetRef.current, ease);
            camera.lookAt(controls.target);
            controls.update();
            controls.enabled = false;
            if (t >= 1) {
                snapRestore();
                modeRef.current = 'restored';
                restoreStartRef.current = null;
            }
            return;
        }

        if (modeRef.current === 'idle') {
            const ball = getBattedBallPosition();
            // Only engage once the batted ball genuinely belongs to THIS pitch:
            // the shared position is published with its owning play id, so a
            // stale position left behind by a previous play can never trick the
            // camera into following a vanished ball. A live contact pitch whose
            // Statcast hit hasn't arrived yet publishes no position at all, so
            // the follower simply waits for the pitch's own launch instead of
            // grabbing anything that happens to be in flight.
            if (ball && controls && playId && ball.playId === playId) {
                originalPositionRef.current = camera.position.clone();
                originalTargetRef.current = controls.target.clone();
                // Publish the authoritative pre-play pose so FielderCam
                // always restores to the true original angle — even if its
                // trigger fires while we are mid-restore from a prior follow.
                if (prePlayPoseRef) {
                    prePlayPoseRef.current = {
                        position: originalPositionRef.current.clone(),
                        target: originalTargetRef.current.clone(),
                    };
                }
                controls.enabled = false;
                modeRef.current = 'following';
                followActiveRef.current = true;
            } else {
                return;
            }
        }

        if (modeRef.current !== 'following') return;

        // Keep the camera aimed at the ball while it is airborne. Once the ball
        // is down but the play is still animating (fielder run / throw), hold
        // the last aimed view until the play completes.
        const ball = getBattedBallPosition();
        if (ball && ball.playId === playId && controls) {
            controls.target.set(ball.x, ball.y, ball.z);
            camera.lookAt(ball.x, ball.y, ball.z);
            controls.enabled = false;
        }

        // First completion of this play: ease back to the pre-play view.
        if (!completionHandledRef.current && completeSignalRef.current !== lastCompleteSignalRef.current) {
            completionHandledRef.current = true;
            lastCompleteSignalRef.current = completeSignalRef.current;
            beginRestore();
        }
    });

    return null;
};

// How long the fielder camera eases back to the pre-play view after the replay
// finishes (same ease-out curve as the follow-cam restore).
const FIELDER_CAM_RESTORE_DURATION = 0.6;
// Height of the camera above the fielder's feet (head height).
const FIELDER_CAM_HEAD_Y = 1.8;
// Height of the label above the fielder's head.
const FIELDER_LABEL_OFFSET_Y = 2.8;
// Maps Statcast position codes to human-readable names.
const POSITION_NAMES = {
  P: 'Pitcher', C: 'Catcher', '1B': 'First Baseman', '2B': 'Second Baseman',
  '3B': 'Third Baseman', SS: 'Shortstop', LF: 'Left Fielder', CF: 'Center Fielder',
  RF: 'Right Fielder',
};

// Switches the camera to a position near the fielder who fields the ball and
// tracks the ball from that angle for one cycle, then restores the original
// view. Triggered by the `fielderCamTrigger` counter (bumped from App.jsx
// after the first animation completes or by the replay button).
const FielderCam = ({ controlsRef, pitchData, completeSignalRef, fielderCamTrigger, onEnd, onActiveChange, fielderPosition, prePlayPoseRef }) => {
    const camera = useThree((s) => s.camera);
    // idle -> waiting (for next cycle) -> following -> restoring -> idle
    const modeRef = useRef('idle');
    // Currently visible mode (reactively updated for the Html label).
    const [visibleMode, setVisibleMode] = useState('idle');
    // Position of the fielder label overlay, updated each frame while following.
    const [labelPos, setLabelPos] = useState(null);
    const originalPositionRef = useRef(null);
    const originalTargetRef = useRef(null);
    const restoreStartRef = useRef(null);
    const restoreElapsedRef = useRef(0);
    const lastCompleteSignal = useRef(0);
    const lastTrigger = useRef(0);
    const camPos = useMemo(() => new Vector3(), []);
    const followedPlayIdRef = useRef(null);

    const snapRestore = () => {
        const controls = controlsRef.current;
        if (!controls || !originalPositionRef.current || !originalTargetRef.current) return;
        camera.position.copy(originalPositionRef.current);
        controls.target.copy(originalTargetRef.current);
        camera.lookAt(originalTargetRef.current);
        controls.update();
        controls.enabled = true;
    };

    // When the trigger counter bumps, save the current camera, disable orbit
    // controls, snap to the fielder's head immediately, and enter 'waiting'
    // mode (or 'following' if the ball is already in flight). This way the
    // camera jumps to the fielder's perspective the instant the button is
    // clicked or the auto-replay fires — no delay until the next cycle.
    useEffect(() => {
        if (fielderCamTrigger > lastTrigger.current) {
            lastTrigger.current = fielderCamTrigger;
            const controls = controlsRef.current;
            if (controls) {
                // Prefer the authoritative pre-play pose (set by FollowBattedBall
                // when it first started tracking) over the live camera position.
                // This ensures we restore to the true pre-play angle even when
                // the trigger fires while FollowBattedBall is mid-restore.
                if (prePlayPoseRef?.current) {
                    originalPositionRef.current = prePlayPoseRef.current.position.clone();
                    originalTargetRef.current = prePlayPoseRef.current.target.clone();
                } else {
                    originalPositionRef.current = camera.position.clone();
                    originalTargetRef.current = controls.target.clone();
                }
                controls.enabled = false;
            }
            lastCompleteSignal.current = completeSignalRef.current;
            followedPlayIdRef.current = pitchData?.play_id ?? null;

            // Snap to the fielder's head right now — don't wait for the next
            // useFrame tick. Prefer the live chaser position; fall back to the
            // defensive spot if the chaser isn't published yet (e.g. before
            // the batted ball launched).
            const playId = pitchData?.play_id ?? null;
            const chaser = getChaserPosition();
            const ball = getPlayBallPosition() || getBattedBallPosition();
            const home = fielderPosition ? FIELD.DEFENSE[fielderPosition] : null;
            let snapped = false;
            if (chaser && chaser.playId === playId) {
                camPos.set(chaser.x, chaser.y + FIELDER_CAM_HEAD_Y, chaser.z);
                if (camPos.y < 1) camPos.y = 1;
                camera.position.copy(camPos);
                setLabelPos({ x: chaser.x, y: chaser.y + FIELDER_LABEL_OFFSET_Y, z: chaser.z });
                if (ball && ball.playId === playId && controls) {
                    controls.target.set(ball.x, ball.y, ball.z);
                    camera.lookAt(ball.x, ball.y, ball.z);
                }
                if (controls) controls.enabled = false;
                snapped = true;
            } else if (home) {
                // No live chaser: snap to the defensive spot (will update once
                // the batted ball launches and the chaser starts moving).
                camPos.set(home.x, FIELDER_CAM_HEAD_Y, home.z);
                if (camPos.y < 1) camPos.y = 1;
                camera.position.copy(camPos);
                setLabelPos({ x: home.x, y: FIELDER_LABEL_OFFSET_Y, z: home.z });
                if (controls) {
                    // Pitcher: look at the plate / strike zone.
                    // Other fielders: look toward the pitcher on the mound.
                    const look = fielderPosition === 'P'
                        ? { x: 0, y: 1.0, z: -1 }
                        : { x: FIELD.DEFENSE.P.x, y: 1.8, z: FIELD.DEFENSE.P.z };
                    controls.target.set(look.x, look.y, look.z);
                    camera.lookAt(look.x, look.y, look.z);
                    controls.enabled = false;
                }
                snapped = true;
            }

            // Also handle the case where we have a live chaser but no ball —
            // the fielder is running but the ball hasn't launched yet (or is
            // on the ground). Still aim at the pitcher so the initial view is
            // locked there instead of drifting from the previous angle.
            if (snapped && chaser && chaser.playId === playId && !(ball && ball.playId === playId) && controls) {
                const look = fielderPosition === 'P'
                    ? { x: 0, y: 1.0, z: -1 }
                    : { x: FIELD.DEFENSE.P.x, y: 1.8, z: FIELD.DEFENSE.P.z };
                controls.target.set(look.x, look.y, look.z);
                camera.lookAt(look.x, look.y, look.z);
            }

            // If we snapped to the chaser and there's a play in progress
            // (ball is flying), go straight to 'following' so the completion
            // tracking is armed. Otherwise stay in 'waiting' until the next
            // cycle's launch moves us to 'following'.
            if (snapped && chaser && chaser.playId === playId) {
                modeRef.current = 'following';
                setVisibleMode('following');
            } else {
                modeRef.current = 'waiting';
                setVisibleMode('waiting');
            }
            setFielderCamActive(true);
            if (onActiveChange) onActiveChange(true);
        }
    }, [fielderCamTrigger]);

    // Restore orbit controls on unmount so the user is never stuck.
    useEffect(() => {
        return () => {
            if (controlsRef.current) controlsRef.current.enabled = true;
            setFielderCamActive(false);
            if (onActiveChange) onActiveChange(false);
        };
    }, []);

    useFrame((_, delta) => {
        const controls = controlsRef.current;
        const playId = pitchData?.play_id ?? null;

        // If the pitch changed while we were in fielder cam, abort and restore.
        if (playId !== followedPlayIdRef.current && modeRef.current !== 'idle') {
            snapRestore();
            modeRef.current = 'idle';
            setVisibleMode('idle');
            setLabelPos(null);
            setFielderCamActive(false);
            if (onEnd) onEnd();
            return;
        }

        // Both 'waiting' and 'following' lock the camera to the fielder's
        // head — the only difference is whether we're also tracking the ball
        // and counting down to completion. This keeps the camera continuous
        // from trigger through restore with no mid-phase snap.
        const isActive = modeRef.current === 'waiting' || modeRef.current === 'following';

        if (isActive) {
            if (!controls) return;
            const ball = getPlayBallPosition() || getBattedBallPosition();
            const chaser = getChaserPosition();
            const home = fielderPosition ? FIELD.DEFENSE[fielderPosition] : null;

            // Lock the camera at the fielder's head as soon as the position
            // is available (the chaser publishes once the batted ball
            // launches). Before then (during the pitcher's windup) snap to
            // the fielder's defensive spot so the view never jumps.
            if (chaser && chaser.playId === playId) {
                camPos.set(chaser.x, chaser.y + FIELDER_CAM_HEAD_Y, chaser.z);
                if (camPos.y < 1) camPos.y = 1;
                camera.position.copy(camPos);
                setLabelPos({ x: chaser.x, y: chaser.y + FIELDER_LABEL_OFFSET_Y, z: chaser.z });

                // Track the ball through the entire play (airborne flight,
                // throws to bases, carries). Falls back to the batted-ball
                // position for the airborne portion; during choreography
                // the play-ball position follows throws and carries too.
                if (ball && ball.playId === playId) {
                    controls.target.set(ball.x, ball.y, ball.z);
                    camera.lookAt(ball.x, ball.y, ball.z);
                } else {
                    // No ball in flight yet: aim at the pitcher so the view
                    // is always locked on the mound rather than drifting.
                    const look = fielderPosition === 'P'
                        ? { x: 0, y: 1.0, z: -1 }
                        : { x: FIELD.DEFENSE.P.x, y: 1.8, z: FIELD.DEFENSE.P.z };
                    controls.target.set(look.x, look.y, look.z);
                    camera.lookAt(look.x, look.y, look.z);
                }
                controls.enabled = false;

                // Once we have a chaser position, we're effectively
                // 'following' (even if we'd been 'waiting'). Re-arm
                // completion tracking for this cycle.
                if (modeRef.current === 'waiting') {
                    modeRef.current = 'following';
                    setVisibleMode('following');
                    lastCompleteSignal.current = completeSignalRef.current;
                }
            } else if (home && modeRef.current === 'waiting') {
                // Windup: no chaser position yet. Snap to the fielder's
                // defensive spot so the view starts from their head during
                // the pitcher's windup and pitch flight.
                camPos.set(home.x, FIELDER_CAM_HEAD_Y, home.z);
                if (camPos.y < 1) camPos.y = 1;
                camera.position.copy(camPos);
                setLabelPos({ x: home.x, y: FIELDER_LABEL_OFFSET_Y, z: home.z });
                // Pitcher: look at the plate / strike zone.
                // Other fielders: look toward the pitcher on the mound.
                const look = fielderPosition === 'P'
                    ? { x: 0, y: 1.0, z: -1 }
                    : { x: FIELD.DEFENSE.P.x, y: 1.8, z: FIELD.DEFENSE.P.z };
                controls.target.set(look.x, look.y, look.z);
                camera.lookAt(look.x, look.y, look.z);
                controls.enabled = false;
            }

            // The play completed this cycle: begin easing back to the original view.
            if (modeRef.current === 'following' && completeSignalRef.current !== lastCompleteSignal.current) {
                lastCompleteSignal.current = completeSignalRef.current;
                if (originalPositionRef.current && originalTargetRef.current && controls) {
                    restoreStartRef.current = {
                        position: camera.position.clone(),
                        target: controls.target.clone(),
                    };
                    restoreElapsedRef.current = 0;
                    modeRef.current = 'restoring';
                    setVisibleMode('restoring');
                    setLabelPos(null);
                } else {
                    modeRef.current = 'idle';
                    setVisibleMode('idle');
                    setLabelPos(null);
                    setFielderCamActive(false);
                    if (onEnd) onEnd();
                }
            }
            return;
        }

        if (modeRef.current === 'restoring') {
            if (!controls || !restoreStartRef.current || !originalPositionRef.current || !originalTargetRef.current) {
                modeRef.current = 'idle';
                setVisibleMode('idle');
                setLabelPos(null);
                setFielderCamActive(false);
                if (onEnd) onEnd();
                return;
            }
            restoreElapsedRef.current += Math.min(delta, 0.1);
            const t = Math.min(restoreElapsedRef.current / FIELDER_CAM_RESTORE_DURATION, 1);
            const ease = 1 - Math.pow(1 - t, 3);
            camera.position.lerpVectors(restoreStartRef.current.position, originalPositionRef.current, ease);
            controls.target.lerpVectors(restoreStartRef.current.target, originalTargetRef.current, ease);
            camera.lookAt(controls.target);
            controls.update();
            controls.enabled = false;
            if (t >= 1) {
                snapRestore();
                modeRef.current = 'idle';
                setVisibleMode('idle');
                setLabelPos(null);
                setFielderCamActive(false);
                if (onEnd) onEnd();
            }
        }
    });

    // Show the fielder's position + name as a small overlay label while the
    // camera is active ('waiting' or 'following'). Positioned above the
    // chaser's head and updated every frame.
    const showLabel = (visibleMode === 'waiting' || visibleMode === 'following') && fielderPosition && labelPos;
    const positionName = POSITION_NAMES[fielderPosition] || fielderPosition;

    if (!showLabel) return null;

    return (
        <Html position={[labelPos.x, labelPos.y, labelPos.z]} center style={{
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
        }}>
            <div style={{
                background: 'rgba(0,0,0,0.75)',
                color: '#ffd166',
                padding: '3px 10px',
                borderRadius: 5,
                fontSize: 12,
                fontFamily: 'monospace',
                fontWeight: 'bold',
                letterSpacing: '0.05em',
                textShadow: '0 0 6px rgba(0,0,0,0.8)',
                border: '1px solid rgba(255,209,102,0.35)',
            }}>
                {fielderPosition} · {positionName}
            </div>
        </Html>
    );
};

export const Scene = ({ pitchData, defaultPitchData, battedBall, snapTrigger, crossingPlane, onCrossings, onArrival, onPlayResult, onComplete, comparisonActive = false, comparisonPlays = [], replayKey = 0, showColoredTails = true, showBillowParticles = true, showComparisonRingLabels = true, followEnabled = true, fielderCamTrigger = 0, onFielderCamEnd = null, defenseAlignment = null }) => {
    const controlsRef = useRef();
    // True while the follow camera is actively tracking a batted ball; camera
    // persistence skips saving so a transient follow angle never survives a
    // reload in place of the restored pre-play angle.
    const followActiveRef = useRef(false);
    // Bumped every time BattedBall finishes a play so the follow camera knows
    // when the first animation of a live play has completed.
    const completeSignalRef = useRef(0);
    // Tracks whether the fielder cam is currently active, shared with
    // FollowBattedBall so it stays idle during the fielder cam replay.
    // A ref mirrors the state so CameraPersistence (which reads in useFrame)
    // can also skip saving the transient fielder cam view.
    const [fielderCamActive, setFielderCamActive] = useState(false);
    const fielderCamActiveRef = useRef(false);
    // Shared authoritative pre-play camera pose, written by FollowBattedBall
    // when it first starts following the ball — this is the true pre-play angle
    // (before any ball-tracking moved the camera). FielderCam reads from it
    // when the trigger fires so it restores to the correct angle even if the
    // trigger fires while FollowBattedBall is still mid-restore.
    const prePlayPoseRef = useRef(null);
    const setFielderCamActiveBoth = useCallback((v) => {
        fielderCamActiveRef.current = v;
        setFielderCamActive(v);
    }, []);
    const handleBattedComplete = useCallback((source, details) => {
        completeSignalRef.current += 1;
        if (onComplete) onComplete(source, details);
    }, [onComplete]);
    const handleFielderCamEnd = useCallback(() => {
        setFielderCamActiveBoth(false);
        if (onFielderCamEnd) onFielderCamEnd();
    }, [onFielderCamEnd, setFielderCamActiveBoth]);
    // Restore the last saved view on mount (read once, localStorage).
    const initialCam = useMemo(() => loadCameraState(), []);
    // Stable identity so OrbitControls doesn't re-apply the target on every render.
    const controlsTarget = useMemo(() => initialCam?.target ?? [0, 1.6, -18], [initialCam]);
    // In comparison mode render one pitcher per distinct mound man so a
    // mid-selection pitching change overlays both. Group by the payload's
    // pitcher name (the trajectory payload's only stable pitcher identifier).
    const comparisonPitchers = useMemo(() => {
        const byPitcher = new Map();
        for (const play of comparisonPlays) {
            const pitch = play?.pitch;
            if (!pitch) continue;
            const key = pitch.pitcher ?? pitch.pitcher_id ?? 'pitcher';
            if (!byPitcher.has(key)) byPitcher.set(key, pitch);
        }
        return [...byPitcher.entries()];
    }, [comparisonPlays]);

    return (
        <Canvas camera={{ position: initialCam?.position ?? [0, 1.6, 2.2], fov: 60 }}>
            <CameraController snapTrigger={snapTrigger} controlsRef={controlsRef} />

            {/* Persists the view to localStorage so it survives page reloads */}
            <CameraPersistence controlsRef={controlsRef} followActiveRef={followActiveRef} fielderCamActiveRef={fielderCamActiveRef} />

            {/* WASD free movement across the diamond (Shift to sprint) */}
            <WASDMovement controlsRef={controlsRef} />
            
            {/* Lighting */}
            <ambientLight intensity={0.5} />
            <directionalLight position={[10, 10, 5]} intensity={1} castShadow />
            
            {/* Environment to make it look a bit nicer out of the box */}
            <Sky sunPosition={[100, 20, 100]} />
            <React.Suspense fallback={null}>
                <Environment preset="park" />
            </React.Suspense>
            
            {/* Diamond / ballpark sprites */}
            <Ballpark />
            
            {/* Pitch Visualization Component. In comparison mode the single
                live pitch/batter is replaced by every selected pitch overlaid
                together (plus the overlaid pitcher(s) above and each contact
                pitch's batted ball — flight only, no fielding). */}
            {comparisonActive ? (
                <>
                    {/* Pitcher(s) at the mound, overlaid and dimmed so a
                        pitching change between the selected pitches is still
                        legible. Each winds up on the shared cycle. */}
                    {comparisonPitchers.map(([key, pitch]) => (
                        <Pitcher key={`compare-pitcher-${replayKey}-${key}`} pitchData={pitch} overlay />
                    ))}
                    {comparisonPlays.map((play, i) => (
                        <Pitch key={`compare-pitch-${replayKey}-${i}`} pitchData={play.pitch} overlay showRingLabel={showComparisonRingLabels} showColoredTail={showColoredTails} showBillows={showBillowParticles} />
                    ))}
                    {comparisonPlays
                        .filter((play) => play.pitch?.is_contact === true)
                        .map((play, i) => (
                            <BattedBall
                                key={`compare-hit-${replayKey}-${i}`}
                                pitchData={play.pitch}
                                hit={play.hit}
                                comparison
                            />
                        ))}
                </>
            ) : (
                <>
                    <Pitch pitchData={pitchData} defaultPitchData={defaultPitchData} crossingPlane={crossingPlane} onCrossings={onCrossings} onArrival={onArrival} showColoredTail={showColoredTails} showBillows={showBillowParticles} />

                    {/* Batter at the plate, swinging with the live at-bat data */}
                    <Batter pitchData={pitchData} />

                    {/* Pitcher at the mound (ported player.glb): winds up and throws
                        on the shared playback cycle, releasing exactly when the pitch
                        ball starts flying */}
                    <Pitcher pitchData={pitchData} />

                    {/* Batted-ball + fielder trajectory (driven by Statcast hit data),
                        launched when the pitch reaches the spot it is hit */}
                    <BattedBall pitchData={pitchData} hit={battedBall} onPlayResult={onPlayResult} onComplete={handleBattedComplete} defenseAlignment={defenseAlignment} />
                </>
            )}

            {/* Crouching catcher behind the plate; fades out when the camera
                moves in close behind the strike zone so the zone stays visible */}
            <Catcher />
            
            {/* Camera Controls */}
            <OrbitControls makeDefault ref={controlsRef} target={controlsTarget} />

            {/* Follows the batted-ball trajectory when enabled (default on),
                then restores the pre-play view after the play's first run.
                Suppressed while the fielder camera replay is active. */}
            <FollowBattedBall
                controlsRef={controlsRef}
                pitchData={pitchData}
                enabled={followEnabled && !fielderCamActive}
                completeSignalRef={completeSignalRef}
                followActiveRef={followActiveRef}
                prePlayPoseRef={prePlayPoseRef}
            />

            {/* Switches to a fielder's perspective for one replay cycle after
                the first animation completes (or via the replay button). */}
            <FielderCam
                controlsRef={controlsRef}
                pitchData={pitchData}
                completeSignalRef={completeSignalRef}
                fielderCamTrigger={fielderCamTrigger}
                onEnd={handleFielderCamEnd}
                onActiveChange={setFielderCamActiveBoth}
                fielderPosition={battedBall?.fielder ?? null}
                prePlayPoseRef={prePlayPoseRef}
            />
        </Canvas>
    );
};
