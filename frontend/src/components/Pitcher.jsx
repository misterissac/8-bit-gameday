import React, { useEffect, useMemo, useRef } from 'react';
import { useFrame, useLoader } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { TextureLoader } from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { getCycleDuration, getTimeScale } from '../constants/playback';

// ---------------------------------------------------------------------------
// Pitcher at the mound, ported from solomon-gumball's player.glb character +
// PlayerControls logic (src/components/Players.tsx) and the pitcher placement
// in LiveGameView.tsx:
//
//   * the real player.glb model (skinned, with the RightHandPitch /
//     LeftHandPitch / StandingNeutral clips) cloned via SkeletonUtils;
//   * the team uniform texture on the body/hands/cap, helmet hidden (defense);
//   * the glove on the non-throwing hand (setGloveHand);
//   * the body anchored at the ball's release point minus the hand-release
//     offset (PITCH_ANIMATION_DATA), facing home plate;
//   * the throw animation synced to the shared pitch/batted-ball cycle so the
//     release frame lands exactly when the ball starts flying (cycle t = 0).
// ---------------------------------------------------------------------------

// Pitch-clip timing (solomon-gumball's PITCH_ANIMATION_DATA + clip lengths):
// the ball leaves the hand BALL_RELEASE_TIME s into the 2.08 s RightHandPitch
// / LeftHandPitch clip, and StandingNeutral (the between-pitches idle) is
// 0.83 s. The windup is mapped onto the post-contact window of the shared
// cycle so the release lands exactly on the wrap (t = 0, when the pitch ball
// appears at the release point and flies).
export const BALL_RELEASE_TIME = 1.32; // s into the clip when the ball releases
const PITCH_CLIP_DURATION = 2.08; // RightHandPitch / LeftHandPitch length
const NEUTRAL_CLIP_DURATION = 0.83; // StandingNeutral length
const FADE_TIME = 0.2; // s — animation crossfade (the reference's fadeIn/Out)

// Hand-release offset in this app's world frame, converted from the
// reference's BALL_RIGHT/LEFT_HAND_RELEASE_POSITION ([-0.2205, -1.4052,
// 1.3730] / [0.2205, ...] — its X and Z axes are both negated here): the ball
// leaves the throwing hand HAND_OFFSET_Y above and HAND_OFFSET_Z toward the
// plate from the model root, offset HAND_OFFSET_X to the throwing-hand side.
// The body is anchored at the release point minus this offset, and the
// vertical clamp keeps the feet on the ground for low (sidearm) releases.
const HAND_OFFSET_X = 0.2205;
const HAND_OFFSET_Y = 1.4052;
const HAND_OFFSET_Z = 1.3730;

const PLAYER_MODEL_URL = '/models/player.glb';
const HOME_TEXTURE_URL = '/textures/HomePlayer_BaseColor.png';
const AWAY_TEXTURE_URL = '/textures/AwayPlayer_BaseColor.png';

// Warm the GLTF cache so the first pitch doesn't suspend for long.
useGLTF.preload(PLAYER_MODEL_URL);

