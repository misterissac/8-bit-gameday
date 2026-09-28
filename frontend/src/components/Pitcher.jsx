import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useLoader } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { TextureLoader } from 'three';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { getCycleDuration, getTimeScale, stepSimulation } from '../constants/playback';
import { getTuning, useTuning } from '../constants/tuning';
import { createPlayerRig, measurePlayerRig } from '../util/playerRig';
import { blendPose, pitcherIdle, pitcherPose } from '../util/pitcherSequence';

// ---------------------------------------------------------------------------
// Pitcher at the mound: the reference project's player.glb character, driven the
// way the batter is — by joint targets in the model's own rig (see
// util/playerRig.js) — and *not* by the reference's canned RightHandPitch /
// LeftHandPitch clips.
//
// The clips are a fixed performance at a fixed scale, so the ball leaves the hand
// wherever the clip happens to put it. Everything downstream of that is a
// workaround: the body had to be placed so that a hard-coded hand offset
// (`HAND_OFFSET_*` below, read off the reference's blender scene) landed on the
// pitch's release point, which slid the pitcher a few tenths of a metre around
// the mound from pitch to pitch and hung his release on a number that has nothing
// to do with this model's arms. With the delivery authored as joint targets
// (util/pitcherSequence.js) the two are separate and both are right: the delivery
// is posed from the release point's own height, and the *body* is then placed
// wherever that delivery's release lands on the trajectory's first sample — so
// the ball leaves the hand the pitch is drawn from, every pitch, whatever the
// release point is.
//
// The rest of the reference's pitcher behaviour is kept: the uniform texture on
// the body/hands/cap with the helmet hidden, the glove on the non-throwing hand,
// the throw synced to the shared pitch cycle so the release lands on the cycle's
// wrap (t = 0, when the pitch ball appears and flies), and the between-pitches
// idle — which is now the same set stance breathing, since the delivery is
// authored to end where it begins.
// ---------------------------------------------------------------------------

const PLAYER_MODEL_URL = '/models/player.glb';
const HOME_TEXTURE_URL = '/textures/HomePlayer_BaseColor.png';
const AWAY_TEXTURE_URL = '/textures/AwayPlayer_BaseColor.png';

// The pitcher's rig frame is the model's own (measurePlayerRig with no sprite
// nominal height): the body already stands at world size on the mound, so one rig
// unit is one metre and the delivery's joint targets are metres. See the driver's
// header for the frame's own axes.

// Warm the GLTF cache so the first pitch doesn't suspend for long.
useGLTF.preload(PLAYER_MODEL_URL);

const UP = new THREE.Vector3(0, 1, 0);
const _ball = new THREE.Vector3();

