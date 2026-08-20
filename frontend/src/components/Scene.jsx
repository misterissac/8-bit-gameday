import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, Sky, Environment } from '@react-three/drei';
import { Spherical } from 'three';
import { feetToM } from '../util/MathUtil';
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
const CameraPersistence = ({ controlsRef }) => {
    const camera = useThree((s) => s.camera);
    const lastSaveRef = useRef(0);

    useFrame(() => {
        const controls = controlsRef.current;
        if (!controls) return;
        const now = performance.now();
        if (now - lastSaveRef.current < CAMERA_SAVE_INTERVAL_MS) return;
        lastSaveRef.current = now;
        saveCameraState(camera.position, controls.target);
    });

    useEffect(() => {
        const save = () => {
            const controls = controlsRef.current;
            if (controls) saveCameraState(camera.position, controls.target);
        };
        window.addEventListener('beforeunload', save);
        return () => window.removeEventListener('beforeunload', save);
    }, [camera, controlsRef]);

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

export const Scene = ({ pitchData, defaultPitchData, battedBall, snapTrigger, crossingPlane, onCrossings, onArrival, onPlayResult, onComplete, comparisonActive = false, comparisonPlays = [] }) => {
    const controlsRef = useRef();
    // Restore the last saved view on mount (read once, localStorage).
    const initialCam = useMemo(() => loadCameraState(), []);
    // Stable identity so OrbitControls doesn't re-apply the target on every render.
    const controlsTarget = useMemo(() => initialCam?.target ?? [0, 0, -25], [initialCam]);

    return (
        <Canvas camera={{ position: initialCam?.position ?? [0, 42, 82], fov: 60 }}>
            <CameraController snapTrigger={snapTrigger} controlsRef={controlsRef} />

            {/* Persists the view to localStorage so it survives page reloads */}
            <CameraPersistence controlsRef={controlsRef} />

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
                live pitch/batter/pitcher are replaced by every selected pitch
                overlaid together, plus each contact pitch's batted ball (flight
                only, no fielding). */}
            {comparisonActive ? (
                <>
                    {comparisonPlays.map((play, i) => (
                        <Pitch key={`compare-pitch-${i}`} pitchData={play.pitch} overlay />
                    ))}
                    {comparisonPlays
                        .filter((play) => play.pitch?.is_contact === true)
                        .map((play, i) => (
                            <BattedBall
                                key={`compare-hit-${i}`}
                                pitchData={play.pitch}
                                hit={play.hit}
                                comparison
                            />
                        ))}
                </>
            ) : (
                <>
                    <Pitch pitchData={pitchData} defaultPitchData={defaultPitchData} crossingPlane={crossingPlane} onCrossings={onCrossings} onArrival={onArrival} />

                    {/* Batter at the plate, swinging with the live at-bat data */}
                    <Batter pitchData={pitchData} />

                    {/* Pitcher at the mound (ported player.glb): winds up and throws
                        on the shared playback cycle, releasing exactly when the pitch
                        ball starts flying */}
                    <Pitcher pitchData={pitchData} />

                    {/* Batted-ball + fielder trajectory (driven by Statcast hit data),
                        launched when the pitch reaches the spot it is hit */}
                    <BattedBall pitchData={pitchData} hit={battedBall} onPlayResult={onPlayResult} onComplete={onComplete} />
                </>
            )}

            {/* Crouching catcher behind the plate; fades out when the camera
                moves in close behind the strike zone so the zone stays visible */}
            <Catcher />
            
            {/* Camera Controls */}
            <OrbitControls makeDefault ref={controlsRef} target={controlsTarget} />
        </Canvas>
    );
};