export const Pitcher = ({ pitchData }) => {
    const gltf = useGLTF(PLAYER_MODEL_URL);
    // Deep clone (skeleton re-bound) so the shared useGLTF cache isn't mutated
    // by the per-pitch materials/visibility — the same SkeletonUtils.clone the
    // reference uses for every character.
    const model = useMemo(() => SkeletonUtils.clone(gltf.scene), [gltf]);
    const groupRef = useRef();
    const mixerRef = useRef();
    const pitchActionRef = useRef();
    const neutralActionRef = useRef();
    const clockRef = useRef(0);
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
        const body = get('JOINED');
        const cap = get('CAP');
        const helmet = get('Helmet');
        const handR = get('HandR');
        const handL = get('HandL');
        const gloveL = get('GloveL');
        if (!body || !handR || !handL || !gloveL) return;

        const bodyMaterial = new THREE.MeshStandardMaterial({ map: tex, roughness: 1 });
        body.material = bodyMaterial;
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

    // Animation mixer: the throw clip (RightHandPitch / LeftHandPitch) and the
    // between-pitches idle (StandingNeutral), both loop-once + clamped. Their
    // times are driven directly from the shared cycle clock each frame, and
    // the weights are crossfaded manually, so the motion stays in sync with
    // the pitch at any playback speed.
    useEffect(() => {
        const pitchClip = THREE.AnimationClip.findByName(
            gltf.animations, isRHP ? 'RightHandPitch' : 'LeftHandPitch',
        );
        const neutralClip = THREE.AnimationClip.findByName(gltf.animations, 'StandingNeutral');
        if (!pitchClip || !neutralClip) return;

        const mixer = new THREE.AnimationMixer(model);
        const pitchAction = mixer.clipAction(pitchClip);
        const neutralAction = mixer.clipAction(neutralClip);
        for (const action of [pitchAction, neutralAction]) {
            action.clampWhenFinished = true;
            action.setLoop(THREE.LoopOnce, 1);
            action.play();
        }
        pitchAction.setEffectiveWeight(0);
        neutralAction.setEffectiveWeight(1);
        mixerRef.current = mixer;
        pitchActionRef.current = pitchAction;
        neutralActionRef.current = neutralAction;
        return () => {
            mixerRef.current = null;
            mixer.stopAllAction();
        };
    }, [model, gltf, isRHP]);

    // Restart the playback clock whenever a new pitch arrives, keeping the
    // windup in phase with the Pitch component (which shares the same cycle).
    useEffect(() => {
        clockRef.current = 0;
    }, [pitchData]);

    // Body anchor: the ball's release point (the trajectory's first sample)
    // minus the hand-release offset, clamped so the feet stay on the ground.
    const placement = useMemo(() => {
        const traj = pitchData?.trajectory;
        if (!traj || traj.length === 0) return null;
        const release = new THREE.Vector3(traj[0].x, traj[0].z, -traj[0].y);
        return {
            position: new THREE.Vector3(
                release.x + (isRHP ? HAND_OFFSET_X : -HAND_OFFSET_X),
                Math.max(0, release.y - HAND_OFFSET_Y),
                release.z - HAND_OFFSET_Z,
            ),
            contactTime: traj[traj.length - 1].t,
        };
    }, [pitchData, isRHP]);

    useFrame((_, delta) => {
        const group = groupRef.current;
        const mixer = mixerRef.current;
        const pitchAction = pitchActionRef.current;
        const neutralAction = neutralActionRef.current;
        if (!group || !mixer || !pitchAction || !neutralAction || !placement) return;

        // Face home plate (the model's +Z faces the target, like the
        // reference's scene.lookAt(FIELD_LOCATION.BASE.HOME)).
        group.position.copy(placement.position);
        group.lookAt(0, 0, 0);

        // Shared cycle clock (same as Pitch/Batter/BattedBall).
        const loopDuration = getCycleDuration();
        clockRef.current = (clockRef.current + delta * getTimeScale()) % loopDuration;
        const t = clockRef.current;

        // Map the throw clip onto the cycle so the release frame (1.32 s)
        // lands exactly on the wrap (t = 0, when the pitch ball appears at the
        // release point and flies):
        //   * windup — from the post-contact window start up to the wrap,
        //     scaled so the clip reaches the release frame at the wrap;
        //   * follow-through — continues past the wrap while the ball flies;
        //   * idle — StandingNeutral until the next windup.
        const contactT = placement.contactTime;
        const windupStart = Math.max(contactT, loopDuration - BALL_RELEASE_TIME);
        const rate = BALL_RELEASE_TIME / Math.max(0.25, loopDuration - windupStart);
        const followEnd = (PITCH_CLIP_DURATION - BALL_RELEASE_TIME) / rate;

        let isPitch;
        let pitchTime;
        let neutralTime;
        if (t >= windupStart) {
            isPitch = true;
            pitchTime = (t - windupStart) * rate;
        } else if (t <= followEnd) {
            isPitch = true;
            pitchTime = BALL_RELEASE_TIME + t * rate;
        } else {
            isPitch = false;
            pitchTime = PITCH_CLIP_DURATION;
            neutralTime = Math.min(t - followEnd, NEUTRAL_CLIP_DURATION);
        }
        if (isPitch) {
            pitchTime = Math.min(pitchTime, PITCH_CLIP_DURATION);
            neutralTime = NEUTRAL_CLIP_DURATION;
        }

        // Crossfade the two actions whenever the phase flips (the reference's
        // 0.2 s fadeIn/fadeOut between animation states).
        if (isPitch !== prevPhaseRef.current) {
            prevPhaseRef.current = isPitch;
            fadeRef.current = FADE_TIME;
        }
        if (fadeRef.current > 0) {
            fadeRef.current = Math.max(0, fadeRef.current - delta * getTimeScale());
        }
        const k = fadeRef.current > 0 ? 1 - fadeRef.current / FADE_TIME : 1;
        pitchAction.setEffectiveWeight(isPitch ? k : 1 - k);
        neutralAction.setEffectiveWeight(isPitch ? 1 - k : k);
        pitchAction.time = pitchTime;
        neutralAction.time = neutralTime;
        // update(0) evaluates every active action at its current time and
        // applies the poses to the skeleton without advancing the clock.
        mixer.update(0);
    });

    if (!pitchData || !placement) return null;

    return (
        <group ref={groupRef}>
            <primitive object={model} />
        </group>
    );
};