export const Pitcher = ({ pitchData, replayKey = 0, overlay = false }) => {
    const tuning = useTuning();
    const pitcherTuning = tuning.pitcher;
    const gltf = useGLTF(PLAYER_MODEL_URL);
    // Deep clone (skeleton re-bound) so the shared useGLTF cache isn't mutated
    // by the per-pitch materials/visibility — the same SkeletonUtils.clone the
    // reference uses for every character.
    const body = useMemo(() => {
        const model = cloneSkeleton(gltf.scene);
        // The model's joints in the rig's frame, measured once at its rest pose —
        // the frame every target in the delivery is authored in.
        const metrics = measurePlayerRig(model);
        // ...and the rest pose itself, snapshotted before the driver writes to it:
        // the pose is authored *relative* to the resting skeleton (see
        // createPlayerRig).
        const restPose = new Map();
        model.traverse((child) => {
            if (!child.isBone) return;
            restPose.set(child, {
                position: child.position.clone(),
                quaternion: child.quaternion.clone(),
            });
        });
        return { model, metrics, restPose };
    }, [gltf]);
    const model = body.model;
    const rig = body.metrics;
    const groupRef = useRef();
    const prevPhaseRef = useRef(null);
    const fadeRef = useRef(0);

    const pitchHand = pitchData?.pitch_hand || 'R';
    const isRHP = pitchHand === 'R';
    // The pitcher is the fielding team: top of the inning → the home team
    // bats, so the away team fields (away uniform).
    const teamType = pitchData?.is_top_inning ? 'away' : 'home';
    const teamTexture = useLoader(TextureLoader, teamType === 'away' ? AWAY_TEXTURE_URL : HOME_TEXTURE_URL);

    // Uniform: body + hands + cap get the team texture (flipY=false, sRGB,
    // repeat wrapping — the reference's texture setup); the helmet is hidden
    // (defense wears the cap); the glove keeps its original material.
    useEffect(() => {
        const tex = teamTexture;
        tex.flipY = false;
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;

        const get = (name) => model.getObjectByName(name);
        const bodyMesh = get('JOINED');
        const cap = get('CAP');
        const helmet = get('Helmet');
        const handR = get('HandR');
        const handL = get('HandL');
        const gloveL = get('GloveL');
        if (!bodyMesh || !handR || !handL || !gloveL) return;

        const bodyMaterial = new THREE.MeshStandardMaterial({ map: tex, roughness: 1 });
        bodyMesh.material = bodyMaterial;
        cap.material = bodyMaterial;
        handR.material = bodyMaterial;
        handL.material = bodyMaterial;
        if (helmet) helmet.visible = false;
        // The glove keeps its original leather texture (the reference's mit
        // material), just re-created so the cache's material stays pristine.
        const gloveMap = gloveL.material?.map ?? null;
        gloveL.material = new THREE.MeshStandardMaterial({ map: gloveMap, roughness: 1 });

        model.traverse((child) => {
            if (child.isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;
            }
        });
    }, [model, teamTexture]);

    // Glove hand (the reference's setGloveHand, called with the opposite hand):
    // a right-handed pitcher wears the glove on the LEFT hand and throws with
    // the bare right hand.
    useEffect(() => {
        const get = (name) => model.getObjectByName(name);
        const handR = get('HandR');
        const handL = get('HandL');
        const gloveR = get('GloveR');
        const gloveL = get('GloveL');
        if (!handR || !handL || !gloveR || !gloveL) return;
        if (isRHP) {
            gloveL.visible = true;
            gloveR.visible = false;
            handR.visible = true;
            handL.visible = false;
        } else {
            gloveL.visible = false;
            gloveR.visible = true;
            handR.visible = false;
            handL.visible = true;
        }
    }, [model, isRHP]);

    // Tunneling overlay: dim every mesh so several overlaid pitchers (after a
    // pitching change) can be seen through one another. depthWrite is disabled
    // while translucent so a front pitcher doesn't hide the one behind it.
    useEffect(() => {
        model.traverse((child) => {
            if (!child.isMesh) return;
            const materials = Array.isArray(child.material) ? child.material : [child.material];
            for (const mat of materials) {
                if (!mat) continue;
                mat.transparent = overlay;
                mat.opacity = overlay ? pitcherTuning.overlayOpacity : 1;
                mat.depthWrite = !overlay;
            }
        });
    }, [model, overlay, pitcherTuning.overlayOpacity]);

    // The bone driver needs the model mounted — it reads the live bones and the
    // frame the model sits in — so it is built once the model is really in the
    // scene. Held in state rather than a ref for the reason Batter.jsx records:
    // player.glb can finish loading before the component's first commit that
    // mounts the body, and a ref read once would be empty.
    const rigDriverRef = useRef(null);
    const [modelNode, setModelNode] = useState(null);
    useLayoutEffect(() => {
        if (!modelNode) return undefined;
        // The model sits at the group's own origin (no placement offset): the
        // delivery's targets are authored from the model's own root, so the rig
        // frame and the group's frame are the same frame.
        rigDriverRef.current = createPlayerRig(body.model, body.metrics, body.restPose);
        return () => { rigDriverRef.current = null };
    }, [modelNode, body]);

    // Reset the crossfade whenever a new pitch arrives or replay fires, keeping
    // the windup in phase with the simulation clock.
    useLayoutEffect(() => {
        prevPhaseRef.current = null;
        fadeRef.current = 0;
    }, [pitchData, replayKey]);

    // Where the body stands, and which way it faces, for this pitch.
    //
    // The delivery's own release frame is the anchor: its ball's place in the rig
    // frame (`pitcherPose` at the release clock) is the point that has to land on
    // the trajectory's first sample, so the group is placed at the release point
    // less that — the same "place the body from the release" the clip-driven
    // version did, but read off a pose this model really holds instead of a
    // constant read off another project's scene. The pitch's release height is
    // read *into* the pose (see pitcherRelease): a delivery is aimed and leaned by
    // where its own ball leaves from, so a pitch released higher is thrown by a
    // taller slot and not by a stretched arm.
    //
    // The group faces home plate with the model's own half turn inside it (the rig
    // frame faces -Z, the model rests facing +Z), so the yaw is the one that
    // points the group's +Z away from the plate: `atan2(x, z)` of the body's own
    // place. It is solved twice because the body's place is what the yaw is
    // measured from and the yaw is what places it — two passes converge to well
    // under a millimetre, and the residual is the same order as the driver's own
    // wrist solve.
    const placement = useMemo(() => {
        const traj = pitchData?.trajectory;
        if (!traj || traj.length === 0) return null;
        const release = new THREE.Vector3(traj[0].x, traj[0].z, -traj[0].y);
        const releaseTime = Math.max(0.001, tuning.playback.ballReleaseTime);
        const pose = pitcherPose(releaseTime, {
            rig,
            hand: pitchHand,
            height: release.y,
            releaseTime,
        });
        _ball.set(pose.ball[0], pose.ball[1], pose.ball[2]);
        const position = release.clone();
        let yaw = 0;
        for (let pass = 0; pass < 2; pass += 1) {
            yaw = Math.atan2(position.x, position.z);
            position.copy(release).sub(_ball.clone().applyAxisAngle(UP, yaw));
        }
        return {
            position,
            yaw,
            release,
            contactTime: traj[traj.length - 1].t,
        };
    }, [pitchData, rig, pitchHand, tuning.playback.ballReleaseTime]);

    useFrame((state, delta) => {
        const { time: t } = stepSimulation(delta, state.clock.elapsedTime);

        const group = groupRef.current;
        const driver = rigDriverRef.current;
        if (!group || !placement) return;

        // The body stands where its own delivery's release is this pitch's, and
        // faces home plate.
        group.position.copy(placement.position);
        group.rotation.set(0, placement.yaw, 0);
        if (!driver) return;

        // Shared cycle clock (same as Pitch/Batter/BattedBall).
        const loopDuration = getCycleDuration();

        // Map the delivery onto the cycle so the release frame lands exactly on
        // the wrap (t = 0, when the pitch ball appears at the release point and
        // flies):
        //   * windup — from the post-contact window start up to the wrap, scaled
        //     so the delivery reaches its release frame at the wrap;
        //   * follow-through — continues past the wrap while the ball flies;
        //   * idle — the set stance, breathing, until the next windup.
        const contactT = placement.contactTime;
        const clipDuration = Math.max(0.001, pitcherTuning.clipDuration);
        const releaseTime = Math.min(
            Math.max(0.001, getTuning().playback.ballReleaseTime),
            clipDuration,
        );
        const crossfadeTime = Math.max(0, pitcherTuning.crossfadeTime);
        const windupStart = Math.max(contactT, loopDuration - releaseTime);
        const rate = releaseTime / Math.max(0.25, loopDuration - windupStart);
        const followEnd = Math.max(0, (clipDuration - releaseTime) / rate);

        let isPitch;
        let pitchTime;
        if (t >= windupStart) {
            isPitch = true;
            pitchTime = (t - windupStart) * rate;
        } else if (t <= followEnd) {
            isPitch = true;
            pitchTime = releaseTime + t * rate;
        } else {
            isPitch = false;
            pitchTime = clipDuration;
        }
        pitchTime = Math.min(pitchTime, clipDuration);

        // Crossfade the two poses whenever the phase flips (the reference's
        // 0.2 s fade between animation states). Both are the set stance where they
        // meet, so what the fade walks between is a shorter stance rather than a
        // different one.
        if (isPitch !== prevPhaseRef.current) {
            prevPhaseRef.current = isPitch;
            fadeRef.current = crossfadeTime;
        }
        if (fadeRef.current > 0) {
            fadeRef.current = Math.max(0, fadeRef.current - delta * getTimeScale());
        }
        const k = crossfadeTime > 0 && fadeRef.current > 0
            ? 1 - fadeRef.current / crossfadeTime
            : 1;
        const pitchShare = isPitch ? k : 1 - k;

        const ctx = { rig, hand: pitchHand, height: placement.release.y, releaseTime };
        const pitchPose = pitcherPose(pitchTime, ctx);
        const pose = pitchShare >= 1
            ? pitchPose
            : blendPose(pitcherIdle(state.clock.elapsedTime, ctx), pitchPose, pitchShare);

        driver.applyPose(pose);

        // What a probe reads this frame: the pitch's own release point in world
        // space, where the body was put for it, and where the delivery's own
        // release frame says the ball is — the three the release's accuracy is
        // the agreement of.
        model.userData.pitcher = {
            placement: { position: group.position.toArray(), yaw: placement.yaw },
            release: placement.release.toArray(),
            ball: pose.ball,
            clip: { pitching: isPitch, time: pitchTime, pitchShare },
        };
    });

    if (!pitchData || !placement) return null;

    return (
        <group ref={groupRef} name="pitcher">
            {/* The body: the reference project's skinned player model, driven by
                the delivery's joint targets through 2-bone IK. The half turn is
                what faces it at home plate — the rig frame (and so everything
                util/pitcherSequence.js authors) has the body facing -Z. Scale is
                the rig frame's own, which is the model's when no sprite nominal
                height was asked for. */}
            <group ref={setModelNode} rotation={[0, Math.PI, 0]} scale={rig.unitScale}>
                <primitive object={model} />
            </group>
        </group>
    );
};
