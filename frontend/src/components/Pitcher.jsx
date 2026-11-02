import React, { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, useLoader } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { TextureLoader } from 'three';
import { getCycleDuration, getPitcherFielding, getPlayClock, getTimeScale, setCastHandPosition, stepSimulation } from '../constants/playback';
import { getTuning, useTuning } from '../constants/tuning';
import { buildPlayerBody, useBodyRig } from '../util/playerBody';
import { blendSnapshot, bindClips, poseSnapshot, setActorState } from '../util/playerClips';
import { PITCHER_ACTOR, ballCarrierAt, facingYaw, isCastSpot, pitcherFrameAt } from '../util/playCast';
import { AUTHORED_LANDING_TIME, AUTHORED_RELEASE_TIME, blendPose, pitcherFinish, pitcherIdle, pitcherPlacement, pitcherPose, pitcherProfile } from '../util/pitcherSequence';
import { PALM_HANDLES } from '../util/playerRig';
import { HELMET_MESH, blueKit, defenseKitForInning, playerFadeOpacity, writeBodyFade } from '../util/playerKit';
import { MOUND, moundSurfaceY } from '../constants/mound';
import { clamp } from '../util/MathUtil';

// The world's own up: the axis a rig place is turned about to be read in the world,
// where the group's yaw is what stands between the two frames (see the placement's
// own read of the mound under the finish).
const UP = new THREE.Vector3(0, 1, 0);

// Scratch for the hand read while the pitcher is holding the ball during a play (a
// frame loop allocating a Vector3 per frame is a frame loop the GC gets to run
// during a play — the same scratch FieldCast keeps for its own bodies).
const FIELD_HAND = new THREE.Vector3();

// How long the pitcher's body takes to come out of the delivery and into a play, in
// play seconds: the window he is eased out of the pose the pitch left him in (the
// follow-through, or the set stance if the ball went before he finished) and the
// window the schedule's own legs are eased in over, as one motion. Short enough to
// read as going on the ball — a body that has to stand up out of a follow-through
// and turn to run does it in a stride or two — and the batter-runner's own takeoff
// to the tenth (util/batterRunner.js), because it is the same problem twice: a body
// authored by one component, handed to the asset's clips by another.
const PITCHER_FIELDING_TAKEOFF_SECONDS = 0.45;

// The half turn between this body's own frame and the frame a look target is
// aimed in. A body of the *cast* is drawn in the asset's own frame, which faces
// +Z — that is the front `facingYaw` aims at a target, and it is why they carry no
// turn of their own. This body is not: the rig frame (and so every pose the
// delivery is authored from — see util/pitcherSequence.js) faces **-Z**, so the
// model is mounted turned half round inside this group, and the group's own yaw
// counts from there. The delivery's own yaw is the same aim with that turn already
// in it — `atan2(x, z)`, the yaw that points a -Z front at the plate (see
// `pitcherPlacement`) — so a look target has to have the half turn put back on
// before it is written on this group, or the body stands facing exactly away from
// what the play is looking at. It is the batter-runner's own problem and its own
// answer (util/batterRunner.js's `BATTER_FRAME_TURN`).
const PITCHER_FRAME_TURN = Math.PI;

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


export const Pitcher = ({ pitchData, replayKey = 0, overlay = false }) => {
    const tuning = useTuning();
    const pitcherTuning = tuning.pitcher;
    const gltf = useGLTF(PLAYER_MODEL_URL);
    // Deep clone (skeleton re-bound) so the shared useGLTF cache isn't mutated
    // by the per-pitch materials/visibility — the same SkeletonUtils.clone the
    // reference uses for every character, and the same body the batter wears (see
    // util/playerBody.js, which is where both actors' plumbing lives).
    const body = useMemo(
        () =>
            buildPlayerBody(gltf.scene, {
                // No sprite nominal height: the pitcher's rig frame is the model's own —
                // the body already stands at world size on the mound, so one rig unit is
                // one metre, and the frame every target in the delivery is authored in.
                // ...and the pitcher's own kit, put right the way the batter's is (see
                // util/batterLook.js): one body, one face, one uniform, so the pitcher
                // wears the batter's own corrected face — brows, and eyes brought down
                // and out onto it — and the same jersey front and shoes the batter does.
                // What differs is the hat, and it is handed over as such: the pitcher
                // throws in the *cap* (the helmet is hidden with the uniform below), so
                // the eyes are read under the cap's own brim, 0.012 rig lower than the
                // helmet's, and the helmet's ear-flap work is left undone rather than
                // done on a mesh nobody sees. Run in the look pass rather than in a
                // material pass, because this is a *geometry* pass: the body it edits is
                // this instance's own — the model is the pitcher's own clone — and the
                // pass works on its own copy of each mesh's geometry on top of that.
                look: { headgear: 'cap' },
            }),
        [gltf],
    );
    const model = body.model;
    // The bone driver, built once the model is really in the scene — it reads the live
    // bones and the frame the model sits in, and `useBodyRig` waits on the mounted node
    // for that (a node held in state rather than a ref, for the reason it records:
    // player.glb can finish loading before the component's first commit that mounts the
    // body, and a ref read once would be empty). Two things below are the pitcher's own:
    // the model sits at the group's origin, with no placement offset, because the
    // delivery's targets are authored from the model's own root — so the rig frame and
    // the group's frame are the same frame — and it is handed the mound it stands on: a
    // foot the pose plants stands on the surface under its own place rather than on a
    // plane, so the pivot shoe stands on the rubber's own top at the set and the stride's
    // foot lands down the mound's slant (see constants/mound.js, and the driver's leg
    // solve).
    //
    // It also hands back the waist joint the driver turns the ribcage about, in the
    // metrics' own frame: measured when the body is shaped, so the profile, the placement
    // and every frame of the delivery are all solved against the same joint.
    const { driverRef: rigDriverRef, setModelNode, waistJoint } = useBodyRig(body, { groundAt: moundSurfaceY });
    // The rig every number below is authored in — and the one the driver's own waist
    // joint is added to once the body has been *shaped*: the joint is the cut's own
    // centre, measured in createPlayerRig, and the pose has to carry it because the rig
    // turns the ribcage about it rather than about the pelvis' pivot (see the driver's
    // ``waistJoint`` and ``releaseShoulder``). Until then the metrics stand alone, which
    // is the rig the unit suite's own pose solves are handed.
    const rig = useMemo(
        () => (waistJoint ? { ...body.metrics, waistJoint } : body.metrics),
        [body.metrics, waistJoint],
    );
    const groupRef = useRef();
    const prevPhaseRef = useRef(null);
    const fadeRef = useRef(0);
    // The mound's own step under the finish, solved off the ground rule and kept
    // against the placement it was solved for (see the frame loop).
    const settleRef = useRef(null);

    // Every material this body is drawn with, gathered by the kit pass below (the
    // uniform it writes, and the glove's own leather) — what the play's own fade
    // writes to, the way the cast writes its bodies'.
    const bodyMaterialsRef = useRef([]);

    const pitchHand = pitchData?.pitch_hand || 'R';
    const isRHP = pitchHand === 'R';
    // The pitcher is the fielding team, and which club that is for this half inning
    // is the question every body on the field asks (util/playerKit.js): the same
    // answer the catcher and the fielders take, so the mound cannot be in one club's
    // colours while the man behind the plate is in the other's.
    const teamType = defenseKitForInning(pitchData);
    // The visitors' kit is the same atlas with its team colour turned blue (see
    // util/playerKit.js's `blueKit`), so the two clubs on the field are a red side
    // and a blue one rather than two dark reds — the mound included.
    const kitTexture = useLoader(TextureLoader, teamType === 'away' ? AWAY_TEXTURE_URL : HOME_TEXTURE_URL);
    const teamTexture = teamType === 'away' ? blueKit(kitTexture) : kitTexture;

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
        const gloveR = get('GloveR');
        if (!bodyMesh || !handR || !handL || !gloveL) return;

        const bodyMaterial = new THREE.MeshStandardMaterial({
            map: tex,
            roughness: 1,
            vertexColors: true,
            side: THREE.DoubleSide,
            shadowSide: THREE.DoubleSide,
        });
        bodyMesh.material = bodyMaterial;
        cap.material = bodyMaterial;
        handR.material = bodyMaterial;
        handL.material = bodyMaterial;
        if (helmet) helmet.visible = false;
        // Each glove keeps its own original leather texture (the reference's mit
        // material), re-created so the cache's material stays pristine — both of them,
        // because the one this pitch does not wear is still *in* the body, and a fade
        // written to the cache's shared leather would reach every other clone of it.
        const leather = (mesh) => new THREE.MeshStandardMaterial({
            map: mesh.material?.map ?? null,
            roughness: 1,
            side: THREE.DoubleSide,
            shadowSide: THREE.DoubleSide,
        });
        gloveL.material = leather(gloveL);
        if (gloveR) gloveR.material = leather(gloveR);
        // ...and everything the play's own fade is written to: every mesh this body is
        // drawn with, whichever pass put it there — the kit above, the gloves, and the
        // look pass's own details (the chest's opening and the rest are meshes of their
        // own, hung beside the body with materials of their own, so a fade that only
        // knew about the kit would leave a floating jersey with no man in it). The
        // helmet is the one exception: its shell is the *asset's* material, shared with
        // every other clone, and it is hidden on this body anyway.
        const worn = new Set([bodyMaterial, gloveL.material, gloveR?.material].filter(Boolean));
        model.traverse((child) => {
            if (!child.isMesh || child.name === HELMET_MESH) return;
            for (const mat of Array.isArray(child.material) ? child.material : [child.material]) {
                if (mat) worn.add(mat);
            }
        });
        bodyMaterialsRef.current = [...worn];

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

    // The same body, a second way of moving it. A play that gives the pitcher
    // something to field — a comebacker hit back up the middle (the feed's own hit
    // location sends those to him), a putout he is credited with at the bag, a throw
    // he makes or takes in the assist chain — hands his body to the asset's own clips
    // (the sprint, the catch, the throw) and to the plan's own schedule
    // (util/playCast.js's `pitcherFrameAt`, published by BattedBall), the same way the
    // cast's bodies are played. Nothing is playing while he is pitching: the mixer
    // only ever runs for the play (see the frame loop), so no pose the delivery
    // authors is touched by it.
    const fieldingKit = useMemo(() => {
        if (!model || !gltf?.animations?.length) return null;
        const mixer = new THREE.AnimationMixer(model);
        return { mixer, actions: bindClips(mixer, gltf.animations), state: null };
    }, [model, gltf]);

    // The bone the ball rides while the pitcher holds it during a play: the *throwing*
    // hand's palm socket — the same socket the model's bat rig puts the handle in, and
    // the one the reference sockets the thrown ball into — on whichever arm this pitch
    // throws with. A bone rather than the `HandR` mesh, for the reason FieldCast
    // records: a skinned mesh's own node never moves.
    const throwingHand = useMemo(() => {
        if (!model) return null;
        const names = [PALM_HANDLES[pitchHand], `palm_handle.${pitchHand}`, `hand${pitchHand}`, `hand.${pitchHand}`];
        for (const name of names) {
            const node = model.getObjectByName(name);
            if (node) return node;
        }
        return null;
    }, [model, pitchHand]);

    // The handoff, held across frames: the frame the play took his body over, the
    // pose it was standing in, and where the schedule had it — so no frame of the
    // change is a cut (see the frame loop).
    const fieldingRef = useRef({ active: false, enteredAt: 0, snapshot: null, origin: null, scheduleAtEntry: null, fade: 1, probe: null });

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

    // Reset the crossfade whenever a new pitch arrives or replay fires, keeping
    // the windup in phase with the simulation clock.
    useLayoutEffect(() => {
        prevPhaseRef.current = null;
        fadeRef.current = 0;
    }, [pitchData, replayKey]);

    // The pitcher this pitch is thrown by, per pitch: his proportions clamped to the
    // ranges a real staff spans, his own listed height standing the body at its own
    // stature — the same gameData lookup the batter's height comes from, and *not* a
    // size solved from the pitch — and the stance the delivery is thrown from: the
    // drive foot on the rubber, both feet on the ground (see pitcherProfile and its own
    // notes above). Every release point the feed hands over is a new reading, so a
    // pitching change is a new body rather than the same one throwing from somewhere
    // else.
    const releasePoint = useMemo(() => {
        const traj = pitchData?.trajectory;
        if (!traj || traj.length === 0) return null;
        // The world point the pitch is drawn from, in the app's own mapping (x -> x,
        // height -> y, distance -> -z), which is the frame the profile and the
        // placement both work in.
        return [traj[0].x, traj[0].z, -traj[0].y];
    }, [pitchData]);

    // The pitcher's own height, in metres, out of the feed's own inches (the same
    // conversion Batter.jsx makes for the batter's listed height); null where the feed
    // has none, which leaves the model's own stature standing in.
    const pitcherHeightM = pitchData?.pitcher_height != null
        ? pitchData.pitcher_height * 0.0254
        : null;

    // The body, the stance and the mound under them for this pitch: one solve,
    // because the three are one answer. The profile is where the stance comes from
    // (the drive foot on the rubber, the release reached by the delivery's own
    // travel), the placement is where the body stands for it, and the ground under
    // the stance — the surface the profile's own slot is measured from and the
    // placement's height is — is the mound's, read at the place the stance really
    // came out on. So the pass that has no ground to start from is taken at the mound's
    // own rubber line (the surface under the mound's centre) and the second at the
    // surface under the drive foot the first one stood: for a stance off the plate's
    // own leather the two differ by the mound's slope, and the second pass is the one
    // the pitch keeps.
    const stance = useMemo(() => {
        if (!releasePoint) return null;
        // The mound's own line: the rubber's centre, which is the mound's and the
        // plate's (see constants/mound.js), and the line the pitch's own lateral is
        // read against. A pitch's release x carries a body's own width away from the
        // plate's line whatever the stance does, so it is handed to the *arm* (see
        // ``side`` in util/pitcherSequence.js) and the stance's line is held on the
        // rubber (see `pitcherPlacement`) rather than the whole body being slid across
        // the mound to meet the ball.
        const solve = (ground) => {
            const profile = pitcherProfile({
                rig,
                hand: pitchHand,
                height: releasePoint[1],
                release: releasePoint,
                pitcherHeight: pitcherHeightM,
                ground,
                side: releasePoint[0] - MOUND.centre[0],
            });
            return {
                profile,
                placement: pitcherPlacement({
                    profile, release: releasePoint, line: MOUND.centre[0],
                }),
            };
        };
        const first = solve(moundSurfaceY(MOUND.centre[0], MOUND.centre[1]));
        // ...read under the bit of *shoe* that stands on it rather than under the ankle
        // inside the leather: the two are a shoe's own lead apart, and it is the shoe
        // the ground is under (see SHOE_LEAD in util/pitcherSequence.js).
        const foot = first.placement.shoe;
        return solve(moundSurfaceY(foot[0], foot[2]));
    }, [releasePoint, rig, pitchHand, pitcherHeightM]);

    // Where the body stands, and which way it faces, for this pitch.
    //
    // The body is placed from its *stance* rather than from the release: the set's
    // drive foot stands on the rubber (or as much of the shoe as the pitch's own
    // extension leaves on it, see the profile's ``contact``), the group's height is
    // the ground's — a pitcher in the set is a pitcher standing on the mound, his own
    // soles on its surface — and the release point is what the delivery's own travel
    // reaches, at the size his own height stands him at (see `pitcherPlacement`). The
    // yaw is the way the body faces home plate from where that leaves it, and it is
    // solved with the place because each is measured from the other: four passes,
    // which converge to well under a millimetre.
    const placement = useMemo(() => {
        if (!stance || !releasePoint) return null;
        const { profile: solvedProfile, placement: solved } = stance;
        // The mound's own step under the finish: the surface the delivery's last feet
        // stand on — a metre and a half out in front of the rubber by then, down the
        // mound's own front slope — read in the world and handed to the pose in the
        // rig's own units, so the body steps down the slope as it drives rather than
        // dropping at the frame the shoes touch the dirt (see ``settle`` in
        // util/pitcherSequence.js). The deepest of the two feet is the one the body has
        // to be low enough for; the other's shoe is stood on the surface by the
        // driver's ground rule.
        const finish = pitcherFinish({ rig: solvedProfile.rig, hand: solvedProfile.hand });
        const surfaceAt = (place) => {
            const world = new THREE.Vector3(...place)
                .multiplyScalar(solved.scale)
                .applyAxisAngle(UP, solved.yaw)
                .add(new THREE.Vector3(...solved.position));
            return moundSurfaceY(world.x, world.z);
        };
        const settle = (
            Math.min(surfaceAt(finish.drive), surfaceAt(finish.stride)) - solvedProfile.ground
        ) / solved.scale;
        return {
            position: new THREE.Vector3(...solved.position),
            yaw: solved.yaw,
            scale: solved.scale,
            foot: solved.foot,
            slide: solved.slide,
            release: new THREE.Vector3(...releasePoint),
            profile: solvedProfile,
            // The stance's own line in the world, and the metres the ball came off the
            // pitch's own lateral by for it: the pitch's own lateral is the arm's to
            // reach (see the profile's ``side``), and this is where the shoe's own
            // leather put the limit of it (see `pitcherPlacement`).
            line: solved.line,
            side: solved.side,
            settle,
            contactTime: pitchData.trajectory[pitchData.trajectory.length - 1].t,
        };
    }, [stance, releasePoint, pitchData]);

    useFrame((state, delta) => {
        const { time: t } = stepSimulation(delta, state.clock.elapsedTime);

        const group = groupRef.current;
        const driver = rigDriverRef.current;
        if (!group || !placement) return;

        // ── The pitcher's own half of a play ────────────────────────────────
        // A play that gives the pitcher something to field (see `pitcherIsInvolved`
        // in util/playCast.js) hands his body to the same choreography the cast's
        // bodies walk: the plan's own schedule, evaluated for the pitcher's spot by
        // `pitcherFrameAt` and published by BattedBall, played off the play's own
        // clock — the sprint, the catch and the throw, on the asset's own clips.
        //
        // What that means here is that the delivery stops being authored: the
        // procedural pose below never runs while the play has him, the mixer drives
        // the bones instead, and the group is placed on the schedule's metres rather
        // than on the mound.
        //
        // The change is not a cut, on either axis. The frame the play takes him over,
        // the pose he is standing in is snapshotted, and the schedule's own first legs
        // are eased in over the takeoff below (`blendSnapshot`) — and he leaves from
        // *where he stood* rather than from the spot the schedule starts him at, by
        // carrying the offset between the two and walking it off over the same window
        // (the placement slides a few tenths of a metre around the rubber from pitch
        // to pitch, so the two are not the same place). Both are the batter-runner's
        // own handoff, twice — see util/batterRunner.js.
        const playClock = getPlayClock();
        const fieldingPlan = getPitcherFielding();
        const fieldFrame = fieldingPlan && playClock != null
            ? pitcherFrameAt(fieldingPlan, playClock)
            : null;
        const fielding = fieldingRef.current;
        if (fieldFrame) {
            if (!fielding.active) {
                fielding.active = true;
                fielding.enteredAt = playClock;
                fielding.snapshot = poseSnapshot(model);
                fielding.origin = group.position.clone();
                fielding.scheduleAtEntry = fieldFrame.position.clone();
            }
            const takeoff = clamp((playClock - fielding.enteredAt) / PITCHER_FIELDING_TAKEOFF_SECONDS, 0, 1);
            const offset = fielding.origin.clone().sub(fielding.scheduleAtEntry).multiplyScalar(1 - takeoff);
            const spot = fieldFrame.position.clone().add(offset);
            // His feet on the ground he is really on: the mound's own surface (its
            // plateau, its slant and the field beyond it) where he stands on it, the
            // field's own surface off it — the same read the delivery's feet are
            // solved against (constants/mound.js).
            group.position.set(spot.x, moundSurfaceY(spot.x, spot.z), spot.z);
            // ...and turned toward what the schedule has him looking at: the same
            // look target every cast body is turned by (see playCast's `facingYaw`),
            // with his own frame's half turn back on it — one aim, two frames (see
            // PITCHER_FRAME_TURN). A body nothing is asked of keeps the yaw it had.
            const aim = facingYaw(spot, fieldFrame.lookTarget);
            group.rotation.set(0, aim == null ? group.rotation.y : aim + PITCHER_FRAME_TURN, 0);
            group.scale.setScalar(placement.scale);
            if (fieldingKit) {
                setActorState(fieldingKit, fieldFrame.state);
                fieldingKit.mixer.update(delta * getTimeScale());
                blendSnapshot(fielding.snapshot, takeoff);
            }
            // ...and how much of him is drawn, off the same distance rule every cast
            // body is drawn at (util/playerKit.js's playerFadeOpacity), because he is
            // one of the bodies a *play* moves now: the fielder camera's position is a
            // fielder's own head, so when the man it is following is him — a comebacker
            // is his to field — the body it is standing inside is the one that goes,
            // exactly as it does for a cast fielder. Only while the play has him: the
            // delivery's own frames are drawn whole (his harness and the visual
            // baselines are read from inside his own frame).
            const fade = playerFadeOpacity(
                group.position.distanceTo(state.camera.position),
                tuning.camera.playerFadeNear,
                tuning.camera.playerFadeFar,
            );
            if (fielding.fade == null || Math.abs(fade - fielding.fade) > 0.01) {
                fielding.fade = fade;
                writeBodyFade(bodyMaterialsRef.current, fade);
            }
            // The ball in his hand, published for the ball's own renderer to ride from
            // the moment he gloves it until the throw leaves it — the cast's own
            // publication, for the one carrier the cast does not draw. The two never
            // both write a frame: the carrier decides whose answer it is, and a ball
            // charged to a spot neither component draws (the catcher) is the empty
            // one.
            const carrier = ballCarrierAt(fieldingPlan, playClock);
            if (carrier === PITCHER_ACTOR && throwingHand) {
                // The mixer has just posed this frame's bones and the group has just
                // been moved, so the hand's world matrix is still last frame's — three
                // only refreshes matrices at render (the same walk FieldCast does for
                // its carrier).
                group.updateMatrixWorld(true);
                throwingHand.getWorldPosition(FIELD_HAND);
                setCastHandPosition({ x: FIELD_HAND.x, y: FIELD_HAND.y, z: FIELD_HAND.z });
            } else if (!isCastSpot(carrier)) {
                setCastHandPosition(null);
            }
            // What a probe reads while the play has him — where the schedule has him,
            // what he is playing and whether the ball is in his hand — beside the
            // delivery's own readout below (see e2e/harness/pitcherMain.jsx).
            const probe = fielding.probe ?? (fielding.probe = {});
            probe.clock = playClock;
            probe.x = spot.x;
            probe.y = group.position.y;
            probe.z = spot.z;
            probe.state = fieldFrame.state;
            probe.hasBall = carrier === PITCHER_ACTOR;
            // ...and the two halves of his own facing: what the play has him looking
            // at, and the yaw it stood him up by. A probe reads the turn back off the
            // body that made it (see e2e/pitcher.visual.spec.js's fielding test).
            probe.look = { x: fieldFrame.lookTarget.x, y: fieldFrame.lookTarget.y, z: fieldFrame.lookTarget.z };
            model.userData.pitcher = { ...(model.userData.pitcher ?? {}), field: probe };
            return;
        }
        if (fielding.active) {
            // The play is over (or was given up): the body goes back to the mound and
            // to the delivery on this same frame — the instant the cast puts every
            // body back on its own spot, and the same way the batter's own body goes
            // back in the box (Batter.jsx's leaveBox). The clips are given up with it:
            // nothing of the mixer runs while he is pitching, and the next play's first
            // state fades in from nothing rather than being swallowed as "already
            // playing" (see setActorState).
            fielding.active = false;
            fielding.snapshot = null;
            // ...and the body goes back to being drawn whole with it (the fade above is
            // only ever written while the play has him).
            if (fielding.fade !== 1) {
                fielding.fade = 1;
                writeBodyFade(bodyMaterialsRef.current, 1);
            }
            if (fieldingKit) {
                fieldingKit.mixer.stopAllAction();
                fieldingKit.state = null;
            }
        }

        // The body stands where this pitch's own stance puts it — drive foot on the
        // rubber, soles on the ground — at the size the *pitcher's* own height asks for,
        // facing home plate.
        group.position.copy(placement.position);
        group.rotation.set(0, placement.yaw, 0);
        group.scale.setScalar(placement.scale);
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

        // The pose is handed the *fitted* body and the release height in its own
        // units: the group's scale is the world's, so a rig unit is a rig unit of the
        // model's own frame — the pitch's height comes back out at world size when the
        // ball is drawn (see the profile's own notes).
        const ctx = {
            rig: placement.profile.rig,
            hand: pitchHand,
            height: placement.profile.rigHeight,
            releaseTime,
            stride: placement.profile.stride,
            // ...and where the pitch's own release stands across the body (see
            // ``side`` above): the same ask the profile solved its stride against, so
            // the delivery's own anchor is the one the placement was read off.
            side: placement.profile.side,
            // ...and the mound's own step under the finish (see the placement above):
            // the body walks down its front slope rather than dropping onto it. Its
            // *depth* is the ground rule's own answer rather than the surface's: a
            // shoe laid on the slope rides its own leather, so its ankle stands a
            // centimetre or two higher than the surface's own fall would put it, and
            // only the driver — the thing that knows the shoe — can say how far the
            // body really has to come down for the deepest of the finish's feet to
            // reach the dirt. So the placement's surface reading is what a pitch falls
            // back on, and the rule's own is what it walks down; solved once per
            // placement, on the finish's own frame, so a new pitch is a new body and
            // a new slope under it (a pitch's placement is a new object every time).
            settle: placement.settle,
        };
        if (settleRef.current?.placement !== placement) {
            // The finish's frame, read off the pose the delivery really writes there:
            // the keys are the authored clock's, so it is the *authored* release this
            // pose is posed against rather than the tuning's own.
            const landing = pitcherPose(AUTHORED_LANDING_TIME, {
                ...ctx,
                releaseTime: AUTHORED_RELEASE_TIME,
                settle: 0,
            });
            driver.applyPose(landing);
            // What the rule settled the body by: its own answer for the deepest of the
            // finish's feet, which is the pose's own hip less the one it was handed.
            const depth = driver.debug.pose.hip.offsetY - landing.hip.offsetY;
            settleRef.current = { placement, settle: depth < 0 ? depth : placement.settle };
        }
        ctx.settle = settleRef.current.settle;
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
            placement: {
                position: group.position.toArray(),
                yaw: placement.yaw,
                scale: placement.scale,
                foot: placement.foot,
                slide: placement.slide,
                // The stance's own line in the world and how far the drive shoe came
                // out of it (the same reading as ``slide`` across the mound rather
                // than along it), then the metres the ball came off the pitch's own
                // lateral by for the shoe's sake (see the placement's own notes).
                line: placement.line,
                side: placement.side,
            },
            // The pitch's own point in world space, and where the delivery's own
            // release frame says the ball is — the two the release's accuracy is the
            // agreement of.
            release: placement.release.toArray(),
            // ...and the body the pitch is thrown by: his own listed stature and the
            // rig's own (the two the scale between them is read off), the arm's own
            // angle at the release, and where along the rubber the stance stands (see
            // pitcherProfile).
            profile: {
                stature: placement.profile.stature,
                rigStature: placement.profile.rigStature,
                scale: placement.profile.scale,
                rigHeight: placement.profile.rigHeight,
                armAngle: placement.profile.armAngle,
                stride: placement.profile.stride,
                contact: placement.profile.contact,
                shortfall: placement.profile.shortfall,
                heightShortfall: placement.profile.heightShortfall,
                // ...and what the arm's own lateral reach could not hold of the pitch's
                // release x, in world metres on the rig's own x (see pitcherProfile;
                // the placement's ``side`` is the same reading after the yaw).
                side: placement.profile.side,
                sideShortfall: placement.profile.sideShortfall,
                ceiling: placement.profile.ceiling,
                travel: placement.profile.travel,
                needed: placement.profile.needed,
                // The mound's own top under the stance: the surface the group stands
                // on, and so the height the release's own slot is measured from.
                ground: placement.profile.ground,
            },
            // ...and the ball the body it was solved *holds*, which is the pose's own
            // place less the ground's own give: the driver settles a frame onto its
            // planted feet by the shortfall of the deepest of them (see `give` in
            // playerRig's applyPose), and the ball comes down with the hand that is
            // holding it. It is the same rule the placement's own `settle` is solved
            // into the pose for, read now on the frame itself rather than on the finish
            // alone: a pose whose feet all reach the dirt pays nothing for it, and the
            // delivery's own tail is where it is worth reading — measured 9 mm at
            // 1.42 s on the centred pitch and 30 mm at 1.8 s, which is the gap between
            // the place the pose wrote and the hand the pitcher is really holding it in.
            ball: [pose.ball[0], pose.ball[1] - (driver.debug.give ?? 0), pose.ball[2]],
            give: driver.debug.give ?? 0,
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
            <group ref={setModelNode} rotation={[0, PITCHER_FRAME_TURN, 0]} scale={rig.unitScale}>
                <primitive object={model} />
            </group>
        </group>
    );
};
