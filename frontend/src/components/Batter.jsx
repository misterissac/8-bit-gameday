import React, { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { getCycleDuration, getTimeScale, getBattedBallPosition, getBallReleaseTime, stepSimulation } from '../constants/playback'
import { FIELD } from '../constants/field'
import { PLATE_FRONT_Y, clamp, plateCrossing } from '../util/MathUtil'
import { BATTER_LEAN_ORDER, batterLean } from '../util/batterLean'
import {
  resolvePitchSpeedMph,
  resolveSwingPeak,
  calculateSwingGeometry,
  computeBatTiltAtProgress,
  HIP_Y,
} from '../util/batterSwing'
import { HIDDEN_MESHES, createPlayerRig, measurePlayerRig } from '../util/playerRig'
import { useTuning } from '../constants/tuning'

// The batter's body is the skinned player model from the solomon-gumball
// reference; its bones are driven by the joint targets this component's
// animation tuning produces (see util/playerRig.js). Only the bat stays a
// separate mesh, placed by the data-driven contact geometry.
const PLAYER_URL = '/models/player.glb'
const BAT_URL = '/models/parts/bat.glb'
useGLTF.preload(PLAYER_URL)
useGLTF.preload(BAT_URL)

// ---------------------------------------------------------------------------
// Batter sprite at home plate. The batter's side of the plate comes from the
// live feed's ``matchup.batSide`` (L/R), and the swing is driven by the pitch
// event's call code (``pitchData.swing``) timed to the moment the ball reaches
// the plate.
//
// The set stance mirrors a real batting stance: the hands load at the back
// shoulder (the left shoulder for a lefty, the right for a righty — the batter
// faces the pitcher, so left = -X and right = +X) with the bat cocked up over
// the shoulder, the knees are bent (each leg is a thigh + shin), and the arms
// are two segments. During the swing the upper body opens toward the pitcher,
// the hands arc forward *around* the body to the contact point (so the bat
// never passes through the torso) while the bat drops from the cocked position
// into the zone, and the sweet spot (not the handle) meets the ball.
// ---------------------------------------------------------------------------

// Camera-direction + distance translucency, mirroring the catcher's fade
// (solomon-gumball's clamp((distance - 3) / 8, 0, 1) ramp). Unlike the
// catcher, the batter only fades when the camera is BEHIND it and close — e.g.
// the "Snap to Strike Zone" view, where the batter sits between the camera and
// the plate and would block the zone. From the front (pitcher side) the batter
// never fades, so the at-bat stays visible. The fade never goes fully
// transparent: at minimum the batter stays translucent (settings.fadeMinOpacity) so
// it reads as a ghost outline instead of disappearing.

// Swing timing: the bat starts settings.swingLead seconds before the ball crosses the
// plate, reaches the contact angle exactly when the ball arrives, follows
// through for settings.followThrough seconds after, then eases back to the loaded
// stance over settings.recoveryTime while the batted ball is in flight. Before the
// swing, the batter loads the weight onto the back leg over settings.loadTime seconds
// (ending exactly where the swing begins), so the swing fires out of a loaded
// crouch instead of from a static stance.

// Bat rotation (radians around the vertical axis). At 0 the barrel points at
// the pitcher; at +/-PI it points back at the catcher. The handedness sign
// mirrors lefties vs righties: the base angles are negated for a lefty.

// The bat is cocked up over the back shoulder in the set stance, and drops to
// level by the time it reaches the contact point (radians of X tilt).

// How much the upper body (torso, shoulders, arms, bat) opens toward the
// pitcher through the swing, like the reference's SwingMid animation. Sized so
// the chest opens most of the way toward the pitcher by contact — the whole
// swing, not just the head, opens toward the ball (the follow-through then
// completes the turn to settings.fullOpenYaw). The sign mirrors handedness so the
// body turns with the swing (see bodyOpen below).

// After contact the body keeps opening through the follow-through into the
// pull side to match the elbows (settings.fullOpenYaw),
// then unwinds back to the set stance during the recovery.

// The set stance faces a point on the home-plate -> catcher segment biased
// toward home plate, so the body angles in toward the pitch (a slightly open
// stance) instead of facing the catcher side. The direction is computed
// per-stance in the component: the body yaw that points the chest (local -Z)
// at that target from the batter's world position (batX, stanceZ).
//
// settings.setFaceBias is how far the target sits along the plate -> catcher
// segment *as a direction*: 0.5 faces the old plate->catcher midpoint, and lower
// values turn the body and legs toward home plate (0 faces the plate's centre
// directly). Directions rather than a fixed world point, so the turn the stance
// is squared at does not move when the stance does (see the set yaw below).

// The lower body (hips/legs) rotates with the swing, opening nearly as far as
// the shoulders so the legs visibly turn with the body (a real swing keeps the
// hips just short of the shoulders' rotation — the separation that reads as
// the hips driving the turn).

// The hips fire well ahead of the shoulders (the kinetic chain of a real
// swing): the lower body's opening progress is phase-advanced by this factor,
// so the legs start turning and the back leg starts driving while the upper
// body is still barely moving — the hips are most of the way open before the
// torso is halfway — reading unmistakably as the legs driving the swing. The
// same factor phase-advances the follow-through: after contact the hips keep
// rotating and finish their continued turn while the torso is still unwinding
// into the fully-open pose, so the legs drive through contact too. The clamp
// makes the hips reach their full (lesser) open angle early, hold it, and
// settle back after the shoulders on recovery.
// The upper body's turn leads the hands/bat by this factor during the pre-
// contact window, so the chest opens before the barrel arrives — part of the
// same kinetic chain as settings.hipsLead (legs -> torso -> hands).

// Head tilt range while tracking the batted ball (radians): how far the head
// can nod down toward a grounder or tilt up toward a fly ball. The contact
// look uses the smaller settings.headTiltMax; the live ball can be far above the
// batter (pop-ups) so the up range is wider.

// Leg drive: as the swing fires the BACK leg — the side away from the
// pitcher (the right leg for a righty) — unbends and drives the entire
// swing: it straightens from the crouch and pushes toward the plate as the
// hips turn, while the front leg stays bent to brace the rotation. Before
// the swing, a brief load phase shifts the weight onto the back leg — the
// hips settle lower (settings.hipSettle) and the back knee crouches deeper —
// while the front leg strides toward the pitcher and plants through the
// swing. The upper body mirrors the weight transfer: it stands straight
// in the set stance, leans forward toward home plate as the pitch arrives
// (settings.setLean), settles back onto the back leg during the load
// (settings.loadLeanBack), then holds a stronger forward lean toward the plate
// through the entire swing (settings.legLean) as the back leg drives. During the
// recovery the back leg eases back to the crouch later than the front leg
// (settings.backRecoverLag).
// Footwork through the swing: the swing pivots around the BACK foot, which
// stays planted in world space (counter-rotated against the hips' opening and
// compensating for hip drive) while pivoting toward the pitcher
// (settings.backFootPivot); the front foot unplants as the drive fires —
// lifting and turning with the body (its pre-swing plant keeps only a small
// settings.frontFootPivot).
// Hip drive: as the back leg unbuckles, the hips (lower body) drive forward
// toward the pitcher (settings.hipDriveForward) and the torso, head, arms, and
// bat ride forward with them (settings.upperDriveForward), so the entire body
// moves into the baseball through the swing. A small residual tilt back
// toward the catcher (settings.swingBackTilt) keeps a hint of the "staying
// back" posture without dragging the head backward.
// The whole-body forward push is ONE continuous accelerating motion from
// the start of the delayed front step through the swing: a quadratic ramp
// during the stride (velocity builds from zero — the body edges
// settings.strideEdgeFrac of the way by the time the foot plants), handing
// off at that same speed into a swing phase that keeps accelerating to a
// peak placed at settings.swingPeakFrac through the phase (higher pushes
// the maximal surge closer to contact) and decelerates smoothly to zero by
// the settle start; the smoothstep settle-back then eases 1 down to
// settings.pushSettleLevel at contact. The return is likewise ONE
// continuous motion: the body rides gently INTO the finish (cresting just
// after the bat's follow-through) and flows back to the stance in a single
// accelerating-then-decelerating arc — never a frozen hold followed by a
// separate ease-out stage. Every handoff is position- and
// velocity-continuous, so the whole cycle reads as one smooth accelerating
// flow into the ball and one smooth return to the stance. Taking a pitch
// gets just the stride edge: the batter strides into the pitch, holds the
// edge through the crossing, and eases back once the ball passes (the
// front foot unplants to follow).

// The sprite's top-of-head height (meters) at scale 1, and the nominal stance
// offsets for that reference sprite. Both are scaled by the same ratio so the
// silhouette (height, body width, shoulders, bat) stays proportional.
const SPRITE_NOMINAL_HEIGHT_M = 2.48
const NOMINAL_STANCE_X_M = 0.65
// How deep in the box the batter stands, in the reference sprite's own units
// (0.75 was the sprite's stance alone). The drive carries the whole one-piece
// body 0.50 m toward the pitcher by contact — hips and torso together, which is
// what keeps the belt from tearing — so the stance has to start that much
// deeper: at 0.75 the ball came 0.10 m inside the bat's own sweet-spot reach and
// the front foot landed beside the plate. Deeper, the ball is the sweet spot's
// own distance from the hands and the front foot lands behind it.
const NOMINAL_STANCE_Z_M = 1.15

// How far the body stands *back* from that plate-tuned stance, in metres, along
// the line from home plate's own centre out through the batter — the line the
// stance's facing is measured along, so stepping back down it leaves the plate
// exactly where it was in the body's own frame and every angle the animation was
// tuned at stays true (see the stance block in the component). It is one number
// rather than one per axis because on this line the box's two directions are the
// same direction: going deeper in the box *is* going further off the plate.
//
// The batter was standing with its own centreline on the inner line of the box —
// as close to the zone as the rulebook allows. Standing further off the plate
// takes the bat's own path off the body with it, and since the hands reach the
// ball *with the bat*, the whole of the extra distance comes off the bat's
// length: the sweet spot still lands on the ball (see handExtension below, which
// is what holds the arms' own reach at the value the pose was tuned at), and the
// bat grows to cover the rest. At 0.10 m along the line — 0.040 m further off the
// plate and 0.092 m deeper, in world metres — the bat's own length goes 0.967 to
// 1.116 rig units, which renders as 0.600 m of bat to 0.692 m (a rig unit is
// 0.627 m on a 6'0" batter) against a 1.25 m-tall body: 48% of the batter's
// height to 55%, either side of a real bat's 46%. The ball ends up 1.956 to 2.106
// rig from the bat's own handle, which is the distance the bat has to make up,
// and the ankles stand 7.9 cm clear of the box's inner line instead of 3.9 cm.
//
// 0.10 m and not more, because the bat is what pays for it: BAT_LENGTH_MAX (1.18
// rig) is the clamp on how long the bat may be before the sweet spot stops
// reaching the ball, and this leaves the fixture pitch's own 1.116 a 5% margin.
// Standing 0.15 m back needs 1.180 — exactly the clamp — so the first pitch
// further away would clamp and come off the sweet spot. Deeper wants the clamp
// raised, not just the stance moved.
//
// Nothing else moves: the facing, the swing's turn, the drive's travel and the
// thrust are the tuned pose, because this is a place to stand and not a pose.
const STANCE_SETBACK_M = 0.1

// The cartoon sprite reads much larger than real-world scale, so a literal
// 1.8 m batter towers over the ~0.96 m strike-zone top. Scale every dimension
// down by this factor (while preserving the API-driven height ordering) so the
// batter sits naturally against the zone.
const BATTER_VISUAL_SCALE = 0.85

// Contact geometry (all in the height-scaled local frame, where the body
// centerline is x=0 and the front of the torso is at z=BODY_FRONT_Z). The
// shoulders are no longer one of its constants: the binding ones (their height,
// half-width and the arms' reach) come from the measured skeleton.
const BODY_FRONT_Z = -0.28

// The upper body pivots at the hip joint (the top of the legs) rather than
// at the feet, so the torso stays attached to the hips while it leans,
// tilts, and swivels through the swing (HIP_Y). The measured skeleton is posed
// about this same pivot, so the bat the geometry places and the body that holds
// it agree.

// How far each elbow rides the bat's barrel line behind the hands during the
// swing (so the bat swings WITH the forearms as one unit), and how far the two
// elbows spread apart along it.
const FOREARM_LEN = 0.46
const ELBOW_SPREAD = 0.1

// How far the elbows ride *in front of the chest* — toward the pitcher — in the
// poses at either end of the swing: the loaded stance and the follow-through /
// recovery. Both elbows are authored out to the sides and down (which is where a
// batter's elbows go), and the set stance faces the *plate*, which is broadside
// to the pitcher, so "out to the side" at the load is exactly where the torso is:
// measured off the posed skin, the arms' own skin sat behind the chest and ribs
// at the load and the lead forearm was buried in the belly at the finish. The
// load rides the pitcher's line in the body's own frame (measured live: the set
// stance is turned ~95 degrees off that line, some 17 of them by
// settings.stanceArmFacing), and the finish rides the pitch's own line in the
// rig's frame.
//
// The load's reach is measured, not chosen: with the upper arm measured past its
// shoulder cap (see SHOULDER_SKIRT in the harness), 0.24 leaves 15 of the lead
// arm's 231 skin vertices inside the ribs at the loaded stance and 0.5 leaves 1
// (the depth of that one 0.049 rig, ~3 cm); past 0.5 the arm starts to fold back
// onto the chest and the count climbs again (5 at 0.6, 6 at 0.8). The finish's
// 0.34 has almost no authority either way — the trail arm's chord is straight —
// and 0.2 to 0.45 all read the same 36 to 41 vertices at the follow-through.
const ELBOW_FRONT_LOAD = 0.5
const ELBOW_FRONT_FINISH = 0.34

// How much further forward the trunk pitches as the back leg drives, in radians
// on top of the swing's own lean (settings.legLean). It is the one posture knob
// the arms' own ordering answers to, and it is measured rather than guessed: the
// trail shoulder sits *below* the lead one by the reset (the trunk is pitched over
// and turned), while the trail hand grips 0.2 rig up the handle, so the trail
// wrist is the highest joint of the two arms and its elbow is the one that has to
// come down. Pitching the trunk forward lowers the trail shoulder's own wrist, and
// the elbow's direction follows it: swept over the whole cycle, the trail elbow's
// own point reads **-0.02 of the upper arm's length below horizontal at its
// highest** (1.06 s) at this value, where with no drive lean at all it rides
// **+0.02 *above*** for seventeen samples (0.92 to 1.07 s) and `the elbows keep
// their own directions` fails there. Leaned *back* (the sign leanMag itself takes,
// see batterLean) it is up for most of the way home and peaks **+0.16** at 0.93 s.
//
// What it costs is the two arms' clearance, on a curve that is monotone and
// steep: the chains' closest approach reads 0.103 rig with no drive lean, 0.077
// at this value and 0.051 at twice it, against `the trailing arm never changes
// places with the leading one`'s floor of 0.05 — and at zero the *order* breaks
// as well (the trail forearm dips 0.004 below the lead's at 1.12 s while the two
// are within 0.3 rig). So this is the value where the elbow comes down and the
// ordering still holds, not a free improvement: twice it trades one bound for the
// other, and the lead arm keeps its bend either way (0.838 of its span).
const DRIVE_LEAN = 0.1

// The band of angles a forearm is allowed to meet the bat at, as the angle
// between the two directions at the grip. This is the wrist's own limit written
// into the *pose*, and it is not a nicety: the bend at the wrist is the angle
// between the hand's own axis and the forearm's, and the model's grip puts that
// axis square across the handle — measured, 89.3 degrees off the barrel at every
// sample of the cycle — so the pose's own floor for the bend is
// ``|89.3 - the forearm's angle off the barrel|``. A forearm lying along the bat
// is a wrist bent 90 degrees no matter where the elbow is put on its circle and no
// matter how the fist is rolled about the handle, and the authored forearm rides
// the barrel *by design* through the swing (see ``align``): measured over the
// cycle, the trailing arm's floor runs 1.1 to 114.8 degrees and the leading arm's
// 11.8 to 131.8, with the load (the trail hint asks 129.2 degrees off the barrel)
// and the whole follow-through over the limit.
//
// The band's edges sit seven degrees inside the wrist's 30, for the solve's own
// residual between its forecast and the bones (measured, 3.4 degrees): |89.3 - 114|
// is 24.7 degrees of bend at the worst, and |89.3 - 66| is 23.3 at the other end.
const FOREARM_LEAN_MIN = THREE.MathUtils.degToRad(66)
const FOREARM_LEAN_MAX = THREE.MathUtils.degToRad(114)

// How far the *trailing* arm's elbow is held out on its own side of the bat, as
// a fraction of a rig unit, measured from its own shoulder-hand chord. This is
// what keeps the trailing arm on top of the leading one: the two arms come off
// the one handle, so they are only ever ordered by where their elbows ride, and
// left to the hints the trailing arm's elbow follows the lead arm's V down onto
// the bat's own line — measured, the two chains come 0.001 rig apart at 0.50 s
// with the forearms passing through each other, and again 0.004 rig apart at
// 0.99 s on the way home, with the trailing arm's elbow three centimetres short
// of the leading arm's on the wrong side of the bat.
//
// Unlike the lead arm's own carry below, this is measured square to the *bat*
// and not square to the arm's own chord: the arms are ordered against each
// other around the bat's line, so that is the axis the floor belongs on — and a
// push *along* the chord would only lengthen the arm. It rides the follow-
// through's own ramp (``fp``), so it is nothing at the contact frame and full
// from the follow-through through the way home; the set stance is where the
// leading arm's own carry hands the arms back (see ELBOW_LADDER_RELEASE).
const TRAIL_LANE_MIN = 0.36
// How far the *leading* arm's elbow is carried off the line its own IK solves
// about (shoulder to hand), on its own side of it, as a fraction of a rig unit:
// a batter's lead elbow finishes out beside the shoulder rather than tucked in
// against the ribs, and this is what holds it there through the hold. It is
// measured perpendicular to that arm's own chord — so a push along it carries
// the elbow out rather than lengthening the arm — which is why it is a
// different rule from TRAIL_LANE_MIN even though both are one elbow's own side.
//
// Set where the pose can hold it: a bent arm's elbow can leave its own chord by
// the radius its bone lengths give it (0.22 rig at the follow-through's bend)
// and a straight one cannot leave it at all, so this is a floor on the *hint*,
// not a fact about where every frame lands.
const ELBOW_LADDER_MIN = 0.2
// ...and how far off that line an elbow is allowed to be *before* the follow-
// through's ramp gets going, so the contact frame — a pinned pose of its own —
// is untouched: the floor starts here and climbs to ELBOW_LADDER_MIN over the
// follow-through. Set below anything the poses take (the deepest the trail elbow
// ever reads on the wrong side of its own line is 0.31 rig, at the load, where
// this rule is not in play at all).
const ELBOW_LADDER_SLACK = 0.5
// Where the floor lets go again, as followProgress: it is full through the
// follow-through and the hold (progress 1) and gone by 0.85, which is the
// reset's first frame. The way home is the pose the trail elbow was tuned down
// and back in (see the reset's own test), so the ladder hands the arms back to
// the hints over that tenth of a second rather than holding them up.
const ELBOW_LADDER_RELEASE = 0.85
// Where the lead shoulder lies from the grip the follow-through leaves the hands
// on, in the rig's own frame (x is stored lead-ward and mirrored by ``sign`` at
// the use site, as every cross-body offset here is). The way home is authored
// with the hands where the finish put them, and that grip sits 7% of the arm's
// own span further from the lead shoulder than the arm spans: the clavicle's
// reach spends its whole 20-degree budget and the two bones are stretched past
// their own length to cover the rest, so that arm is straight or over its own
// length for the third of a second from the hold to 0.95 s (measured, its
// shoulder-hand chord runs 0.97 to 1.07 of the arm's span, peaking 0.93 s). That is the "running to full stretch"
// this direction exists to undo, and no other lever touches it: the torso held
// open later into the reset (settings.torsoRecoverLag 0.25-0.75) leaves the chord
// at 1.066 through the crux, and an elbow's own carry runs along its chord and
// cannot shorten it.
//
// Carrying the hands back along this direction is what gives that arm a bend
// again, and the way home takes it on its own path (see RESET_PULL). It used to
// be taken on the *hold's* own grip as well — 0.47 of it on `peakHands` — and
// that is no longer read: with the bat carried flat through the hold, the 0.48 of
// this direction that points *up* is what broke the trail hand's grip there (see
// `peakHands`), and the lead arm's chord answers to the bat's own carry instead.
// What the way home still needs is the retrace's share of it, which is where this
// now lands.
const LEAD_SHOULDER_FROM_HOLD = [0.42, 0.48, 0.77]
// The way home's *own* pull, taken on the hold's held pose: how far the held grip
// is carried across the body toward the lead side. It used to be taken on over the
// tail of the hold; the carry is written onto the swing's own path now (see
// FOLLOW_CARRY_FROM), so the pose the path ends on *is* the pulled one and the hold
// holds it — the way home starts from that pose exactly, which is what keeps the two
// phases meeting on one pose instead of the hands jumping between two.
//
// The bound it exists for is the *lead* arm's: the reset's first frames are the
// hold's own pose, and that arm's shoulder-to-grip chord there read **1.313 of its
// own span** before this was taken (the clavicle spent and the bones stretched).
// Only the component along that chord can shorten it, and the chord runs from the
// grip up, back and across to the lead shoulder. Of those three:
//
//   the *vertical* is the trail hand's cost. The trail hand grips 0.253 rig up the
//   handle, so every rig of rise is a rig its wrist rides over its own shoulder
//   (see `peakHands`). Measured, 0.45 rig along the shoulder's own direction —
//   0.48 of it up — puts that wrist's bend floor at **81 to 102 degrees** against
//   the 30 it is held to, and the back of its palm at -0.72 to -0.83 against 0.25:
//   the fist cannot close on the handle at all.
//
//   the *backward* part is the bat's clearance of the body: it carries the grip
//   back over the belly with the barrel still round it (0.45 rig along the
//   shoulder's whole direction reads 0.18 to 0.28 rig of clearance, against the
//   0.25 the suite holds it to at its worst).
//
//   the *lateral* part buys the chord and nothing else — and it moves the whole
//   bat with it, knob end included, which is exactly what a follow-through's own
//   throw reads as.
//
// It is taken all the way, because that lateral part is the throw: the pose the
// hold ends on carries the bat across the body until the *whole* of it — the knob
// included — has (almost) crossed the plane through the lead shoulder that stands
// perpendicular to the front line of the batter's box, which is the plane a
// follow-through's own carry is read against. Measured in the rig's own frame,
// the knob reads **+0.585 on the batter's own side of that plane at the hold's own
// pose and +0.004 at the hold's end** — 0.143 from the lead shoulder's -0.143, so
// the knob is 2 mm short of it and everything above the grip is across — with the
// barrel's tip going -0.317 to **-1.035** and the barrel's nearest skin of the
// body 0.455 to **0.72 rig** on the way.
//
// What it costs is the *trail* arm, and the cost is its own grip's geometry rather
// than a choice: that hand grips 0.253 rig up the handle, and the bat lies 0.82
// of its length across the body, so it rides 0.208 rig *inboard* of the knob —
// while its own shoulder stands 0.53 rig out on the other side of the pelvis. A
// knob on the plane therefore puts the trail hand 0.76 rig from its own shoulder,
// against the 0.74 the arm spans: the arm is straight and the bones 5% past their
// length, where at the hold's own pose it reads 0.873 of its span with a
// 122-degree elbow. It was 0.30 (half-way, the knob 0.30 rig short of the plane)
// through the two turns before this one for exactly that reason; the pose is taken
// to the crossing now because the crossing is what the follow-through is being
// read for, and the arm's own numbers are written down here as the price.
// What it *does* buy the trail arm is measured too, because half of what this pull
// was asked for was the rear arm's motion: over the hold and the reset the
// trail elbow's own direction reads 0.11 to 0.13 up from 0.80 s instead of the
// 0.14 to 0.29 it climbed through 0.80-0.91 s without the full carry, and the
// window it spends above its own shoulder shortens from 0.76-1.09 s to
// 0.75-0.95 s + 0.97 s. What it does *not* touch is the one flick in the window —
// a 0.77-rig step of that elbow's own direction at 1.09-1.10 s — which is the
// fist's own held roll being handed back (see PALM_HELD_BACK: zeroed, the elbow
// holds -0.77 through the whole stretch but the wrists' bend floors go to 98
// degrees against their 30).
const HELD_PULL = 0.74
const HELD_PULL_DIR = [1, 0, 0]
// ...and the shape the carry is taken on with, over the *follow-through's* own
// progress: it used to be the hold's own clock that moved the bat the last of the
// way across (the pose the eye reads as the finish was the hold's), and the
// follow-through then arrived at a stop and the bat translated the rest of the way
// sideways. Authored onto the path, the carry is the swing's own continuation —
// the bat still has speed when the follow-through ends (see FOLLOW_ARRIVAL) — and
// the hold has nothing left to move: it holds the pose the path arrived on.
const FOLLOW_CARRY_FROM = 0.55
function carryEase(share) {
  return easeSwing(Math.min(1, Math.max(
    0, (share - FOLLOW_CARRY_FROM) / (1 - FOLLOW_CARRY_FROM),
  )))
}
// Both hands stay on the handle for the whole swing — the trail hand gripping
// gripSplit up it — so the finish the body turns into (0.54 s) is a two-handed
// pose, and the moment the suite reads its grip at is the path's own end.
// How far the bat is carried *round the trailing arm*, and which way, so that a
// trailing arm held straight can guide it without its own upper arm lying in the
// ribs (see the constraint in the frame loop). Both hands stay on the handle for the
// whole swing, so this is what the *finish* is built on: on the swing's own path the
// trail hand's chord runs 1.05 of its arm's span at the across pose — beyond the
// arm's reach, its 175-degree elbow straight, its clavicle already spent covering the
// difference, and 24 of its 230 upper-arm skin vertices 0.048 rig inside the ribs at
// the last two-handed frame. No hint can answer for that (20 configurations of the
// elbow's own finish target move the reading by nothing), and pulling the bat *back*
// along the shoulder-to-hand chord bends the elbow into the chest and costs the bat's
// own clearance from him 1:1. What does move it is the *direction* of that chord, and
// the free direction is a rotation about the shoulder: 0.42 rig of it — up, out and
// forward, the way the bat is already travelling — carries the whole bat *away* from
// him, not toward him, and the body's nearest skin to the bat's line rises 0.309 →
// 0.497 rig while the knob arrives 0.014 rig past the lead shoulder's plane.
// Measured over the carry, the finish and the whole hold, the trailing arm is
// *straight* — 175 to 176 degrees at every frame, its chord 1.19 of its span at the
// finish and through the hold, 1.00 at the deepest of the carry and never under
// 0.999 — its upper arm reads nought of its 230 skin vertices inside the trunk and
// +0.029 rig clear of the chest at the finish and the hold, and the largest step any
// bone of it takes in one 0.01 s frame is 0.23 rig, where the swing's own un-carried path
// reads 8/20/24 vertices at −0.020/−0.038/−0.048 rig. 0.34 rig — where this was
// tuned while the reach bound was still pulling the grip in through the
// follow-through — dips 1.4% inside that arm's own reach at 0.48 s, the one frame
// the elbow answered with a 15-degree bow, and reads 0.338 rig of bone step per 0.01 s
// frame for it.
// What it costs is the other arm's: the leading chord *lengthens* as the hands go
// outboard (0.965 → 1.149 of its span at the finish, a 175-degree elbow where the
// un-carried pose read 147) and its own press on the chest reads 24-27 vertices at
// −0.049 to −0.057 where the swing's path reads 18 at −0.045 — the depth is the
// pose's either way, and the count stays inside the suite's 45. Taken on over the
// hand-over window (see SWING_HANDOFF), held through the finish and the hold, given
// back over the first fifth of the way home, where the retrace takes the pose over.
const TRAIL_REACH_CLEAR = 0.42
const TRAIL_REACH_CLEAR_DIR = [0.70, 0.55, -0.44]
// ...and the arm's own reach, as the bound on where the two-handed bat can be carried
// at all — read over the *reset* only, because the swing's own half of the cycle is
// the pose's own business and the retrace's is not. The retrace walks the finish's own
// poses backwards, so the arm is over its reach for longer than the bones answer for
// there (1.19 of its span at the reset's first frame, at its longest 1.25 through
// 0.84-0.92 s with this off, and its bicep 0.05 rig into the ribs); by 1.00 s the
// retrace's own chord is back under 0.94 of its span and the excess is nought. Both
// fists are on the handle for the whole swing (see updateArms) and the trailing fist
// grips ``gripSplit`` up it, so the chord from the trailing shoulder to that grip is
// the span that arm has to cover: 0.92 rig of chord is what it covers with its
// clavicle doing its own share and a real bend left at the elbow (measured, 0.96 of
// its span at the end of the pull and its own 149-to-152-degree elbow from 0.98 s on,
// which is what that arm read through the reset before this bound was ever written).
// It is read against the shoulder the arm solve itself builds the arm from, so the
// bound and the solve cannot drift apart, and it is taken up over the same first fifth
// of the reset that hands the held pose back (see TRAIL_REACH_UNWIND), so the arm
// turns over once as the body unwinds rather than being pulled out of the finish.
// Holding it over the swing's own carry instead — which is how it read until the
// flicker it caused was measured — fights a chord that is already at the arm's reach:
// the elbow drops from 175 to 150 degrees within the frame after contact and then sits
// between
// 136 and 151 degrees with a 40-degree ribbon for the rest of the follow-through,
// which the frame loop's own comment sets out.
const TRAIL_REACH_MAX = 0.92
// ...and the share of the recovery's own ease the carry round is given back over — the
// same clock the hold's carried pose is handed back on (see RECOVERY_UNWIND_SHARE),
// because the carry round is part of that pose.
const TRAIL_REACH_UNWIND = 0.18
// ...and how much of the same pull the *retrace* takes, which is more than the
// held grip's share and *shaped* rather than faded. The swing's own poses sit at
// the end of the lead arm's reach exactly where the way home is hardest — the
// contact pose the retrace walks back through is 1.081 of the arm's own span on
// the swing's own clock — so the pull has to stay at its full width through the
// middle of the way home and only let go as the load comes back. It is let go over
// the last third of the recovery's own ease, where the pose is the stance's own
// and the arm straightens by itself.
const RESET_PULL = 0.38
// ...and the share of the recovery's own ease the retrace's pull is let go over,
// so that the last of the way home is the stance's own grip rather than a pulled
// version of it (the pose the way home ends on has to be the set stance's, or the
// batter has to step into it). Full width until the recovery is seven tenths of
// the way through, gone by the end.
const RESET_PULL_HOLD = 0.3
// The same direction read at the reset's own crux (0.93 s) instead of at the
// hold, where the body has unwound part-way: the shoulder is further out to the
// lead side and lower, so the bow rides this one — **flat**.
//
// The vertical part of this direction is the one thing the pull may not spend,
// because the trail arm's elbow answers to the hands' own height: the trail hand
// grips 0.2 rig up the handle, so the higher the hands are carried the higher its
// wrist rides over its own shoulder, and the elbow follows it round. With the
// bow lifted by the 0.139 rig this direction used to carry, the trail wrist sat
// 0.164 rig above its own shoulder through the reset and the elbow solved 0.128
// of the upper arm's own length above it — the trailing upper arm pointing up,
// with the two forearms
// running across each other on the way (trail forearm over the lead one at the
// hold, under it by 1.08 s, 0.086 rig apart at their closest). Taken flat the
// elbow comes down, and the pull still does its own job: shortening the chord is
// what bends the lead arm, and its reach reads 0.838 of its span through the
// reset against 0.831 with the lift in place.
// How much of the way home is spent giving up the hold's own settle before the
// swing's path is retraced, as a share of the recovery. The way out never passed
// through the hold's own pose, so it is released first, over the same ease it was
// taken up with; after it, the retrace (see the recovery below) walks the swing's
// own path backwards, and the hands come back over ground the forearms have
// already cleared — which is why the way home no longer needs its own control
// point, bulged toward the lead shoulder to bow the chord around the chest.
const RECOVERY_UNWIND_SHARE = 0.2
// How far along each, in rig units. At these the chord tops out at 0.876 of the
// arm's span through the reset (1.11 s) and bottoms at 0.493 (0.97 s) — a
// 122-degree elbow at the hold (and 122 degrees of the trail arm's), where the
// pose the path starts from (the follow-through's own grip, 1.077) is straight,
// the bones stretched 7.7% over their own span. The pull is taken on the reset's
// own path (see `backHands` in the recovery below), which is the whole of it: it
// used to be taken on the hold's own grip as well, and that half is gone with the
// hold's rise (see `peakHands`). What it costs is the arms' own clearance of the
// trunk and the trail elbow's line: the two tests that hold those say what this
// spends, as
// How far the way home is bowed *off* the body, in rig units, and how much of the
// bow goes to the batter's own side rather than out front. The retrace walks the
// swing's own curve backwards, and that curve passes close over the trunk: measured
// against the body's own line, the hands come within 0.14 rig units of it at 1.24 s
// (and 0.11 at 1.29 s), where the set stance holds them 0.54 out — the bat comes
// back across the chest rather than away from it. So the retraced pose is pushed off
// it along the direction the *load* holds the hands in (out toward the pitcher, a
// tenth of it to the batter's own side), by a bow that is nought at both ends of the
// recovery — the hold's own settled pose and the load — so the way home still meets
// exactly the poses it starts and ends on. The bow reads 0.16 rig at its widest
// (a quarter of the way home's own reach), which puts the hands back to 0.30 out at
// their closest; the bend's own clearance of the trunk is measured by the suite.
const RECOVERY_AWAY = 0.16
const RECOVERY_AWAY_SIDE = 0.1
// How much of the way home's *held* fist roll each hand takes: 0 leaves the roll
// on the arm's own reach and 1 takes all of it onto "the back of the palm faces
// the sky" (see fistRotation, which gates the share by the barrel's tilt). They
// are not the same number, and the reason is measured rather than aesthetic: the
// front (lead) hand's roll is the one whose own arm drags the chest far enough
// round that the *back* forearm's path along the ribs closes. At 0.96 s, with
// the front hand's share at 0.6, the back forearm reads 5 of its 116 skin
// vertices inside the trunk against a bound of none; at 0.5 it reads 0, and the
// back hand's own share (0.5 to 0.65, swept) changes nothing either way. The
// back hand needs the larger share for the opposite reason: its own reach
// direction turns through the reference's opposite half way round the reset
// (1.14-1.26 s), and a share under half passes *through* the reference instead of
// holding it — at 0.5 the back elbow's direction stepped 0.49 rig in one frame
// there and the back palm came within 0.11 of edge-on, at 0.65 they read 0.19 and
// 0.15 (see the whole-window sweeps in the suite).
// Giving the held roll back *earlier* does not fix the flick, and that is measured
// rather than assumed: handed back over r 0.25-0.45 (1.07 s) instead of 0.8-1.0
// (1.16-1.37 s), the trail elbow's own 0.77-rig step at 1.09-1.10 s goes away and
// the *lead* elbow's takes its place somewhere worse -- a 1.21-rig step at 1.00 s,
// against 0.23 there with the hand-back where it is. The roll is handed back at
// whatever moment the pose's own reach direction turns, and the fist's search picks
// between two answers a window apart the instant it does; moving the moment only
// moves the flip. What would fix it is the search itself -- see ``fistRoll``'s
// window and the arm solve's walk -- and not this share's timing.
const PALM_HELD_FRONT = 0.5
const PALM_HELD_BACK = 0.65
// ...and the *trail* hand's own share of that held roll, over the follow-through and
// the hold. The two hands are not doing the same thing there: the lead hand closes on
// the knob end with the bat carried away from it, and the trail hand grips up the
// handle on the *far* side of the bat's own sweep, so the same roll reference swings
// its wrist a wider arc round the handle and the arm has to reach further to close on
// it at all (measured at the across pose: see the README).

// Where the follow-through puts the hands, in rig units: an absolute height, not
// an offset from the contact grip. The finish is a *pose* — it was tuned at this
// height and the bat is held in front of the chest there — and taking its height
// from the contact grip's made it ride the pitch as well: a deeper pitch carries
// the body's hands higher at contact, and with the stance set back in the box
// (see STANCE_SETBACK_M) the 0.09 rig that came with it put the trail forearm
// 5 mm inside the ribs at the follow-through, where it had read clear. Held
// here, the finish is the pose it was tuned as whatever the pitch does.
const FINISH_HANDS_Y = 1.31
// The finish's own grip, in the batter's own frame: how far round to his own
// side of the pelvis's axis, and how far out in front of his belly. Both are the
// *bat's* own carry and the knob is the bottom of the bat, so what they decide is
// where the whole handle ends up — the barrel rides round with the grip, and the
// two arms are measured against it (the lead arm's span at the finish, and the
// trail arm's own chord, which is the one the carry round is bounded by).
//
// The *depth* is what the lead arm's own reach answers to, and that is what it is
// set by: the grip is carried 0.20 rig further out in front of the belly than it
// used to be, and the arm left holding the bat goes from **0.84 of its span — a
// 114-degree elbow, the folded arm a two-handed finish used to be read at — to
// 0.96-0.97, a 147-to-151-degree elbow**, at every sample from the follow-through's
// own end (0.54 s) through the whole hold. That is what the finish's own carry is:
// the knob taken away from the batter's body with the lead arm left long behind it,
// instead of the grip tucked in against the chest with the arm folded over it.
//
// Out in front rather than further round or higher, and that is measured too: x is
// pinned by the bat's own crossing of the lead shoulder's plane (see the carry
// test — the knob's standoff from that plane is 0.04 rig at the follow-through's
// end and 0.01 through the hold, against a 0.05 bound), and *height* makes the lead
// arm's chord **shorter**, not longer — its shoulder sits 0.72 rig above the pelvis,
// so every rig the grip gains is a rig it rides toward that shoulder: carried 0.09
// rig lower the across pose reads 0.99 of the span, 0.06 deeper 0.97, 0.05 higher
// 0.94 and 0.08 higher 0.89. Depth is the one direction on this pose's own sphere
// that both lengthens the lead arm's chord and carries the knob away from the
// batter's chest, and the barrel's own clearance *improves* with it rather than
// paying for it: the nearest skin to the bat's line anywhere in the follow-through
// and the hold reads 0.50 rig (0.27 before), against the 0.25 the suite holds it to.
const FINISH_OUT = 0.44
const FINISH_DEPTH = 0.66
const FOLLOW_FLAT = 0.35
// The hold's own grip, as an offset from the finish's, in the batter's own frame:
// further round to his own side, out in front of him, and settled three hundredths. It
// is authored as offsets from the finish because the hold *is* the finish carried
// on — see `peakHands`, which is where the measured readings for each of these
// live. What each is worth, in one line each: the *carry* is the half a viewer
// sees (the whole handle goes with it, knob end included, and the trail arm is the
// one whose own chord shortens as the grip goes toward its shoulder); the *depth*
// is the forearms' clearance of the belly and the barrel's of the trunk; and the
// *settle* is the trail hand's grip, which is the one thing here that is a cost
// rather than a purchase — the trail hand grips 0.253 rig up the handle, so every
// rig of height the grip gains is a rig its wrist rides further over its own
// shoulder, and a wrist that cannot bend far enough to close on the handle takes
// the elbow up with it.
// The hold's own yaw, as an offset from the follow-through's own bat angle in
// the batter's frame: how much further round the swing's own turn carries the
// barrel after the follow-through ends. It is left where it was: with the grip
// carried out on the batter's own side and the two arms' chords measured, this is
// not the lever the bat's carry is — turning the barrel further round to the
// batter's side from here swings the tip off the plate but straightens the trail
// arm to 0.896 of its span (0.799 at 0.12), against the 0.9 it is held to.
// ...and now that the carry is the *swing's* own — the path ends on the pose the
// hold holds (see `peakHands` and carryEase in the frame loop) — the hold has no
// motion of its own left to describe, so what is left of these is the shape of that
// pose: 0.16 rig further round to his own side than the finish's base, 0.03 lower
// (the same 0.08 the lead arm's chord was bought with above), and the last 0.12 of
// its own depth, which is where the depth lived before the front of it was moved
// into the finish's own grip.
const HOLD_YAW = 0.19
// ...and how much of that turn is taken on over the *back* of the follow-through
// rather than evenly between the ball and the finish (see turnLate). The bat's own
// turn is what the trailing arm's chord answers to while both hands are on the
// handle: at the ball the arms are extended along the swing's own line and a faster
// turn folds that arm's elbow, further round the body's own turn has already carried
// the grip and the extra turn costs the arm nothing it was not already using. So the
// added turn is this share's worth, all of it late, and the frames at the ball keep
// the rate they were measured at.
const HOLD_YAW_LATE = 0.07
const HOLD_OUT = 0.16
const HOLD_SETTLE = -0.03
const HOLD_DEPTH = 0.12

// The two hands do not grip the exact same spot: the trail arm (the one away
// from the pitcher — the right arm for a righty) grips up the handle toward the
// barrel, and the lead arm rests against the knob. How far up is the model's own
// number: its rig carries an IK target for each hand, and the gap between them is
// read at load time (``metrics.grip.separation``, in rig units — 0.253 on the
// reference model). Read rather than tuned, because it is the spacing those hands
// were moulded for: with their fingers curled, stacking the fists any closer
// drives one hand's fingers into the other. This is the fallback for a model
// without the two targets: the reference's own gap, which puts the fists a
// knuckle's width apart instead of the near-overlap they had at 0.09.
const GRIP_SPLIT_FALLBACK = 0.253

// The hands at contact reach settings.handExtension of the way from the front of the
// torso toward the ball, so the arms extend naturally and the sweet spot (the
// remaining distance to the ball) lands on the barrel.

// The sweet spot sits this fraction of the bat's length from the handle (near
// the barrel end, like a real bat). The bat length is derived so the sweet
// spot lands exactly on the ball; it is clamped to keep the bat a sane size.
const SWEET_SPOT_FRACTION = 0.78
const BAT_LENGTH_MIN = 0.85
const BAT_LENGTH_MAX = 1.18

// Bat-tracking tilt clamps (degrees). The attack angle sets the barrel's
// direction at the exact moment of contact (MLB seasonal range ~0-20°, ideal
// 5-20°), while swing_path_tilt shapes the swing plane the barrel rides on the
// way in (MLB seasonal range ~20-50°). Both are clamped so the cartoon swing
// stays readable; the hands are lowered by the same amount the rising barrel
// gains, keeping the sweet spot on the ball.

// Hands in the set stance: out to the side at the back shoulder (the batter
// faces the pitcher, so the left shoulder is -X and the right is +X), at chest
// height. The hands sit slightly in front of the chest center so the
// cross-body (front) arm's forearm can ride around the front of the torso
// instead of passing through it when it reaches across to the load grip.
// The per-side sign is applied in the component.
// The load is also where the arms have to read *in front of* the torso rather
// than tucked behind it: the hands hold the bat out at the back shoulder, and a
// fist is solved onto the handle with the *palm* on it, which puts the wrist a
// hand's length back toward the shoulder (see the hand solve in playerRig.js).
// At 0.44 the pair of them sat in the armpit, with the forearms' own skin inside
// the ribs by 0.09 rig units; out and a little further forward, the arms clear
// the body the way they did before the grip was moved onto the palm.
// The set stance's grip, in the rig's own units off the body's midline. It sits
// at the *front* of the torso rather than out over the trail shoulder: the trail
// hand grips 0.253 rig up the handle, so where the grip is decides how far the
// lead arm has to reach to hold it, and reaching out to the batter's own side of
// their body is the one direction the lead arm has no room in — it has to cross
// the whole chest to get there. At 0.54 out and 0.24 forward the lead arm read
// **98% of its span** (a straight chord with the elbow locked out) with the hand
// 0.68 rig across and 0.67 rig behind its own shoulder; in front of the sternum —
// 0.05 off the midline, at 1.70, half a rig out toward the pitcher — the same arm
// reads 78%, its hand 0.35 across and level with the shoulder, and its elbow 0.11
// rig *in front* of it. The bat comes with it: 0.32 rig further toward the pitcher
// than it used to sit.
//
// Height and depth are a trade, and this is the corner of it that holds both
// bounds at once. Read off the posed skin the *lead* bicep is 0 inside the ribs
// here and 16-18 inside with the hands carried low (1.66-1.70) and out at arm's
// length, so the grip wants to stay high; but the pitcher's own view of the
// *trail* arm wants the opposite — with the hands up at the shoulder (1.82) the
// torso covers 91 of that arm's 198 skin vertices from his side of the plate,
// against the 32 the coverage test allows, and at 1.70 it covers 26. Half a rig
// forward is the third term: it is what carries both arms clear of the belly,
// and the trunk's own turn (settings.stanceArmFacing) is what turns with them.
const LOADED_HANDS_X = 0.05
const LOADED_HANDS_Y = 1.7
const LOADED_HANDS_Z = -0.5

// Where the feet stand at the set, in the hips' own frame: the ankle's offset
// along the hips' forward axis (a little ahead of the hip sockets, which is what
// the tuning's crouch asks for). The stance's footprints in the batter's frame
// are these, turned by the stance's yaw — see poseLegs.
const SET_ANKLE_Z = -0.05

// How far forward the hands path bulges (toward the pitcher) as it arcs from
// the loaded stance to the contact point, so the bat and arms clear the torso.

// Slow idle bob of the loaded stance: the upper body rises and falls gently so
// the batter looks alive between pitches. Driven by real elapsed time (not the
// looping playback clock) so it never jumps when the pitch loop resets, and it
// fades out as the swing takes over.

// The head faces the pitcher during the set (so the brim points down the
// pitch), then tracks the ball through the swing: it tilts forward toward the
// plate and swivels to face the contact point (the ball at home plate). The
// face is the head's local -Z (the brim sits on that side), so the yaws are
// computed from the head->pitcher / head->contact offsets expressed in the
// upper body's own rotated frame; HEAD_YAW_MAX just keeps the contact turn
// from looking cranked fully sideways.
const HEAD_YAW_MAX = 0.8

// The swing and the follow-through are one motion, and the clock they are read on is
// what made them read as two. Both halves used to be smoothsteps, so the bat came to a
// standstill at the ball -- measured, 0.75 rig/s at the contact frame against 5.5 either
// side of it -- and then left along a curve 72.6 degrees off the one it arrived on (the
// stat-driven swing's own arc arrives descending and toward the body; the follow-through
// leaves across it and level).
//
// The stat-driven path is cut short instead: it lasts to contact and a hair past, and
// what follows is the authored follow-through. Its own last fifth plateaus into a
// constant arrival speed, and the frames just after contact are a cubic bridge that
// leaves the ball on the swing's own tangent, at the swing's own speed, and reaches the
// follow-through's own pose on *its* tangent -- so the bat turns off the line it met the
// pitch on over four frames rather than at a corner (blending the two *positions* across
// a window instead was tried and is worse: by the end of any useful window the curves
// are a tenth of a rig apart, and the blend drags the bat further in one frame than the
// swing ever moved it). Nothing the stat line is read for moves: the contact frame is a
// point *on* it, the bridge starts there, and both curves pass through it -- so the
// attack angle, the sweet spot on the ball and every pose the suite pins outside the
// window are exactly where they were.
// The swing's own progress is `x ** SWING_EASE`, so its own slope is *largest* at the
// ball: SWING_EASE there, against 1 for its own average. Measured, the tip's own speed
// peaked at 38 rig/s at 0.325 s and had fallen to 5.5 by the contact frame -- the
// swing's fastest moment sat a tenth of a second *before* the ball, because the shape
// it used to be (a smoothstep plateauing onto two fifths of its own peak slope by the
// tail) decelerates into contact. At 2.4 the swing's own peak *is* the contact
// frame's, which is where a swing's speed is.
const SWING_EASE = 2.4
// ...and the follow-through leaves on that speed and only ever slows: one Hermite from
// (0, `followSlope`) to (1, FOLLOW_ARRIVAL), whose own slope is monotone decreasing
// between them (see the frame loop's comment on the profile), so the bat's fastest
// frame is the one on the ball and everything after it is the bat running down.
// FOLLOW_ARRIVAL is the speed the swivel picks up (see SWING_SWIVEL): the hold used to
// start from a standstill and jolt (measured, 3.95 rig/s at 0.540 s to 0.79 at 0.545).
const FOLLOW_ARRIVAL = 0.18
// ...and how far the bat swivels *on* past the finish, on the momentum the
// follow-through ends with. The leading fist is carried no further (the grip is
// held where the path put it), so what is left moving is the bat itself: it turns
// on the handle a little more and runs to rest over the hold's first 0.10 s, the
// way a real bat is loose in the top hand through a follow-through. The swivel
// leaves the finish pose itself alone (it is nought at 0.54 s, the pose the suite
// reads the finish at), settles well inside the hold, and is what the way home
// starts from -- so the two phases still meet on one pose. Raised from 0.075 with
// the finish's own turn (see HOLD_YAW): it is the free part of the bat's total
// swing -- measured, it moves nothing the arm bounds read -- so the barrel's far
// end keeps coming round after the path has stopped.
const SWING_SWIVEL = 0.13
const SWING_SWIVEL_TIME = 0.10
// How long the bridge out of the contact frame is. Long enough to be frames rather than
// a corner (at 60 fps it is four) and short enough that the follow-through's own shape
// is untouched a fifth of a second later.
const SWING_HANDOFF = 0.03

function easeSwing(t) {
  const x = Math.max(0, Math.min(1, t))
  return x * x * (3 - 2 * x) // smoothstep
}

// The bat's own turn past the ball, for the share of the finish's turn that is taken
// on over the *back* of the follow-through (see HOLD_YAW_LATE): nought until the
// follow-through's own half-way point, then a smoothstep onto the finish, so the share
// leaves the ball's own frames alone and arrives without a rate of its own.
//
// Where that start sits was measured, and both earlier shapes are worse. Taken evenly --
// a plain lerp to the wider finish -- the trailing elbow folds to 164.3 degrees at
// 0.46 s and straightens again, which the joint test reads as an 11-degree flick 60 ms
// after the ball; taken late but from the ball itself it folds to 165.6 and is read the
// same way. Started from the half-way point it holds 174.1 against the 174.9 it held
// before, and the test reads nought flicks. The reason is the arm's own geometry: at
// 0.46 s that arm is at its own extension (175 degrees) with the carry just beginning
// (FOLLOW_CARRY_FROM is 0.55 of the follow-through), and any extra turn there costs the
// chord another millimetre, which near full extension is nine degrees of elbow in one
// frame. Half-way along, the body's own turn has already carried the grip.
const HOLD_YAW_LATE_FROM = 0.5
function turnLate(x) {
  const c = Math.max(0, Math.min(1, (x - HOLD_YAW_LATE_FROM) / (1 - HOLD_YAW_LATE_FROM)))
  return c * c * (3 - 2 * c)
}

// A cubic Hermite, so an ease can have one end re-shaped without anything away from
// that end moving (both bases are 0 and their slopes 0 at the other end).
function hermite(p0, m0, p1, m1, t) {
  const t2 = t * t
  const t3 = t2 * t
  return (2 * t3 - 3 * t2 + 1) * p0 + (t3 - 2 * t2 + t) * m0
    + (-2 * t3 + 3 * t2) * p1 + (t3 - t2) * m1
}

// The swing's own progress, and (in the component) the follow-through's. Monotone, and
// monotone *accelerating*: the load is the slow part of a swing and the ball is the fast
// one (see SWING_EASE).
function swingProgress(x) {
  const c = Math.max(0, Math.min(1, x))
  return c ** SWING_EASE
}

// Wrap-aware angular lerp: takes the shortest rotation between two yaws, so a
// blend never spins the head the long way around through +/-PI (which reads
// as the head popping off its neck).
function lerpAngle(a, b, t) {
  return a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t
}

// The bat's own axis (knob end to barrel), from the pose it is held at: the mesh
// points along local -Z, raised by the cock/tilt X rotations and yawed by the bat's
// own angle. One function, because the arm solve and the trailing arm's own reach
// in the frame loop both have to read the same direction for the same pose.
function batAxis(batAngle, cockAngle, tiltAngle) {
  const phi = cockAngle + tiltAngle
  return new THREE.Vector3(
    -Math.cos(phi) * Math.sin(batAngle),
    Math.sin(phi),
    -Math.cos(phi) * Math.cos(batAngle),
  ).normalize()
}

// Quadratic Bezier used for the hands path from the loaded stance to contact.
function bezier2(p0, p1, p2, t) {
  const u = 1 - t
  return [
    u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
    u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
    u * u * p0[2] + 2 * u * t * p1[2] + t * t * p2[2],
  ]
}


// Scratch used to read a point back out of one of the batter's groups into the
// frame the animation is authored in — feet at y = 0, no body rotation, no
// uniform height scale — which is the frame the bone driver's targets live in.
const _groupInverse = new THREE.Matrix4()

const _headWorld = new THREE.Vector3()
const _upperQuat = new THREE.Quaternion()
// Where the pitcher lies, in the upper body's own frame (see updateArms).
const _armDir = new THREE.Vector3()
const _armQuat = new THREE.Quaternion()
const _pitcherTarget = new THREE.Vector3()
const _worldDir = new THREE.Vector3()
const _localDir = new THREE.Vector3()

export const Batter = ({ pitchData, replayKey = 0 }) => {
  const settings = useTuning().batter
  const upperRef = useRef()
  const innerRef = useRef()
  const batGroupRef = useRef()
  const cockRef = useRef()
  const tiltRef = useRef()
  const headRef = useRef()
  const handLRef = useRef()
  const handRRef = useRef()
  const groupRef = useRef()
  const camera = useThree((s) => s.camera)

  const glbPlayer = useGLTF(PLAYER_URL)
  const glbBat = useGLTF(BAT_URL)

  // The body is the reference project's skinned player model. It is cloned with
  // SkeletonUtils (so its bones can be posed without disturbing the cached
  // asset) and measured once: measurePlayerRig reports the skeleton's joints in
  // THIS component's units — feet at y = 0, body SPRITE_NOMINAL_HEIGHT_M tall —
  // so the animation tuning below keeps driving the same numbers the procedural
  // part rig hard-coded, and only the way they are realised changes (bones and
  // 2-bone IK instead of rigidly placed part meshes).
  const body = useMemo(() => {
    const model = cloneSkeleton(glbPlayer.scene)
    model.traverse((child) => {
      if (!child.isMesh) return
      child.castShadow = true
      child.receiveShadow = true
      // The batter wears the helmet and grips the bat with bare hands, so the
      // cap and the gloves stay hidden (same choice the reference makes for its
      // offensive players).
      if (HIDDEN_MESHES.includes(child.name)) child.visible = false
    })
    const metrics = measurePlayerRig(model, { spriteNominalHeightM: SPRITE_NOMINAL_HEIGHT_M })
    // Snapshot the resting skeleton before the driver starts writing to it: the
    // animation is authored relative to the rest pose, and this is what it is
    // read from.
    const restPose = new Map()
    model.traverse((child) => {
      if (child.isBone) {
        restPose.set(child, {
          position: child.position.clone(),
          quaternion: child.quaternion.clone(),
        })
      }
    })
    return { model, metrics, restPose }
  }, [glbPlayer])
  const rig = body.metrics
  // How far apart the two fists grip the handle: the model's own spacing, one
  // number for the arms' targets, the bat's own hand markers and the JSX branch
  // below (see GRIP_SPLIT_FALLBACK).
  const gripSplit = rig.grip?.separation ?? GRIP_SPLIT_FALLBACK

  const batModel = useMemo(() => glbBat.scene.clone(true), [glbBat])

  // The bone driver needs the model mounted — it reads the live bones and the
  // frame the model sits in — so build it once the body is really in the scene.
  // Until then the batter simply renders in the skeleton's rest pose.
  //
  // Which node is mounted is held in state rather than read from a ref: the
  // component is rendered with no pitch at all until an at-bat arrives, and
  // player.glb can finish loading before that, so the commit that creates the
  // driver is not necessarily the commit that mounts the body. A ref would be
  // read once — empty — and the driver would never be built, leaving the model
  // in its rest pose while only the bat moved.
  const rigDriverRef = useRef(null)
  const [modelNode, setModelNode] = useState(null)

  // Where the model sits inside the batter's own frame, in the tuning's units:
  // shifted so its hip joints land on the frame's centreline, the way the
  // procedural pelvis did. The driver is told the same offset, because every
  // joint target it is handed is authored from the frame's origin.
  const bodyPlacement = useMemo(() => [0, 0, -rig.hip.z], [rig])

  useLayoutEffect(() => {
    if (!modelNode) return undefined
    rigDriverRef.current = createPlayerRig(body.model, body.metrics, body.restPose, bodyPlacement)
    return () => { rigDriverRef.current = null }
  }, [modelNode, body, bodyPlacement])

  // Collect every material the body and bat render with so a single per-frame
  // opacity update fades the whole batter together, the same pattern the catcher
  // uses. depthWrite is disabled only while fading so the strike-zone overlays
  // show through the batter; at full opacity the batter renders opaque with
  // normal depth.
  const allMaterials = useMemo(() => {
    const mats = new Set()
    for (const root of [body.model, batModel]) {
      root.traverse((child) => {
        if (!child.isMesh || !child.material) return
        const mList = Array.isArray(child.material) ? child.material : [child.material]
        for (const mat of mList) mats.add(mat)
      })
    }
    return Array.from(mats)
  }, [body, batModel])

  // Fade the batter when the camera is behind it (catcher side, +Z) and close
  // enough to block the strike zone; never fade when viewed from the front.
  useFrame(() => {
    const group = groupRef.current
    if (!group) return
    const behind = camera.position.z > group.position.z
    const distanceToCamera = camera.position.distanceTo(group.position)
    const fade = clamp((distanceToCamera - settings.fadeStartDistance) / (settings.fadeEndDistance - settings.fadeStartDistance), 0, 1)
    const opacity = behind
      ? settings.fadeMinOpacity + (1 - settings.fadeMinOpacity) * fade
      : 1
    for (const mat of allMaterials) {
      mat.opacity = opacity
      mat.transparent = opacity < 1
      mat.depthWrite = opacity >= 1
    }
  })
  // 0..1 strength of the head's lock onto the batted ball: ramps in at
  // contact and eases back out after the ball lands, so the head tracks the
  // flight but never snaps back to the stance look. ``lastBallLook`` holds
  // the last tracked direction while the lock fades out.
  const trackRef = useRef(0)
  const lastBallLook = useRef(null)

  const batSide = pitchData?.bat_side || 'R'
  const swing = !!pitchData?.swing
  const sign = batSide === 'L' ? -1 : 1

  // Scale the sprite from the batter's listed height (e.g. 5'11" = 1.80m),
  // then apply the cartoon visual scale-down. Falls back to a neutral size
  // when the feed omits the height. The same ratio scales body width, shoulder
  // radius, head, and bat (uniformly) plus the stance offsets below.
  const heightM = pitchData?.batter_height != null
    ? pitchData.batter_height * 0.0254
    : null
  const heightScale = (heightM != null ? heightM / SPRITE_NOMINAL_HEIGHT_M : 1) * BATTER_VISUAL_SCALE

  // The plate-tuned stance — the stance the animation was tuned at, and the
  // reference every angle below is read at — and the stance the body actually
  // stands at, set back from it along the line from home plate's own centre out
  // through the batter (see STANCE_SETBACK_M). That is the line the facing is
  // measured along, so stepping back down it leaves the plate exactly where it
  // was in the body's own frame: the facing, the swing's whole turn and the lean
  // over the plate stay the pose they were tuned as, and only the distance
  // changes. One offset covers the box's two directions, because on this line
  // they are one — deeper in the box *is* further off the plate.
  const plateCentreZ = -PLATE_FRONT_Y / 2
  const refStanceX = NOMINAL_STANCE_X_M * heightScale
  const refStanceZ = NOMINAL_STANCE_Z_M * heightScale
  const setbackScale = STANCE_SETBACK_M / (Math.hypot(refStanceX, refStanceZ - plateCentreZ) || 1)
  const stanceX = refStanceX * (1 + setbackScale)
  const stanceZ = plateCentreZ + (refStanceZ - plateCentreZ) * (1 + setbackScale)

  // The joint targets the animation computes are expressed inside the batter's
  // groups, which carry the torso's turn and lean, the hips' drive, and the
  // uniform height scale. The bone driver works in the tuning's own frame, so
  // this walks a point back out of the group it was computed in.
  const toRigFrame = (object, x, y, z) => {
    if (!object || !groupRef.current) return null
    groupRef.current.updateWorldMatrix(true, false)
    object.updateWorldMatrix(true, false)
    _groupInverse.copy(groupRef.current.matrixWorld).invert()
    const point = new THREE.Vector3(x, y, z)
      .applyMatrix4(object.matrixWorld)
      .applyMatrix4(_groupInverse)
    return [point.x / heightScale, point.y / heightScale, point.z / heightScale]
  }

  // The same walk for a *direction*: the bat's barrel line, read out of the
  // group it was authored in. The group the animation is authored in carries no
  // turn of its own (the batter's yaw is inside it), and a direction has no
  // length to scale, so only the group's rotation is applied.
  const toRigDir = (object, vec) => {
    if (!object || !groupRef.current) return null
    object.updateWorldMatrix(true, false)
    const dir = vec.clone().transformDirection(object.matrixWorld)
    return [dir.x, dir.y, dir.z]
  }

  // Left-handed batters stand on the first-base side (+X); right-handed
  // batters stand on the third-base side (-X). Behind home plate toward the
  // catcher is +Z. ``batX``/``stanceZ`` are where the body stands — what the
  // contact geometry and the world placement are read at — while ``refBatX``
  // with ``refStanceZ`` is the plate-tuned stance the angular pose is read at.
  const batX = batSide === 'L' ? stanceX : -stanceX
  const refBatX = batSide === 'L' ? refStanceX : -refStanceX

  // Hands in the set stance, at the back shoulder: the batter faces the
  // pitcher (-Z), so their left side is -X and their right side is +X. A lefty
  // loads the bat over the left shoulder (-X), a righty over the right (+X).
  const loadedHands = useMemo(
    () => [sign * LOADED_HANDS_X, LOADED_HANDS_Y, LOADED_HANDS_Z],
    [sign],
  )

  // The upper body opens toward the pitcher through the swing, rotating with
  // the handedness (a righty opens counter-clockwise from above, a lefty
  // clockwise — each unwinding across the plate from the set stance into the
  // pitch). The sign is negated from `sign` so the chest turns toward the
  // ball/plate (a lefty's chest swings to their left, a righty's to their
  // right); the head's extra yaw then rides on the body's turn to keep the
  // eyes on the ball instead of fighting it.
  const bodyOpen = -sign * settings.bodyOpenMax
  // Set stance: the body and legs face the spot between home plate and the
  // catcher — the midpoint of the plate -> catcher segment — rather than
  // turning a full half-turn to face the catcher directly. Standing off to one
  // side of the plate that direction is a diagonal (a righty's chest angles
  // toward first base, a lefty's toward third), and the swing rotates the body
  // from this pose around to the open contact pose facing the pitcher —
  // clockwise for a lefty, counter-clockwise for a righty — so the torso
  // unwinds across the plate into the pitch.
  // Both ends of the plate -> catcher segment are taken as *directions* from the
  // batter — to the plate's centre and to the catcher — and mixed by
  // settings.setFaceBias, rather than resolved to one point fixed in the world.
  // A fixed point only works while the batter stands in front of it, and the
  // swing's whole turn is measured from this yaw: standing 0.25 m deeper in the
  // box puts the batter level with that point, and the stance swung 34 degrees
  // round to face the pitcher, taking the swing's 90-degree body turn down to 56.
  // Mixed directions carry with the batter, so the stance keeps the turn it was
  // tuned at any depth in the box. The bias means what it always did: 0 faces
  // the plate's centre directly, 0.5 the plate -> catcher midpoint.
  // ...both ends read at the plate-tuned stance rather than where the body
  // stands, so the facing is the angle it was tuned as rather than a few degrees
  // round from it (see STANCE_SETBACK_M).
  const facePlateYaw = Math.atan2(refBatX, refStanceZ - plateCentreZ)
  const faceCatcherYaw = Math.atan2(refBatX, refStanceZ - FIELD.DEFENSE.C.z)
  const plateYaw = facePlateYaw + (faceCatcherYaw - facePlateYaw) * (1 - settings.setFaceBias)
  // The set stance's trunk is turned off that plate-facing yaw toward the
  // pitcher's line, which is the direction the arms are held toward at the load
  // (see ELBOW_FRONT_LOAD): the further the trunk faces away from the arms, the
  // more of the upper arm has to lie across the chest, and the more of it the
  // torso covers from the pitcher. The pelvis turns with it and by the same
  // amount, so the separation is taken off the arms' own angle rather than added
  // to the waist, and it is this yaw the whole swing is measured from — so the
  // body is already this far round before the stride, and comes back to it.
  const setYaw = plateYaw + (0 - plateYaw) * settings.stanceArmFacing

  // During the set the head turns to face the pitcher: the head's face is its
  // local -Z, so the yaw that points it at the pitcher (a tiny horizontal
  // offset off straight-down-the-line because the batter stands to one side)
  // is that direction expressed in the upper body's rotated frame. Through
  // the swing it eases from this look to tracking the ball at contact.
  const headPitcherYaw = Math.atan2(batX, stanceZ - FIELD.DEFENSE.P.z) - setYaw


  // All swing geometry derived from the trajectory: the contact point, the
  // hands-at-contact position, the barrel's contact angle, and the bat length
  // that puts the sweet spot on the ball.
  const geom = useMemo(() => {
    return calculateSwingGeometry({
      pitchData,
      batX,
      stanceZ,
      heightScale,
      sign,
      bodyOpen,
      loadedHands,
      settings,
      catcherZ: FIELD.DEFENSE.C.z,
      // The lean is posed about the plate-tuned stance, so the body tips over the
      // plate exactly as far and in exactly the direction it was tuned to (see
      // STANCE_SETBACK_M) — and the sweet spot lands on the ball either way,
      // because the animation is posed with the same reference.
      leanAt: { batX: refBatX, stanceZ: refStanceZ },
    })
  }, [pitchData, heightScale, batX, refBatX, refStanceZ, stanceZ, sign, loadedHands, bodyOpen, settings])

  // Solve the arms: upper arm shoulder->elbow, forearm elbow->hands. ``bend``
  // goes 1 (loaded, elbows out) to 0 (contact, arms straight). During the
  // swing (``align`` ramping to 1) the forearms rotate around the hands to
  // ride the bat's barrel line — so the bat swings WITH the forearms as one
  // unit instead of pivoting around the wrist — easing back through the
  // follow-through. Returns the elbow (the IK's bend hint) and the grip the
  // hand should end up on, per arm, in the tuning's frame.
  const updateArms = (
    hands,
    bend,
    align = 0,
    batAngle = sign * settings.loadedBaseAngle,
    cockAngle = settings.cockAngle,
    tiltAngle = 0,
    followProgress = 0,
    isRecovering = false,
    palmUp = 0,
  ) => {
    // The direction the pitch comes from, expressed in the upper body's own
    // (turned) frame — the frame the elbow hints below are authored in. "In
    // front of the chest" has to be the pitcher's line and not the way the stance
    // happens to face: the set stance faces the plate, which is broadside to the
    // pitcher, so the body's own forward points across the pitch.
    let front = null
    let up = null
    if (innerRef.current) {
      innerRef.current.updateWorldMatrix(true, false)
      innerRef.current.getWorldQuaternion(_armQuat)
      _armDir.set(0, 0, -1).applyQuaternion(_armQuat.invert())
      front = [_armDir.x, _armDir.y, _armDir.z]
      // The world's own up, in the same frame: the trailing arm's lane is taken
      // flat (see the lane in the loop), which needs to know which way is down.
      _armDir.set(0, 1, 0).applyQuaternion(_armQuat)
      up = [_armDir.x, _armDir.y, _armDir.z]
    }
    const barrel = batAxis(batAngle, cockAngle, tiltAngle)
    // Horizontal direction perpendicular to the barrel's ground projection,
    // used to keep the two forearms apart as they ride the bat line.
    const perp = [-barrel.z, 0, barrel.x]
    const targets = []
    for (const side of [-1, 1]) {
      // The shoulder ball the arm hangs off, in the tuning's body frame.
      const shoulder = [side * rig.shoulder.halfWidth, rig.shoulder.y, rig.shoulder.z]
      // In standard baseball mechanics:
      // The back arm (side === sign: right arm for righty, left arm for lefty)
      // grips higher up the handle toward the barrel (+gripSplit along barrel).
      // The lead arm (side === -sign: left arm for righty, right arm for lefty)
      // grips at the base of the handle resting against the knob (hands).
      const isBackArm = side === sign
      const isFrontArm = side === -sign
      // Both fists stay on the handle for the whole swing: the trail hand grips
      // gripSplit up it (the fists' own 0.253 rig of spacing) and the lead hand at
      // its base, which is what the suite's own grip tests read at every phase.
      const grip = isBackArm
        ? [
            hands[0] + gripSplit * barrel.x,
            hands[1] + gripSplit * barrel.y,
            hands[2] + gripSplit * barrel.z,
          ]
        : hands
      const mid = [
        (shoulder[0] + grip[0]) / 2,
        (shoulder[1] + grip[1]) / 2,
        (shoulder[2] + grip[2]) / 2,
      ]
      // Natural pose: elbows flared out at load, straightening by contact.
      // The cross-body (front) arm flares wider and rides further clear of the
      // chest so its forearm sweeps around the front of the torso while the
      // hands are loaded at the shoulder, instead of tunneling through it.
      //
      // The sign of that clearance term is the difference between an arm held
      // off the chest and one laid through it. Measured off the posed skin, the
      // lead arm's upper arm sat 0.042 rig *inside* the ribs at the loaded
      // stance with the term as ``- forward`` — the elbow pole pulled the bicep
      // toward the body's own back — and reads clear (nothing inside, the
      // nearest skin 0.069 rig away) with it as ``+ forward``. The pose is
      // authored in the body's turned frame, and in that frame the chest's
      // outward normal at the point of contact points this way.
      //
      // The flare is where the crossing arm clears the ribs, measured the same
      // way: at 0.3 the lead arm's bicep still reads 15 vertices inside the
      // trunk at the loaded stance, at 0.45 one does, and at 0.6 the elbow has
      // been carried so far out that the arm folds back onto the chest and there
      // are 14 again.
      const flare = isFrontArm ? 0.45 : 0.2
      const forward = isFrontArm ? 0.26 : 0.12
      const elbow = [
        mid[0] + side * flare * bend,
        mid[1] - 0.13 * bend,
        mid[2] + forward * bend,
      ]
      // ...and, at the load, further forward still along the chest's own facing:
      // the arms ride in front of the torso rather than tucked behind it, which
      // is what the loaded stance had them doing (see ELBOW_FRONT_LOAD).
      if (front) {
        const amount = ELBOW_FRONT_LOAD * bend * front[2]
        elbow[2] += amount
      }
      // Rotate the forearm direction from its natural one toward the barrel
      // (around the hands), and shorten it toward FOREARM_LEN, so the forearm
      // lines up with the bat as the swing comes through.
      const foreVec = new THREE.Vector3(grip[0] - elbow[0], grip[1] - elbow[1], grip[2] - elbow[2])
      const natLen = foreVec.length()
      let finalElbow = elbow
      if (natLen > 1e-4) {
        const natDir = foreVec.normalize()
        const swing = new THREE.Quaternion().setFromUnitVectors(natDir, barrel)
        const partial = new THREE.Quaternion().slerp(swing, align)
        const dir = natDir.clone().applyQuaternion(partial)
        const len = natLen + (FOREARM_LEN - natLen) * align
        finalElbow = [
          grip[0] - len * dir.x + side * ELBOW_SPREAD * align * perp[0],
          grip[1] - len * dir.y,
          grip[2] - len * dir.z + side * ELBOW_SPREAD * align * perp[2],
        ]
      }

      // Follow-through: upper arms actively lead and drag the forearms and bat along
      // so the forearms do not become crossed into an 'X' scissor.
      // Lead arm pulls back around ribs, while trail arm sweeps across chest dragging the forearm.
      if (followProgress > 0) {
        // Both elbows stay out of the trunk on the finish: the lead elbow in
        // front of the ribs rather than out beside them, and the trail elbow
        // across the chest but *in front* of it. Tucked behind the front surface
        // — where these were — the arm's own skin is inside the chest for the
        // whole follow-through and the first half of the recovery.
        //
        // The lead elbow used to be pinned out past the body's own half-width,
        // which is a shoulder turned square to the plate: the arm had to swing
        // out to the side to keep clear of the chest (measured, 0.51 of the
        // upper arm's length sideways against 0.77 forward). With the finish
        // turned into the pull side (settings.fullOpenYaw) the chest is out of
        // the way, so the elbow goes *forward* — the arm follows the body round
        // instead of cutting across it.
        // The lead elbow finishes *out* beside the shoulder rather than tucked in
        // toward the body's own midline. The arm folds over the chest either way —
        // that is what a follow-through is — and the bicep is what pays for it.
        //
        // This term is no longer load-bearing, and it is left at 0.50 knowing
        // that: the folded-forearm-into-the-belly collision it was added to fix
        // (22 of the trail forearm's 116 skin vertices inside the trunk at the
        // hold, 0.052 rig deep, at 0.15 of the half-width) is now kept clear by
        // the finish's own grip rather than by the elbow — at today's grip the
        // forearm reads 0 of 116 inside at every moment from 0.0 to 0.9 of the
        // half-width, and sweeping this term moves the elbow's outward line by
        // less than 0.03 (0.47 / 0.34 / 0.32 / 0.26 with it at 0.0, 0.47 / 0.31 /
        // 0.28 / 0.26 here). It is kept because it is where the elbow belongs:
        // out beside the shoulder, not on the arm's own chord.
        // The lead elbow also comes *down*: 0.40 below its own shoulder rather
        // than 0.18. It is the half of the two arms' clearance that costs
        // nothing to give — the elbow is out beside the shoulder either way, and
        // the ribs are what it was clearing — and it buys the pair the room they
        // run out of at the reset's crux. Measured over the whole way home, the
        // two arms' closest approach goes 0.057 to 0.113 rig with the elbow
        // here, and the lead arm's own direction reads -0.19 to -0.24 of the
        // upper arm's length below horizontal instead of -0.04 (see the elbows'
        // own test in the suite).
        let targetFollowElbow = isFrontArm
          ? [
              side * rig.shoulder.halfWidth * 0.50,
              rig.shoulder.y - 0.40,
              -0.5,
            ]
          : [
              // ...and *down*, most of the way to the ribs: left where it was,
              // the trail arm's elbow finished 0.44 of the upper arm's length
              // *above* its own shoulder — the trailing upper arm pointing at
              // the sky while the lead arm swung through underneath it (0.39 up
              // with everything else in this pose left as it is) — and was still
              // 0.35 above it at the late follow-through. At 0.42 below the
              // shoulder it reads 0.07 below it at the finish and 0.35 below it
              // at the late follow-through, and the elbow finds its own way down
              // and back from there.
              -side * 0.04,
              rig.shoulder.y - 0.42,
              // ...and *forward* of the ribs rather than alongside them: the
              // drive's own forward pitch (see DRIVE_LEAN) lays the trunk over
              // the trail upper arm as it comes across, and 0.14 rig more of
              // front carries the arm clear of it — measured at the late
              // follow-through and the hold, 7 and 6 of the upper arm's 230 skin
              // vertices inside the ribs at 0.033 and 0.021 rig against 11 and 13
              // at 0.039 and 0.041 with the elbow here.
              -0.60,
            ]
        // The trail arm on the way home. The finish leaves its elbow out in
        // front of the chest, and unwinding along that same path sends it
        // forward for the whole reset — measured half way through, 0.29 rig
        // units toward the pitcher with the forearm folded across the body, which
        // is an elbow pointing the wrong way round. A batter's trail elbow comes
        // *down and back* on the way to the load (away from the pitcher), so the
        // reset blends it toward its own natural hint with a push on the far side
        // of the shoulder-hand line instead of toward the finish.
        if (isRecovering && !isFrontArm) {
          const back = -0.22
          const home = [
            finalElbow[0] + (front ? front[0] * back : 0),
            finalElbow[1] - 0.1,
            finalElbow[2] + (front ? front[2] * back : 0),
          ]
          // Blended *in* rather than switched on at the reset's first frame: the
          // hold and the reset meet on one frame, and a target that changes
          // between them is a pose that jumps. Measured, the switch moved the
          // trail elbow's direction 1.40 rig between 0.82 s and 0.83 s — a
          // right-angle flick, the largest single-frame move in the whole pose.
          // A tenth of the way home is enough to spread it and short enough that
          // the elbow is on the far side of the shoulder-hand line from the
          // reset's own first frame: measured at a tenth of the window it reads
          // -0.026 rig along the line to the pitcher where the test's bound is
          // +0.01, against +0.025 with the blend still half-way at three tenths.
          const into = easeSwing(THREE.MathUtils.clamp((1 - followProgress) / 0.1, 0, 1))
          targetFollowElbow = [
            THREE.MathUtils.lerp(targetFollowElbow[0], home[0], into),
            THREE.MathUtils.lerp(targetFollowElbow[1], home[1], into),
            THREE.MathUtils.lerp(targetFollowElbow[2], home[2], into),
          ]
        }
        // The finish is where the lead forearm folds across the chest, and the
        // chord from an elbow out beside the ribs to a grip on the far side of
        // the body runs straight through the belly: measured, 48 of the lead
        // arm's skin vertices inside the trunk, 0.08 rig deep. Both elbows
        // therefore finish *in front of* the chest — on the pitch's side of it —
        // so the forearms sweep across the front of the body rather than through
        // it. See ELBOW_FRONT_FINISH.
        // It rides whichever hint is in play rather than being switched off with
        // the finish: gated on ``!isRecovering`` it moved the trail arm's own
        // target 0.34 rig in the one frame the reset starts on.
        if (front) {
          targetFollowElbow[0] += front[0] * ELBOW_FRONT_FINISH
          targetFollowElbow[1] += front[1] * ELBOW_FRONT_FINISH
          targetFollowElbow[2] += front[2] * ELBOW_FRONT_FINISH
        }
        // In forward follow-through, lead with upper arms so forearms don't scissor.
        // During recovery, unwrap smoothly so the upper arms lead the return and the torso
        // follows behind them rather than turning back while the arms are pinned.
        const fp = isRecovering
          ? easeSwing(followProgress)
          : (isFrontArm ? Math.sqrt(followProgress) : easeSwing(followProgress))
        finalElbow = [
          THREE.MathUtils.lerp(finalElbow[0], targetFollowElbow[0], fp),
          THREE.MathUtils.lerp(finalElbow[1], targetFollowElbow[1], fp),
          THREE.MathUtils.lerp(finalElbow[2], targetFollowElbow[2], fp),
        ]

        // The two arms come off the one handle, so each one is only ordered
        // against the other by where its elbow rides. Left to the hints, both
        // drift onto the bat's own line through the follow-through — measured at
        // 0.51 s the lead elbow sits 0.24 rig along the bat from its own hand,
        // where the trail hand grips (0.25 rig up the handle) — and the two arms
        // cross: the chains read 0.001 rig apart at 0.50 s with the forearms
        // passing through each other, and 0.004 rig apart at 0.99 s on the way
        // home with the trailing arm's elbow three centimetres short of the
        // leading arm's on the wrong side of the bat. Held apart they read 0.081
        // rig at their closest, over the whole swing and the whole way home, and
        // the trailing elbow never comes nearer the leading arm's own side of
        // the bat than 0.26 rig.
        //
        // It rides in on the same ramp as the finish above (``fp``), so each
        // elbow climbs out over the follow-through instead of stepping out on
        // the one frame the hold ends on, and the set stance — where the arms are
        // the pose they were tuned to — is untouched: this window starts at
        // contact, and the load before it is the natural hint. See
        // TRAIL_LANE_MIN and ELBOW_LADDER_MIN for the two rules themselves, and
        // ELBOW_LADDER_RELEASE for how the leading arm's own carry hands back
        // over the first tenth of a second of the reset.
        // The wrist's own floor, written into the pose first: the hint's forearm is
        // turned about the grip — inside the plane the barrel and the forearm share,
        // which is the smallest turn that changes the angle and the only one that
        // leaves the elbow's own out-of-plane placement alone — until its angle off
        // the barrel is inside the band a wrist can hold (see FOREARM_LEAN_MIN).
        //
        // It runs *before* the lanes and the ladder below, not after them, so the
        // rules that order the two arms against each other keep the last word: a
        // turn that satisfies the wrist by carrying one elbow over the other's own
        // side of the bat would be trading one guarantee for another. Each of those
        // rules can leave the forearm along the bat — the trail elbow's finish
        // target sits 0.60 rig in front of the ribs, which is a forearm swung
        // toward the barrel, and the lead's own carry does the same on the other
        // side — and what a rule about *where an elbow belongs* must not do is spend
        // the wrist to get there. The projection is a clamp on one angle, so it is
        // continuous where the hints are: no ramp, no switch, nothing to blend.
        {
          const chord = [
            grip[0] - finalElbow[0],
            grip[1] - finalElbow[1],
            grip[2] - finalElbow[2],
          ]
          const chordLen = Math.hypot(chord[0], chord[1], chord[2])
          if (chordLen > 1e-4) {
            const dir = [chord[0] / chordLen, chord[1] / chordLen, chord[2] / chordLen]
            const along = dir[0] * barrel.x + dir[1] * barrel.y + dir[2] * barrel.z
            const lean = Math.acos(THREE.MathUtils.clamp(along, -1, 1))
            const want = THREE.MathUtils.clamp(lean, FOREARM_LEAN_MIN, FOREARM_LEAN_MAX)
            if (Math.abs(want - lean) > 1e-6) {
              // The square part of the direction (what the turn actually moves) cut
              // back to the length the wanted angle asks for, plus the barrel's own
              // part at that angle: a unit vector either way, since the two parts
              // are sin and cos of the same angle.
              const square = [
                dir[0] - barrel.x * along,
                dir[1] - barrel.y * along,
                dir[2] - barrel.z * along,
              ]
              const squareLen = Math.hypot(square[0], square[1], square[2])
              if (squareLen > 1e-4) {
                const k = Math.sin(want) / squareLen
                const cos = Math.cos(want)
                const turned = [
                  square[0] * k + barrel.x * cos,
                  square[1] * k + barrel.y * cos,
                  square[2] * k + barrel.z * cos,
                ]
                finalElbow = [
                  grip[0] - chordLen * turned[0],
                  grip[1] - chordLen * turned[1],
                  grip[2] - chordLen * turned[2],
                ]
              }
            }
          }
        }
        const line = [grip[0] - shoulder[0], grip[1] - shoulder[1], grip[2] - shoulder[2]]
        const lineLen = Math.hypot(line[0], line[1], line[2])
        if (lineLen > 1e-3) {
          line[0] /= lineLen
          line[1] /= lineLen
          line[2] /= lineLen
          const at = [
            (shoulder[0] + grip[0]) / 2,
            (shoulder[1] + grip[1]) / 2,
            (shoulder[2] + grip[2]) / 2,
          ]
          // The body's own lateral axis (the shoulder line), square to the bat,
          // on this arm's own side of it. The trailing arm's lane is this axis
          // and nothing else: the two arms are ordered against each other around
          // the bat's own line, and the bat is what the hands are on, so a push
          // along it carries the elbow out over the leading arm without lifting
          // it — a push that lifts instead is a trail forearm pointing at the
          // sky, the pose the way-home test forbids. The leading arm's own carry
          // is taken square to that arm's chord instead, so it does not lengthen
          // the arm; it is a different question and gets its own rule below.
          const own = isBackArm ? 1 : -1
          const lateral = [1 - barrel.x * barrel.x, -barrel.x * barrel.y, -barrel.x * barrel.z]
          const lateralLen = Math.hypot(lateral[0], lateral[1], lateral[2]) || 1
          // This arm's own side of the body, taken *flat*: the body's own
          // lateral axis with the world's own up taken out of it, so a push
          // along it carries the elbow out around the bat without lifting it —
          // the trailing upper arm has to keep pointing *down* for the whole way
          // home, and the authored lateral axis leans with the batter, so it is
          // not flat on its own. Flattening is stable and cannot flip: the body's
          // lateral is never vertical, so its horizontal part is never nothing.
          const flat = up
            ? [1 - up[0] * up[0], -up[0] * up[1], -up[0] * up[2]]
            : [1, 0, 0]
          const flatLen = Math.hypot(flat[0], flat[1], flat[2]) || 1
          const lane = [
            (flat[0] / flatLen) * own,
            (flat[1] / flatLen) * own,
            (flat[2] / flatLen) * own,
          ]
          if (isBackArm) {
            // The trailing arm: out on its own side of the bat, over the top of
            // the leading arm, from the follow-through right through the way
            // home. See TRAIL_LANE_MIN.
            //
            // The carry is *ramped from where the pose already is*, not a floor
            // switched on: the contact frame is a pinned pose of its own (and the
            // set stance's arms are the ones the swing was tuned to), so the rule
            // is worth nothing there and has to say so. Spent as a floor scaled
            // by ``fp`` it still moved the elbow on the contact frame — where the
            // authored pose sits on the lead arm's side of the lane, a floor of
            // zero is itself a push — which the belt's own close-up caught as a
            // shifted baseline. Ramped from the authored offset it is exactly
            // nothing at contact and full where the arms need separating.
            const off =
              (finalElbow[0] - at[0]) * lane[0] +
              (finalElbow[1] - at[1]) * lane[1] +
              (finalElbow[2] - at[2]) * lane[2]
            const push = (Math.max(off, TRAIL_LANE_MIN) - off) * fp
            if (push > 1e-4) {
              finalElbow = [
                finalElbow[0] + lane[0] * push,
                finalElbow[1] + lane[1] * push,
                finalElbow[2] + lane[2] * push,
              ]
            }
          } else {
            // The leading arm's own carry, square to its own chord (see
            // ELBOW_LADDER_MIN).
            const along = (lateral[0] * line[0] + lateral[1] * line[1] + lateral[2] * line[2]) / lateralLen
            const away = [
              (lateral[0] / lateralLen - line[0] * along) * own,
              (lateral[1] / lateralLen - line[1] * along) * own,
              (lateral[2] / lateralLen - line[2] * along) * own,
            ]
            const awayLen = Math.hypot(away[0], away[1], away[2])
            if (awayLen > 1e-3) {
              const release = THREE.MathUtils.clamp((followProgress - ELBOW_LADDER_RELEASE) / 0.15, 0, 1)
              const off =
                ((finalElbow[0] - at[0]) * away[0] +
                  (finalElbow[1] - at[1]) * away[1] +
                  (finalElbow[2] - at[2]) * away[2]) /
                awayLen
              const ramp = fp * release
              const floor = ELBOW_LADDER_MIN * ramp - ELBOW_LADDER_SLACK * (1 - ramp)
              if (off < floor) {
                const push = (floor - off) / awayLen
                finalElbow = [
                  finalElbow[0] + away[0] * push,
                  finalElbow[1] + away[1] * push,
                  finalElbow[2] + away[2] * push,
                ]
              }
            }
          }
        }
      }

      // The forearms and hands live inside the torso group, so their targets
      // are read back out of it: the driver poses the skeleton, which does not
      // inherit the groups' transforms.
      targets.push({
        side,
        // Which arm is the *lead* one, for the driver's own rules about it: the
        // lead elbow is the one held under the flat the bat swings in (see the
        // arm solve in playerRig.js). The lead arm is the front one — the arm
        // that crosses the body to the knob end of the handle.
        lead: isFrontArm,
        elbow: toRigFrame(innerRef.current, finalElbow[0], finalElbow[1], finalElbow[2]),
        grip: toRigFrame(innerRef.current, grip[0], grip[1], grip[2]),
        // The bat's own handle -> barrel direction, so the driver can turn each
        // fist to close around the handle it is being put on.
        axis: toRigDir(innerRef.current, barrel),
        // How much of each fist's roll is held off the arm's own reach and onto
        // "the back of the palm faces the sky" (see fistRotation). The swing
        // takes none of it — a wrist rolls with the swing it is driving — and
        // the finish and the way home take all of it: that window is one pose
        // held in front of the chest, unwinding, and the reach direction there
        // is what rolled the wrist the whole way over between the finish and the
        // load. It eases back to the hand's own roll over the last of the reset,
        // so the set stance is exactly the pose it was.
        palmUp: isBackArm
          ? palmUp
          : (isRecovering ? Math.min(palmUp, PALM_HELD_FRONT) : palmUp),
        // Whether this share is a *held* roll: it is over the whole way home,
        // where the pose is one the hands are put into and unwound out of, and
        // not while the swing is driving (see fistRotation).
        palmHeld: isRecovering,
      })
    }
    return targets
  }

  // Pose the legs for the given drives (0 = loaded crouch, 1 = full push),
  // the pre-swing weight shift ``load``, and the late-windup front stride:
  // ``stride`` (0..1) advances the front foot toward the pitcher in step with
  // the tail of the pitcher's windup and ``strideLift`` (0..1) is the transient
  // foot/knee lift that peaks mid-step so the foot plants just as the swing
  // fires.
  // During the load the back leg crouches deeper and the hips settle lower to
  // take the weight; on the drive the back leg (the side away from the
  // pitcher — the right leg for a righty, `sign`) unbends and pushes, driving
  // the entire swing, while the front leg stays bent to brace the rotation.
  // The back leg eases back to the crouch later than the front leg (driveBack
  // lags through the recovery).
  const poseLegs = (drive, driveBack, load, stride, strideLift, lowerYaw) => {
    // Where the measured skeleton's joints sit at rest, in the tuning's frame:
    // the knee and ankle targets are authored as heights, so they are hung off
    // the rig's own hip and ankle instead of the procedural rig's constants.
    const hipHalfWidth = rig.hip.halfWidth
    const restKneeY = rig.hip.y - rig.leg.thigh
    const restAnkleY = rig.ankleY
    // The feet are authored in the batter's own frame — the one the plate and
    // the box are drawn in — and not in the lower body's turning one. A footprint
    // does not swing round with the hips: the batter steps at the front line,
    // plants there, and pivots on the foot. Authoring them in the hips' frame is
    // what slid the feet across the plate (see the drive's own note in
    // playerRig.js): a stance spot expressed in a frame that turns 80 degrees
    // through the swing walks, and it walks into the strike zone.
    const sinS = Math.sin(setYaw)
    // The set stance's own footprint: how *deep* each foot stands, taken from the
    // tuning's ankle offset turned by the stance's yaw into the batter's frame.
    // Only the depth comes from it. Both feet are then put on the batter's own
    // centreline — the line running straight at the front line — which is the
    // squared stance. The turned footprint, left to itself, staggers the feet
    // *sideways* as well, each foot under its own hip socket under a stance that
    // faces the plate: the front foot stood nearer the plate than the back one,
    // and a step between two such footprints has to be a diagonal to land the two
    // on one line. That sideways part of the step is the one that carried the
    // batter's foot across the box and in toward the plate. Squared, the stride is
    // straight at the front line, and the body reads perpendicular to that line
    // before the step and after it.
    const stanceFoot = (side) => {
      const x = side * hipHalfWidth
      return { x: 0, z: -x * sinS + SET_ANKLE_Z * Math.cos(setYaw) }
    }
    const backStance = stanceFoot(sign)
    const frontStance = stanceFoot(-sign)
    // The step: straight at the front line (the rig's own -Z) and nothing else —
    // the front foot keeps the line it is squared on, so the stride is exactly
    // perpendicular to the front line.
    const landX = frontStance.x
    const landZ = frontStance.z - settings.legFrontStride
    const cosL = Math.cos(lowerYaw)
    const sinL = Math.sin(lowerYaw)
    // The body's own forward direction, in the batter's frame: the direction the
    // legs bend in, at the yaw the hips have turned to.
    const forwardX = -sinL
    const forwardZ = -cosL
    const openAngle = lowerYaw - setYaw
    const targets = []
    for (const side of [-1, 1]) {
      const isBack = side === sign
      const d = isBack ? driveBack : drive
      const backCrouch = isBack ? settings.legBackLoadDrop * load : 0
      const stance = isBack ? backStance : frontStance
      // Where this foot is planted: held, all swing long, in the batter's frame.
      let footX = stance.x
      let footZ = stance.z
      // How much of the body's forward drive this foot takes with it: the front
      // foot rides the lunge forward (it is the one stepping), and the back foot
      // is the pivot it all turns on, so it stays where it was planted.
      let carry = 0
      // The front foot lifts clearly while striding (windup), then plants as
      // the stride completes; it unplants again briefly as the swing fires.
      let ankleLift = isBack ? 0 : settings.legFrontStrideLift * strideLift
      let shoeYaw
      if (isBack) {
        // Back foot: the planted pivot. Only the tuning's own push moves it, and
        // that is the leg extending, forward along the line it is planted on.
        footZ -= settings.legBackPushForward * d
        shoeYaw = -(1 - settings.backFootPivot) * openAngle
      } else {
        footX = THREE.MathUtils.lerp(frontStance.x, landX, stride)
        footZ = THREE.MathUtils.lerp(frontStance.z, landZ, stride)
        footZ -= settings.legFrontPushForward * d
        carry = 1
        shoeYaw = -(1 - settings.frontFootPivot) * openAngle
        ankleLift += settings.legFrontUnplantLift * drive
      }
      // The hips settle lower during the load, rising back as the drive
      // engages — carried by the torso group's height offset in the frame loop,
      // which the driver applies to the hips themselves.
      const kneeY = restKneeY
        + (isBack ? settings.legBackKneeRise : settings.legFrontKneeRise) * d
        - backCrouch
        + (isBack ? 0 : settings.legFrontKneeLift * strideLift * (1 - d))
      // The knee's bend hint: half way up the line from the hip socket to the
      // foot, pushed forward along the direction the body is facing. Anchored to
      // the *foot* rather than to the hips, so the leg's own plane turns with the
      // foot it is planted on instead of with the pelvis above it.
      const hipX = side * hipHalfWidth * cosL
      const hipZ = -side * hipHalfWidth * sinL
      const bend = 0.08 + (isBack ? settings.legBackKneeForward : settings.legFrontKneeForward) * d
      targets.push({
        side,
        knee: [
          (hipX + footX) / 2 + forwardX * bend,
          kneeY,
          (hipZ + footZ) / 2 + forwardZ * bend,
        ],
        ankle: [footX, restAnkleY + ankleLift, footZ],
        footYaw: lowerYaw + shoeYaw,
        carry,
      })
    }
    return targets
  }

  // Restart the playback clock whenever a new pitch arrives, keeping the swing
  // Reset tracking and look state whenever a new pitch arrives or replay fires.
  useLayoutEffect(() => {
    trackRef.current = 0
    lastBallLook.current = null
  }, [pitchData, replayKey])

  useFrame((state, delta) => {
    const { time: currentSimTime } = stepSimulation(delta, state.clock.elapsedTime)
    const traj = pitchData?.trajectory
    const simDuration = traj?.[traj.length - 1]?.t

    if (!(simDuration > 0) || !batGroupRef.current) {
      // No usable trajectory: hold the set stance with the idle bob.
      const swayPhase = state.clock.elapsedTime * settings.swaySpeed
      const bob = Math.sin(swayPhase) * settings.swayBobAmount
      if (upperRef.current) {
        // YXZ order: yaw first, then the lean's forward/sideways tilts, so the
        // lean direction (rotation.x/z) stays in the body's own frame.
        upperRef.current.rotation.order = BATTER_LEAN_ORDER
        upperRef.current.rotation.y = setYaw
        // Straight in the set stance: the forward lean only comes in as the
        // pitch is thrown.
        upperRef.current.rotation.z = 0
        upperRef.current.rotation.x = 0
        upperRef.current.position.z = 0
        upperRef.current.position.y = HIP_Y + bob
      }
      if (headRef.current) {
        headRef.current.rotation.x = 0
        headRef.current.rotation.y = headPitcherYaw
      }
      trackRef.current = 0
      lastBallLook.current = null
      const stanceLegs = poseLegs(0, 0, 0, 0, 0, setYaw)
      if (batGroupRef.current) {
        batGroupRef.current.position.set(...loadedHands)
        batGroupRef.current.rotation.y = sign * settings.loadedBaseAngle
      }
      if (cockRef.current) cockRef.current.rotation.x = settings.cockAngle
      if (tiltRef.current) tiltRef.current.rotation.x = 0
      const stanceArms = updateArms(loadedHands, 1)
      if (handLRef.current && handRRef.current) {
        if (sign === 1) {
          handLRef.current.position.set(-0.01, 0, 0)
          handRRef.current.position.set(0.01, 0, -gripSplit)
        } else {
          handLRef.current.position.set(-0.01, 0, -gripSplit)
          handRRef.current.position.set(0.01, 0, 0)
        }
      }
      // Same pose, onto the measured skeleton: straight up, facing the set
      // direction, bobbing, with the bat-hand grip the arms were solved onto.
      if (rigDriverRef.current) {
        rigDriverRef.current.applyPose({
          hip: { yaw: setYaw, leanX: 0, leanZ: 0, offsetY: bob, offsetZ: 0 },
          torsoYawExtra: 0,
          torsoOffsetZ: 0,
          head: { yaw: headPitcherYaw, pitch: 0 },
          legs: stanceLegs,
          arms: stanceArms,
        })
      }
      return
    }

    // Swing phases driven by the real-time clock, each eased with smoothstep:
    //   l: load, shifting the weight onto the back leg for settings.loadTime s before
    //      the swing (holds through contact, eases back with the recovery)
    //   e: swing, from settings.swingLead s before contact up to contact
    //   f: follow-through, settings.followThrough s after contact
    //   hold: holds the finish pose at the swing plane for settings.followHold s
    //   r: recovery, easing back to the loaded stance over settings.recoveryTime while
    //      the batted ball is in flight (ready for the next pitch of the cycle)
    const swingStart = geom.contactTime - settings.swingLead
    const loadStart = swingStart - settings.loadTime
    const followEnd = geom.contactTime + settings.followThrough
    const holdDuration = settings.followHold ?? 0.28
    const holdEnd = followEnd + holdDuration
    const recoverEnd = holdEnd + settings.recoveryTime
    // The pitcher's windup — mapped onto the post-contact window of the
    // shared cycle so the release lands exactly on the wrap (the same timing
    // the Pitcher component uses) — is when the batter starts his stride and
    // lean-in. Use the same trajectory end time the Pitcher uses as its
    // contact anchor so the two start on the exact same frame.
    const loopDuration = getCycleDuration()
    const trajEnd = traj[traj.length - 1]?.t ?? 0
    const windupStart = Math.max(trajEnd, loopDuration - getBallReleaseTime())
    const windupDur = Math.max(loopDuration - windupStart, 0.01)

    const followSlope = SWING_EASE * (settings.followThrough / settings.swingLead)
    // The follow-through's own clock: one Hermite that leaves the contact frame on the
    // swing's own speed (`followSlope`, in its own units) and arrives on the finish
    // slower, at FOLLOW_ARRIVAL of its own average slope -- and slower at *every* frame
    // between, because with `followSlope` above its Hermite's own second derivative is
    // negative across the whole span (measured through the throw: the bat's own speed
    // now falls from the contact frame's peak instead of climbing to a second one at
    // 0.49 s). It used to be a smoothstep in the middle, which peaks at *its* own
    // half-way point -- a tenth of a second after the ball -- and that is where the
    // swing's fastest frame used to be.
    const followEase = (y) => hermite(0, followSlope, 1, FOLLOW_ARRIVAL, y)

    let load = 0
    let e = 0
    let f = 0
    let r = 0
    if (swing) {
      if (currentSimTime >= loadStart && currentSimTime < swingStart) {
        load = easeSwing((currentSimTime - loadStart) / settings.loadTime)
      } else if (currentSimTime >= swingStart && currentSimTime < geom.contactTime) {
        e = swingProgress((currentSimTime - swingStart) / settings.swingLead)
      } else if (currentSimTime >= geom.contactTime && currentSimTime < followEnd) {
        f = followEase((currentSimTime - geom.contactTime) / settings.followThrough)
      } else if (currentSimTime >= followEnd && currentSimTime < holdEnd) {
        f = 1
      } else if (currentSimTime >= holdEnd && currentSimTime < recoverEnd) {
        r = easeSwing((currentSimTime - holdEnd) / settings.recoveryTime)
      }
    }
    // The load's weight shift (back-leg crouch, hip settle, settled lean)
    // holds through the swing and eases back out as the legs recover. The
    // front stride is driven separately by the pitcher's windup below.
    if (swing && currentSimTime >= swingStart && currentSimTime < holdEnd) load = 1
    if (swing && currentSimTime >= holdEnd && currentSimTime < recoverEnd) load = 1 - r

    // The forward lean starts on the exact frame the pitcher starts his
    // windup and ramps linearly across the windup window, reaching full just
    // as the ball leaves the pitcher's hand at the wrap — the lean-in leads
    // the front stride, which is timed separately below so it plants into
    // the swing.
    const leanRamp = currentSimTime >= windupStart
      ? clamp((currentSimTime - windupStart) / windupDur, 0, 1)
      : 0

    // Front-foot stride — delayed so it flows into the swing. The body lean
    // starts the moment the windup starts (above), but the step itself waits
    // until the pitcher is almost done with his windup (strideDelayFrac of
    // the way through it) and then steps quickly, planting as the swing
    // fires: the foot lifts mid-step and plants just as the hips drive, so
    // the stride runs straight into the swing instead of completing early
    // and waiting. The step's progress is computed across the cycle wrap
    // (the step starts before the wrap and finishes just after it), so the
    // foot never snaps back when the clock rolls over. After the swing the
    // foot eases back to the stance during the recovery (or just after the
    // pitch for a take), ready for the next windup.
    let stride = 1
    let strideLift = 0
    // Hoisted step progress (0-1 across the step window, wrap-safe) so the
    // stride-edge push below can ride the same ramp it begins on.
    let ramp = 0
    // Planted through the flight / swing; ease back during the recovery.
    if (swing) {
      if (currentSimTime >= holdEnd) {
        stride = currentSimTime < recoverEnd ? 1 - r : 0
      }
    } else {
      const takeSettleEnd = geom.contactTime + settings.leanOutTime
      if (currentSimTime >= takeSettleEnd) {
        stride = Math.max(0, 1 - easeSwing((currentSimTime - takeSettleEnd) / settings.leanOutTime))
      }
    }
    // The delayed step itself: from late in the windup to just before the
    // swing fires (swingStart of the next cycle, past the wrap).
    const strideStart = windupStart + settings.strideDelayFrac * windupDur
    const strideDur = Math.max(0.2, swingStart + loopDuration - strideStart)
    let sinceStride = currentSimTime - strideStart
    if (sinceStride < 0) sinceStride += loopDuration
    if (sinceStride <= strideDur) {
      ramp = easeSwing(sinceStride / strideDur)
      stride = ramp
      // Lift only while the foot is actually stepping (0 at start and plant).
      strideLift = Math.sin(Math.PI * ramp)
    }

    // Forward lean-in, driven by the windup progress above: the batter
    // stands straight while waiting, leans forward as the pitcher winds up
    // (leading the delayed front step), holds it through the flight and
    // swing, and eases back to straight after the recovery. Independent of
    // the swing flag, so it also applies to takes.
    let leanIn
    if (currentSimTime >= windupStart) {
      leanIn = leanRamp
    } else if (currentSimTime < loadStart) {
      leanIn = 1
    } else if (currentSimTime >= recoverEnd) {
      const sinceRecover = currentSimTime - recoverEnd
      leanIn = 1 - easeSwing(sinceRecover / settings.leanOutTime)
    } else {
      leanIn = 1
    }

    // The torso turns back to the set stance *with* the shoulders and the arms,
    // on the very clock they ride, rather than behind them. Handing the torso a
    // late start of its own (the old behaviour, settings.torsoRecoverLag of the
    // window spent holding the pull-side turn while the arms and the bat unwound
    // first) is not a lag the body can produce: the arms are solved onto a bat
    // whose grip rides the arms' clock, so with the chest still turned open the
    // hands folded in to the body's own midline — the grip came within 0.075 rig
    // units of the hip centreline, i.e. into the torso — and read as the
    // shoulders twisting off the chest on the way home. The chain unwinds in the
    // order it fired, all of it at once; settings.torsoRecoverLag is left as the
    // fraction of the window the torso may start late, and it is 0.
    const torsoRecoverLag = settings.torsoRecoverLag ?? 0
    const linearRecover = THREE.MathUtils.clamp(
      (currentSimTime - holdEnd) / settings.recoveryTime,
      0,
      1,
    )
    const torsoEase = swing
      ? easeSwing(THREE.MathUtils.clamp((linearRecover - torsoRecoverLag) / (1 - torsoRecoverLag), 0, 1))
      : 0

    // How open the upper body / head is: ramps up through the swing, holds
    // through the follow-through and hold window, and eases back during recovery.
    let open = 0
    if (swing) {
      if (currentSimTime < geom.contactTime) open = e
      else if (currentSimTime < holdEnd) open = 1
      else if (currentSimTime < recoverEnd) open = 1 - torsoEase
    }

    // The torso opens ahead of the hands during the pre-contact window (the
    // barrel catches up exactly at contact), then rides the same
    // follow-through/hold/recovery as the rest of the swing. This is the kinetic
    // chain: back foot/hips fire first (settings.hipsLead), then the body turn, then
    // the hands.
    let bodyTurn = 0
    if (swing) {
      if (currentSimTime < geom.contactTime) bodyTurn = THREE.MathUtils.clamp(e * settings.bodyTurnLead, 0, 1)
      else if (currentSimTime < holdEnd) bodyTurn = 1
      else if (currentSimTime < recoverEnd) bodyTurn = 1 - torsoEase
    }

    // How strongly the forearms ride the bat's barrel line: full once the
    // swing is most of the way through (so the bat visibly swings WITH the
    // forearms into contact), easing back off through the follow-through.
    let align = 0
    if (swing) {
      if (currentSimTime < geom.contactTime) align = THREE.MathUtils.clamp(e / 0.4, 0, 1)
      else if (currentSimTime < followEnd) align = 1 - f
    }

    // The upper body opens toward the pitcher as the swing progresses, while a
    // slow idle bob raises and lowers the loaded stance (fading out while the
    // swing is active so the two don't fight).
    const swayPhase = state.clock.elapsedTime * settings.swaySpeed
    const bob = Math.sin(swayPhase) * settings.swayBobAmount * (1 - open)
    // Hips lead the shoulders: the lower body's opening progress is
    // phase-advanced (settings.hipsLead) so the legs start turning before the upper
    // body — the kinetic chain of a real swing, with the hips firing first
    // and the torso catching up by contact.
    const lowerOpenYaw = setYaw + (bodyOpen - setYaw) * settings.lowerBodyOpenFactor
    const lowerOpen = THREE.MathUtils.clamp(open * settings.hipsLead, 0, 1)
    // The legs drive with the same phase-advanced progress: the knees
    // straighten from the bent crouch and the feet push toward the plate as
    // the swing fires, with a forward lean selling the weight transfer.
    const drive = lowerOpen
    // The back leg recovers to the crouch slightly later than the front leg:
    // through the first settings.backRecoverLag of the recovery it holds its
    // extended drive, then eases back after the front leg has already settled.
    let driveBack = drive
    if (swing && r > 0) {
      const rBack = THREE.MathUtils.clamp((r - settings.backRecoverLag) / (1 - settings.backRecoverLag), 0, 1)
      driveBack = THREE.MathUtils.clamp((1 - rBack) * settings.hipsLead, 0, 1)
    }

    // Body rotation through the swing: the upper body opens toward the
    // pitcher up to contact (bodyOpen), keeps turning through the
    // follow-through into the pull side to match the elbows (fullBodyYaw),
    // softly extends as the swing decelerates, then unwinds back to the
    // set stance during recovery. The hips ride the same arc at a fraction
    // of the rotation (settings.lowerBodyOpenFactor), phase-advanced to lead
    // the shoulders into the swing.
    // ``settings.fullOpenYaw`` is how far the chest is *short* of the pitcher's
    // line at the end of the follow-through, in the same units and on the same
    // side as settings.bodyOpenMax (the contact turn): a smaller number than the
    // contact's keeps the swing opening, 0 puts the chest on the pitcher's line,
    // and a negative one carries it past him. It used to be read as a magnitude
    // and always subtracted, which put the finish *short* of the contact turn —
    // measured, the chest went back from 21 into the pitcher at contact to 37
    // at the finish, so the swing stalled and then closed up at exactly the
    // moment a real batter's body is still opening.
    const fullOpenAmount = typeof settings.fullOpenYaw === 'number' ? settings.fullOpenYaw : 0.95
    const fullBodyYaw = -sign * fullOpenAmount
    // The hold drifts a little further open — the deceleration of a real swing,
    // which keeps turning for a beat after the contact speed has gone.
    const peakBodyYaw = fullBodyYaw + sign * 0.08
    // The pelvis's own finish: the same turn the chest takes, times how much of
    // it the hips are given at the follow-through (settings.followLowerOpenFactor)
    // — not the fraction that leads the shoulders into contact, which is a
    // different number about a different part of the swing.
    const lowerFollowFactor = settings.followLowerOpenFactor > 0
      ? settings.followLowerOpenFactor
      : settings.lowerBodyOpenFactor
    const hipFullOpenYaw = setYaw + (fullBodyYaw - setYaw) * lowerFollowFactor
    const peakLowerYaw = hipFullOpenYaw + sign * 0.05
    let bodyYaw = setYaw
    let lowerYaw = setYaw
    if (swing) {
      if (currentSimTime < geom.contactTime) {
        bodyYaw = THREE.MathUtils.lerp(setYaw, bodyOpen, bodyTurn)
        lowerYaw = THREE.MathUtils.lerp(setYaw, lowerOpenYaw, lowerOpen)
      } else if (currentSimTime < followEnd) {
        bodyYaw = THREE.MathUtils.lerp(bodyOpen, fullBodyYaw, f)
        lowerYaw = THREE.MathUtils.lerp(
          lowerOpenYaw,
          hipFullOpenYaw,
          THREE.MathUtils.clamp(f * settings.hipsLead, 0, 1),
        )
      } else if (currentSimTime < holdEnd) {
        const holdFrac = Math.min(1, Math.max(0, (currentSimTime - followEnd) / holdDuration))
        const extendFrac = Math.min(1, holdFrac / 0.65)
        const extendEase = 1 - Math.pow(1 - extendFrac, 2)
        bodyYaw = THREE.MathUtils.lerp(fullBodyYaw, peakBodyYaw, extendEase)
        lowerYaw = THREE.MathUtils.lerp(hipFullOpenYaw, peakLowerYaw, extendEase)
      } else if (currentSimTime < recoverEnd) {
        bodyYaw = THREE.MathUtils.lerp(peakBodyYaw, setYaw, torsoEase)
        lowerYaw = THREE.MathUtils.lerp(peakLowerYaw, setYaw, torsoEase)
      }
    }
    // The push envelope drives the hips forward (settings.hipDriveForward) and the
    // upper body's smaller push (settings.upperDriveForward).
    const settleStart = geom.contactTime - settings.pushSettleTime
    let push = 0
    if (swing) {
      // Whole-body forward push: ONE continuous accelerating motion from the
      // start of the delayed front step through the swing, not two
      // constant-speed stages (a slow smoothstep hump during the stride that
      // stops at the plant, then a fast one for the swing). The stride phase
      // is a quadratic ramp — velocity builds from zero with no long flat
      // middle, reaching settings.strideEdgeFrac (30%) of the full drive the
      // moment the foot plants. The swing phase hands off AT that speed (no
      // pause at the plant) and keeps accelerating as a cubic: velocity peaks
      // around the mid-swing, then decelerates smoothly to zero by the settle
      // start, where the smoothstep settle-back (1 -> settings.pushSettleLevel,
      // held through contact and eased out on recovery) takes over. Every
      // handoff is position- and velocity-continuous, so the approach reads
      // as one smooth flow that simply gets faster and faster into the bat;
      // the contact push stays exactly settings.pushSettleLevel, keeping the
      // contact geometry's compensation exact.
      const approachDur = strideDur + Math.max(1e-3, settleStart - swingStart)
      // Wrap-safe progress across the whole approach (stride start past the
      // cycle wrap to the settle start) — same construction as the stride.
      let sinceApproach = currentSimTime - strideStart
      if (sinceApproach < 0) sinceApproach += loopDuration
      if (sinceApproach <= approachDur) {
        const u = sinceApproach / approachDur
        const u1 = THREE.MathUtils.clamp(strideDur / approachDur, 1e-3, 0.999)
        if (u <= u1) {
          // Stride phase: accelerating quadratic (velocity 0 at the start of
          // the step, climbing through the plant).
          push = settings.strideEdgeFrac * (u / u1) * (u / u1)
        } else {
          // Swing phase: velocity continues from the plant (v1) and keeps
          // accelerating to a peak placed at settings.swingPeakFrac (or auto-
          // resolved from pitch speed when 0: faster pitches shift the peak
          // later so the maximal surge syncs closer to contact), then
          // decelerates to zero, ready for the smoothstep settle-back. Two
          // smoothstep velocity segments stitched at the peak keep the
          // velocity curve — and its slope — continuous everywhere; the peak
          // height is forced by the fixed displacement (the body still reaches
          // exactly full push at the settle start), so a later peak reads as a
          // sharper surge closer to contact.
          const s = (u - u1) / (1 - u1)
          const t2 = (1 - u1) * approachDur
          const v1 = 2 * settings.strideEdgeFrac / (u1 * approachDur)
          const pitchSpeed = resolvePitchSpeedMph(pitchData)
          const swingPeak = resolveSwingPeak(settings.swingPeakFrac, pitchSpeed)
          // Peak velocity chosen so the area under the velocity curve adds
          // exactly (1 - strideEdgeFrac) of push by the settle start.

          const vPeak = 2 * (1 - settings.strideEdgeFrac) / t2 - swingPeak * v1
          // Anti-derivative of the smoothstep ∫g = y³ − y⁴/2, used to
          // integrate the velocity segments in closed form below.
          const smoothInt = (y) => y * y * y - (y * y * y * y) / 2
          if (s <= swingPeak) {
            // Accelerating segment: v1 -> vPeak.
            push = settings.strideEdgeFrac + t2 * (
              v1 * s + (vPeak - v1) * swingPeak * smoothInt(s / swingPeak)
            )
          } else {
            // Decelerating segment: vPeak -> 0.
            push = settings.strideEdgeFrac + t2 * (
              swingPeak * (v1 + vPeak) / 2
              + vPeak * (s - swingPeak)
              - vPeak * (1 - swingPeak) * smoothInt((s - swingPeak) / (1 - swingPeak))
            )
          }
        }
      } else if (currentSimTime >= settleStart && currentSimTime < geom.contactTime) {
        push = THREE.MathUtils.lerp(
          1,
          settings.pushSettleLevel,
          easeSwing((currentSimTime - settleStart) / settings.pushSettleTime),
        )
      } else if (currentSimTime >= geom.contactTime && currentSimTime < recoverEnd) {
        // ONE continuous post-contact arc — no dead hold, no separate
        // ease-out stage. The body flows THROUGH contact: it rides gently
        // forward (a smoothstep bump, cresting about when the bat's own
        // follow-through completes) and then returns to the stance in a
        // single motion that accelerates to a peak backward speed at
        // settings.returnPeakFrac through the arc and decelerates to rest.
        // Three smoothstep velocity segments stitched at zero slope keep
        // position, velocity, and the feel of one flow; the arc starts
        // exactly at settings.pushSettleLevel (contact) and lands exactly
        // on zero (stance) with no velocity steps anywhere.
        const span = recoverEnd - geom.contactTime
        const u = (currentSimTime - geom.contactTime) / span
        const uFinish = THREE.MathUtils.clamp(settings.followThrough / span, 0.05, 0.5)
        const uPeak = THREE.MathUtils.clamp(settings.returnPeakFrac, 0.15, 0.85)
        // Finish ride: a crest of ~+0.02 of push above the settle level,
        // spread across the bat's follow-through window.
        const vFinish = 2 * 0.02 / uFinish
        // Return peak speed chosen so the arc's total displacement is
        // exactly -pushSettleLevel (down to zero at the stance).
        const vReturn = (vFinish * uPeak + 2 * settings.pushSettleLevel) / (1 - uFinish)
        // Anti-derivative of the smoothstep ∫g = y³ − y⁴/2.
        const smoothInt = (y) => y * y * y - (y * y * y * y) / 2
        if (u <= uFinish) {
          // Finish ride: 0 -> vFinish.
          push = settings.pushSettleLevel + vFinish * uFinish * smoothInt(u / uFinish)
        } else if (u <= uPeak) {
          // Accelerating return: vFinish -> -vReturn.
          push = settings.pushSettleLevel + vFinish * uFinish / 2
            + vFinish * (u - uFinish)
            - (vFinish + vReturn) * (uPeak - uFinish) * smoothInt((u - uFinish) / (uPeak - uFinish))
        } else {
          // Decelerating return: -vReturn -> 0.
          push = settings.pushSettleLevel + vFinish * uFinish / 2
            + (vFinish - vReturn) * (uPeak - uFinish) / 2
            - vReturn * (u - uPeak)
            + vReturn * (1 - uPeak) * smoothInt((u - uPeak) / (1 - uPeak))
        }
      }
    } else {
      // Takes get the same edge — the batter strides into the pitch and rides
      // it forward — but with no swing ride-up to hand off to, the edge holds
      // at full through the pitch crossing, then eases back out once the ball
      // passes (the same leanOutTime window the front foot uses to relax: the
      // body returns first while the foot holds its plant, then the foot
      // steps back). No bat meets the ball, so this is independent of the
      // swing's contact compensation.
      const takeEdgeEnd = geom.contactTime + settings.leanOutTime
      if (sinceStride <= strideDur) {
        push = settings.strideEdgeFrac * ramp
      } else if (currentSimTime < geom.contactTime) {
        push = settings.strideEdgeFrac
      } else if (currentSimTime < takeEdgeEnd) {
        push = settings.strideEdgeFrac * (1 - easeSwing((currentSimTime - geom.contactTime) / settings.leanOutTime))
      }
    }
    const hipDrive = (settings.hipDriveForward * push) / heightScale
    // The same numbers the groups below carry, collected for the measured
    // skeleton (which the groups do not move): the hips' turn and drive, the
    // torso's extra turn and its own drive, and the head's look.
    let leanX = 0
    let leanZ = 0
    let upperOffsetZ = 0
    let headYaw = 0
    let headPitch = 0
    if (upperRef.current) {
      // YXZ order: yaw first, then the lean's forward/sideways tilts, so the
      // lean direction (rotation.x/z) stays in the body's own frame.
      upperRef.current.rotation.order = BATTER_LEAN_ORDER
      upperRef.current.rotation.y = bodyYaw
      // The lean always faces the midpoint of the home plate -> catcher
      // segment rather than the pitcher: the world direction from the batter
      // to that midpoint, expressed in the upper body's LIVE frame (so it
      // tracks the body as it opens) and split into the fore/aft
      // (rotation.x) and sideways (rotation.z) components. Straight when set,
      // ramping in as the pitch arrives (leanIn), settling back onto the back
      // leg during the load, and holding a stronger lean (settings.legLean) through
      // the swing as the back leg drives the rotation — pitched further forward
      // still by the drive's own share (see DRIVE_LEAN).
      const leanMag = THREE.MathUtils.lerp(settings.setLean * leanIn, settings.legLean, drive) - DRIVE_LEAN * drive
      // Posed about the plate-tuned stance, not where the body stands: the two
      // must be the same point the contact geometry leans the sweet spot over
      // (see STANCE_SETBACK_M), or the bat and the body would disagree.
      const lean = batterLean(refBatX, refStanceZ, FIELD.DEFENSE.C.z, bodyYaw, leanMag)
      leanX = lean.rotationX + settings.loadLeanBack * load * (1 - drive)
      leanZ = lean.rotationZ
      // As the back leg unbuckles, the body also tilts back toward the
      // catcher (world +Z) while the hips drive forward — expressed in the
      // live frame so the tilt always points at the catcher, and held through
      // the follow-through as the back leg stays driven.
      const backTilt = settings.swingBackTilt * drive
      leanX += backTilt * Math.cos(bodyYaw)
      leanZ += backTilt * Math.sin(bodyYaw)
      upperRef.current.rotation.x = leanX
      upperRef.current.rotation.z = leanZ
      // The back leg firing pushes the whole body forward toward the pitcher
      // (the hips lead with settings.hipDriveForward; the torso, head, and bat
      // follow with settings.upperDriveForward, which the contact geometry
      // compensates for so the sweet spot still meets the ball). This group is
      // the frame the bat hangs in, so it carries *both* halves of that travel:
      // the drive the hips lead with moves the bat too (upperOffsetZ below is the
      // torso's own share, which the measured skeleton is given separately).
      // Carrying only the torso's share put the bat 0.28 m behind the body the
      // geometry had placed it on — the hands ended up inside the hips at the
      // finish — and left the arms stretching 1.25x to span the gap.
      upperOffsetZ = (-settings.upperDriveForward * push) / heightScale
      upperRef.current.position.z = upperOffsetZ - hipDrive
      // The hips settle lower during the load (the whole upper body drops with
      // them), rising back as the drive engages.
      upperRef.current.position.y = HIP_Y + bob - settings.hipSettle * load * (1 - drive)
    }
    const legs = poseLegs(drive, driveBack, load, stride, strideLift, lowerYaw)

    // Head: faces the pitcher during the set, eases to track the ball through
    // the swing (tilting forward toward the plate and swiveling to the contact
    // point as the upper body opens), and once the ball is hit follows the
    // batted ball's live flight — yawing to its position and tilting up for
    // fly balls / down for grounders. The lock-on ramps in at contact and
    // eases back out once the ball lands, so the head tracks the flight but
    // never snaps when the play ends.
    if (headRef.current && upperRef.current) {
      // YXZ order: yaw around the vertical first, then pitch — the standard
      // head convention, so the pitch always tilts the face up/down regardless
      // of how far the head is turned. With the default XYZ order the pitch
      // axis rotates WITH the yaw, so once the head turns past +/-90 degrees
      // (tracking a ball while the upper body recovers) a positive tilt flips
      // to pointing DOWN — the head looks like it's tilting off the back.
      headRef.current.rotation.order = 'YXZ'

      // Head direction to pitcher:
      // When the batter leans forward during the pitcher's windup, the upper body
      // tilts toward home plate (rotation.x and rotation.z on upperRef).
      // Express the world vector to the pitcher in the upper body's LIVE coordinate
      // frame so the head's local pitch and yaw counteract the torso's forward/sideways
      // lean, keeping the gaze locked level and directly onto the pitcher instead of
      // tilting up into the sky.
      upperRef.current.updateWorldMatrix(true, true)
      headRef.current.getWorldPosition(_headWorld)
      _pitcherTarget.set(0, _headWorld.y, FIELD.DEFENSE.P.z)
      _worldDir.subVectors(_pitcherTarget, _headWorld).normalize()
      upperRef.current.getWorldQuaternion(_upperQuat)
      _localDir.copy(_worldDir).applyQuaternion(_upperQuat.invert())
      const pitcherYaw = Math.atan2(-_localDir.x, -_localDir.z)
      const pitcherDist = Math.hypot(_localDir.x, _localDir.z)
      const pitcherTilt = Math.atan2(_localDir.y, pitcherDist)

      const ballPos = getBattedBallPosition()
      const upperYaw = upperRef.current.rotation.y
      let yaw = lerpAngle(pitcherYaw, geom.headYaw, open)
      let tilt = THREE.MathUtils.lerp(pitcherTilt, settings.headTiltMax, open)
      const tracking = ballPos && currentSimTime >= geom.contactTime
      if (tracking) {
        // The ball launches exactly at the contact point, so this look is
        // continuous with the contact tracking. Store the WORLD yaw to the
        // ball (not a local one) so the fade below stays anchored in world
        // space while the upper body may still be rotating back.
        const dx = ballPos.x - _headWorld.x
        const dy = ballPos.y - _headWorld.y
        const dz = ballPos.z - _headWorld.z
        const dist = Math.hypot(dx, dz)
        lastBallLook.current = {
          worldYaw: Math.atan2(-dx, -dz),
          tilt: dist > 1e-4
            ? THREE.MathUtils.clamp(Math.atan2(dy, dist), -settings.headTrackTiltDown, settings.headTrackTiltUp)
            : 0,
        }
      }
      // Ease the lock-on strength: ramp in quickly at contact, decay back to
      // the stance look after the ball lands (faster in, slower out).
      const trackTarget = tracking ? 1 : 0
      const trackRate = trackTarget ? 10 : 4
      trackRef.current = THREE.MathUtils.clamp(
        trackRef.current + (trackTarget - trackRef.current) * Math.min(1, delta * getTimeScale() * trackRate),
        0,
        1,
      )
      if (trackRef.current > 0 && lastBallLook.current) {
        // Fade the head's WORLD facing directly from the last tracked
        // direction back to the stance look, then express it in the upper
        // body's current frame. If the ball lands mid-recovery the upper body
        // keeps rotating back, and a local-frame fade would drag the head's
        // world facing along with it — swinging it off the neck and behind
        // the body. Fading in world space keeps the head on a straight path
        // back to the pitcher look regardless of what the torso is doing.
        const currentWorldYaw = upperYaw + yaw
        const trackedWorldYaw = lerpAngle(currentWorldYaw, lastBallLook.current.worldYaw, trackRef.current)
        yaw = trackedWorldYaw - upperYaw
        tilt = THREE.MathUtils.lerp(tilt, lastBallLook.current.tilt, trackRef.current)
      }
      headRef.current.rotation.x = tilt
      headRef.current.rotation.y = yaw
      headPitch = tilt
      headYaw = yaw
    }

    // Hands: loaded -> contact along a forward-bulging arc through the swing,
    // then follow-through arc extending and lifting slightly along the swing plane as it
    // decelerates fluidly, holds the finish pose, and eases back to loaded.
    // The finish hands: on the body's own centreline, up at the lead shoulder,
    // and out in front of the chest.
    //
    // Where they used to finish matters, because *how far across* is the trail
    // arm's problem. Both hands sit on one bat, so their two reaches trade off
    // against each other, and whether the trail arm lies *along* the chest or
    // through it is its own span: the trail hand grips 0.253 rig up the handle,
    // so a finish 0.11 rig across the body put that hand 0.55 rig from its own
    // shoulder and the arm at 85% of its span at the finish, 98% mid-swing, 78%
    // through the hold — a straight chord laid on the ribs, 10 of its 229 skin
    // vertices inside the trunk at the finish and 5 at the hold, worst 0.043 rig
    // (2.7 cm). No elbow hint has authority over an arm with no bend left to
    // steer, which is why this is the grip's job and not the hint's. On the
    // centreline the same arm reads 78% of its span at the finish and 72% through
    // the hold, with nothing of it inside the trunk at any of the four moments
    // the suite samples: 0.54 s 10 → 0 vertices inside, 0.60 s 11 → 0, 0.68 s
    // 5 → 0, 0.76 s 5 → 0.
    //
    // The depth (the -0.52 below) is what the *forearms* read. Each runs from an
    // elbow beside the ribs up to these hands, so the chord across the waist is
    // theirs: at -0.40 the forearms read 0.041 rig inside the trunk at the finish
    // and 0.040 through the hold, and at -0.52 none of either is inside at the
    // finish — 0 of their 116 skin vertices, clearing the belly by 0.05 rig — and
    // the hold's 41 fall to 13. It has since been taken further out still — to
    // -0.66, which is what the *lead* elbow at the finish is bought with (see the
    // bottom of this block and the README's own section on it) — and the *trail*
    // arm is what pays for it: at that depth the two-handed grip would sit past
    // that arm's own reach, so the carry round (see TRAIL_REACH_CLEAR) and the
    // reach bound (see TRAIL_REACH_MAX) are what put it back inside the arm.
    //
    // The arc's own control point, the hold's own offset and the way home are all
    // left where they were. The control point shapes the sweep *out* from contact,
    // where the bat has to keep riding the swing plane (moving it with the
    // endpoint only made the arc cross the chest on the way out); and carrying
    // the hold up and back, or lifting and bulging the way home, all read better
    // at the moment they are aimed at but cost more than they buy — the first
    // straightens the lead arm through the reset, the second carries it behind the
    // body from the game camera and points the trail elbow at the pitcher.
    const throughHands = [
      // The grip is set at the end of the lead arm's own reach — the way home
      // takes its bend back off this pose (see LEAD_SHOULDER_FROM_HOLD), so the arm
      // has to be straight here — *and* at the far end of a fist's roll: the roll
      // the bat's own angle asks for at the finish swings the wrist round the
      // handle, and the reach it costs is paid in the same coin, so the grip is
      // carried 0.06 rig out along the shoulder-to-grip line (in the read frame,
      // +0.029 out toward the plate, 0.034 down and 0.037 further forward) to buy
      // the lead arm its 1.0 of span back with the bat where it is now held.
      // Carried *out* rather than across: the trail arm's own chord runs 114
      // degrees off this direction, so this is the one place on the finish's
      // sphere that straightens the lead arm and shortens the trail's.
      // Carried round with the body, as the body's own turn carries it: the
      // finish unwinds *into* the pull side rather than stopping on the centre
      // line and reaching across it. Held on the centre line the hands left the
      // two arms crossing each other in front of the chest — measured, the two
      // shoulders spanned -0.35 rig across the body while the hands spanned
      // +0.08 the other way, and the arms' own lines crossed in plan.
      //
      // Carried 0.44 rig the way the shoulders go, which is where the swing's own
      // turn puts the grip: read in the batter's own frame, the grip finishes
      // 0.508 rig out from the pelvis's axis (it was 0.235, and 0.27 with the
      // carry at 0.2), i.e. out past his own trail shoulder rather than in front
      // of the middle of his chest, and the barrel goes round with it. Three
      // readings move together with the carry, and they are the reason it is
      // taken this far rather than further:
      //
      //   the *lead* arm comes out long, which is the pose the way home is
      //   authored from — the pull that gives that arm its bend back (see
      //   LEAD_SHOULDER_FROM_HOLD) has to start on a straight one. At 0.2 it read
      //   0.946 of its own span at the finish, i.e. *under* its own reach, and the
      //   suite's non-vacuous bound reads the same frame this pose is authored at.
      //   At 0.44 it reads 1.077: the clavicle's whole 20-degree budget spent and
      //   the two bones stretched 7.7% to cover the rest, inside the 1.25 the
      //   hand-solve test allows.
      //
      //   the *trail* arm — the one a follow-through sends across the body —
      //   shortens to 0.784 at the finish and 0.80 through the hold, against the
      //   0.9 it is held to (0.871 and 0.815 at 0.2). Its shoulder is on the side
      //   the grip is carried toward, so the carry is the one lever that shortens
      //   its chord while lengthening the lead one.
      //
      //   and the *barrel* leaves the body. The swing's own path carries the bat
      //   into the chest at the end of the follow-through, and the hold's own
      //   carry (see peakHands) is what takes it back out again — where the grip
      //   ends up is what that is measured against: at 0.2 the barrel came
      //   0.182 rig from the batter's own skin at the hold (0.170 at its closest),
      //   0.409 at the finish; carried 0.44 and set 0.04 deeper (below), the same
      //   readings are 0.446 and 0.394 at the hold and the finish, and nothing in
      //   the window comes nearer than 0.39 (probeBatBody, which reads the bat
      //   against the posed skin rather than against the bones).
      sign * FINISH_OUT,
      FINISH_HANDS_Y,
      // ...and out in front of the belly rather than across it. Each forearm runs
      // from an elbow beside the ribs up to these hands, so the hands' own depth
      // is what decides whether that chord crosses the waist: at -0.40 the lead
      // forearm read 0.041 rig inside the trunk at the finish and 0.040 through
      // the hold; at -0.52 neither forearm reads inside at all. What pulls it back
      // toward the body is the *wrist*: the fist's roll (see palmUp) turns the palm on
      // the handle, and the wrist that puts the palm there swings around the bat's
      // own axis with it — 0.13 rig of arc — so the finish's grip has to sit
      // inside the arm's reach at the roll the finish is held at, not just at the
      // one the arm's own reach direction would have given it. Deeper than about
      // -0.45 the lead arm cannot close on the handle any more: the lead palm
      // slides up the handle, so the pair stops gripping at the spacing the rig
      // authored — 0.244 rig apart at -0.44 and 0.240 at -0.48, against the
      // 0.253 the rig's two hand targets span and the 0.012 the test allows —
      // and drifts off the handle's own axis with it (0.0059 rig at -0.42, 0.0071
      // at -0.44, 0.0091 at -0.48, 0.011 by -0.52).
      // What sets -0.66 is the *lead* arm's own elbow, which is the one thing left
      // holding the bat by the time the swing arrives: the arm reads 0.96-0.97 of
      // its span there — a 147-to-151-degree elbow — where at -0.46 the same pose
      // reads 0.88-0.90 and a 123-to-129-degree one, i.e. a folded arm carrying a
      // two-handed follow-through. Depth is the one direction on this pose's own
      // sphere that lengthens that arm's chord and carries the knob away from the
      // batter's chest at the same time (height *shortens* the chord — his shoulder
      // sits 0.72 rig above the pelvis — and how far across the body the grip goes
      // is pinned by the bat's own crossing of the lead shoulder's plane), and it
      // buys the barrel's clearance rather than paying for it: the nearest body
      // skin to the bat's line reads 0.49-0.51 rig through the follow-through and
      // the hold, against 0.27 at -0.46 and the 0.25 the suite holds it to.
      //
      // What it costs is the *trail* arm, and that is what the carry round and the
      // reach bound are for: carried this deep, the two-handed grip sits 1.05-1.11
      // of that arm's own span (the last frame both hands are on the handle reads
      // 1.00, a 175-degree elbow and 24 of its 230 skin vertices 0.048 rig into the
      // ribs), which is a pose no hint can solve — so the grip is carried round the
      // arm (see TRAIL_REACH_CLEAR) and held inside its reach (see TRAIL_REACH_MAX).
      -FINISH_DEPTH,
    ]
    const followHandsControl = [
      -sign * 0.26,
      geom.contactHands[1] + 0.04,
      -0.36,
    ]
    // The hold is the finish *carried on*, not a pose of its own: the bat's own
    // path walks the hands a little further round to the batter's own side and a
    // little further out in front of him, and settles them there. Three numbers,
    // each read in his own frame (HOLD_OUT / HOLD_SETTLE / HOLD_DEPTH).
    //
    // It used to be authored the other way — the grip pulled 0.47 rig back along
    // the lead shoulder (LEAD_SHOULDER_FROM_HOLD, now read only on the way home),
    // 0.17 of that *up*, with a depth offset giving the distance back out front.
    // While the bat stood up through the hold that rise was what bought the lead
    // arm its bend for the reset. With the bat come round flat (see FOLLOW_FLAT)
    // the same rise is what *breaks the trail hand's grip*, and the reason is the
    // rig's own: the trail hand grips 0.253 rig up the handle, so the higher the
    // grip rides the higher that wrist sits over its own shoulder, and a wrist
    // that cannot bend far enough to close on the handle takes the elbow up with
    // it. Measured at the hold, the trail wrist sat 0.203 rig above its own
    // shoulder against 0.080 at the finish; the fist's own bend sat exactly on its
    // floor of 30.0 degrees — the roll could not bring it inside the limit at all
    // — and the elbow solved 0.58 of the upper arm's length *above* its shoulder,
    // the trailing upper arm pointing at the sky for the whole hold (its own
    // direction ran +0.42 to +0.58 through the follow-through and the hold, and it
    // is still reading +0.06 to +0.14 of it *up* over the reset's own elbow
    // readings today, which is the flicker this pose is up against).
    //
    // Carried the other way — out to his own side, out in front of him, level but
    // for half a tenth — the trail arm's own chord is short enough to follow the
    // bat round, and *the fist closes on the handle with the wrist straight*:
    // measured at the hold, the elbow solves 0.13 of the upper arm's length
    // *below* its own shoulder (0.58 above), its bend floor falls from 30.0 to
    // 19.5 degrees, the arm keeps a real fold (0.799 of its span and a 106-degree
    // elbow, against 0.705 and 90), the fist holds the back of the palm to the sky
    // at 0.70 (against the 0.25 bound), and the barrel's nearest skin reads 0.456
    // rig (0.463 before). What it costs is the *lead* arm's chord at the hold:
    // 1.313 of its span against 1.179, so the reset's first frames read further
    // over the way-home bound than they already did — see the README, where that
    // bound is written down as the cost this pose already carries.
    const peakHands = [
      throughHands[0] + sign * HOLD_OUT,
      throughHands[1] + HOLD_SETTLE,
      throughHands[2] - HOLD_DEPTH,
    ]
    const peakAngle = geom.throughY + sign * HOLD_YAW
    const peakTilt = geom.planeTilt - FOLLOW_FLAT + 0.10
    const peakCock = 0.06
    // The swing's own path, as *one* parameter: 0 at the load, 1 at the pose the
    // follow-through ends on, with the contact the swing's own share of the way
    // along it. The hands, the bat's angle, the cock, the tilt, the arm bend and
    // the follow progress are each a function of it, so the way out and the way
    // home are the same curve — the way home walks this one backwards (see the
    // recovery below) instead of inventing a second path that only meets the
    // swing at its two ends.
    const swingDur = Math.max(1e-3, geom.contactTime - swingStart)
    const followDur = Math.max(1e-3, followEnd - geom.contactTime)
    const pathContact = THREE.MathUtils.clamp(
      swingDur / (swingDur + followDur),
      1e-3,
      0.999,
    )
    // The follow-through's own progress: the swing's arrival speed, carried on the
    // body's own clock. The two phases are different lengths, so the same speed is a
    // different share of each -- which is the whole of what makes the hand-off a
    // hand-off rather than a stop and a restart.
    // ``outward`` reads a curve a little *past* its own phase, which is what the
    // hand-off below is made of: the swing's own curve extrapolated over the ball,
    // the follow-through's extrapolated back before it. The arms' own parameters stay
    // inside their phases either way (a bend of -0.1 is not a pose), and the pose the
    // contact frame reads is the same point on both curves, so nothing the stat line
    // is measured for moves.
    // The carried finish, and the way the pose is pulled off it. `carried(amount)` is
    // the finish's own grip with the way home's own pull applied in full at 1; the
    // follow-through's own path takes it on over its own progress (see carryEase), so
    // the bat is carried to the finish *by the swing* and the hold has nothing left to
    // move.
    const carried = (amount) => [
      peakHands[0] - sign * HELD_PULL_DIR[0] * HELD_PULL * amount,
      peakHands[1] + HELD_PULL_DIR[1] * HELD_PULL * amount,
      peakHands[2] + HELD_PULL_DIR[2] * HELD_PULL * amount,
    ]
    const carriedAt = (share) => carried(carryEase(share))
    // The follow-through's own pose, at its own progress: the swing's curve into the
    // carried finish, with the way home's own pull taken on over the last half of it
    // (see carryEase). Written as one function so the path and the hand that has to
    // let go of the handle read the same clock.
    const followHandsAt = (v) => {
      const base = swingHandsAt(v)
      const finish = carried(carryEase(v))
      return [
        base[0] + finish[0] - peakHands[0],
        base[1] + finish[1] - peakHands[1],
        base[2] + finish[2] - peakHands[2],
      ]
    }

    function swingHandsAt(v) {
      return bezier2(geom.contactHands, followHandsControl, peakHands, v)
    }

    // The line the swing is travelling on when the barrel meets the ball (its own
    // arrival tangent), which is the speed the follow-through has to leave on.
    const leaveEps = 1e-4
    // The follow-through leaves the ball on the swing's own arrival rate and only slows
    // from there. That is its ease's own head slope (see followSlope and followEase
    // above), on one shared clock -- and on this pace that is enough: measured off the
    // suite's own sweep, the tip's fastest frame *is* the contact frame's (41.7 rig/s at
    // 0.405 s) and every frame after it is slower.
    //
    // Front-loading the quantities individually on top of that was built, measured and
    // then dropped, and the numbers are why. On this pace the clock's own rate at the
    // ball is already the swing's, so a per-quantity spread only buys a second, later
    // hump: measured, the tip throws again to 30.0 rig/s at 0.470 s with the grip's own
    // spread and reads one hump at 27.8 s without it. Front-loading the bat's *rotation*
    // the same way is worse than useless: the trail hand is on the handle, so the bat
    // turning faster early swings its chord in toward the shoulder faster, and the elbow
    // folds and straightens 15 to 19 degrees inside 35 to 50 ms at the ball -- the flick
    // class the joint test exists to catch.

    const pathAt = (path, outward = false) => {
      const inside = (value) => (outward ? value : THREE.MathUtils.clamp(value, 0, 1))
      if (path <= pathContact) {
        const u = inside(path / pathContact)
        if (u > 1) {
          // Past contact the stat-driven curve is *cut*, not followed: extrapolated it
          // curves back toward the batter (its own end tangent is heading that way and
          // its curvature keeps bending it), and it is that curve which used to read as
          // the bat coming back at him. Cut, the hand continues along the line it met
          // the ball on -- which is what the blend below turns into the follow-through.
          const past = u - 1
          return {
            hands: geom.contactHands.map(
              (c, i) => c + past * 2 * (c - geom.handsControl[i]),
            ),
            angle: geom.contactY + past * (geom.contactY - geom.loadedY),
            cockAngle: 0,
            tiltAngle: geom.tilt + past * geom.tilt,
            bend: 0,
            followProgress: 0,
          }
        }
        return {
          hands: bezier2(geom.loadedHands, geom.handsControl, geom.contactHands, u),
          angle: THREE.MathUtils.lerp(geom.loadedY, geom.contactY, u),
          cockAngle: settings.cockAngle * (1 - THREE.MathUtils.clamp(u, 0, 1)),
          tiltAngle: computeBatTiltAtProgress(u, geom.tilt, geom.planeTilt),
          bend: 1 - THREE.MathUtils.clamp(u, 0, 1),
          followProgress: 0,
        }
      }
      const u = inside(
        (path - pathContact) / (1 - pathContact),
      )
      if (u < 0) {
        // ...and before contact it is read backward along its own first line, so the
        // blend has a direction to turn to rather than a point to curve through.
        return {
          hands: geom.contactHands.map(
            (c, i) => c + u * 2 * (followHandsControl[i] - c),
          ),
          angle: geom.contactY + u * (geom.throughY - geom.contactY),
          cockAngle: 0,
          tiltAngle: geom.tilt + u * (geom.planeTilt - FOLLOW_FLAT - geom.tilt),
          bend: 0,
          followProgress: 0,
        }
      }
      return {
        // ...and it *ends* on the finish -- the pose the hold settles into -- rather
        // than on a pose of its own that the hold then slid away from. The two used to
        // be different points 0.20 rig apart (the hold's own carry was added to the
        // finish's grip inside the hold), so the follow-through arrived somewhere and
        // the bat then translated sideways to the finish: measured, the last frames of
        // the follow-through slow to 0.3 rig/s and the hold's own first frames move the
        // hand 0.16 rig in one direction with the barrel barely turning, which reads as
        // a stop and a slide rather than one swing. Authored onto the end of the curve,
        // the same carry is taken by the swing's own arc, and the hold has nothing to
        // translate: it holds the pose the path arrived on.
        hands: followHandsAt(u),
        // ...with the finish's own turn taken on over the back of it: the lerp runs to
        // the turn the finish carried before the extra was asked for and `turnLate`
        // adds the rest (see HOLD_YAW_LATE), so the two are one monotone curve that
        // leaves the ball on the rate the swing handed it.
        angle: THREE.MathUtils.lerp(geom.contactY, peakAngle - sign * HOLD_YAW_LATE, u)
          + sign * HOLD_YAW_LATE * turnLate(u),
        cockAngle: peakCock * u,
        tiltAngle: THREE.MathUtils.lerp(geom.tilt, peakTilt, u),
        bend: 0,
        followProgress: THREE.MathUtils.clamp(u, 0, 1),
      }
    }

    // The bat's own momentum past the path's end (see SWING_SWIVEL). Its rate at
    // 0.54 s is the yaw rate the follow-through *arrived* on (read off the same
    // curve, one ten-thousandth of a second before the end), so the swivel carries
    // the bat on from the speed it already had instead of starting it again.
    const swivelRate = (
      pathAt(1, true).angle
      - pathAt(pathContact + (1 - pathContact) * followEase(
        (settings.followThrough - leaveEps) / settings.followThrough,
      ), true).angle
    ) / leaveEps
    const swivelHead = (swivelRate * SWING_SWIVEL_TIME) / SWING_SWIVEL
    // The bat carries on the way it was turning, whichever way that is: the sign of
    // the rate decides, so the swivel is momentum rather than a second, authored
    // rotation. (Turning it the other way is what pushed the trailing arm's bicep
    // back against the ribs: measured at 0.68 s, that arm reads 0 of its 230
    // upper-arm vertices inside the trunk with the sign kept and 11 at -0.004 with
    // it flipped.)
    const swivelWay = Math.sign(swivelRate) || 1
    const swivelAt = (time) => swivelWay * SWING_SWIVEL * hermite(
      0, swivelHead, 1, 0,
      THREE.MathUtils.clamp((time - followEnd) / SWING_SWIVEL_TIME, 0, 1),
    )
    const heldAngle = peakAngle + SWING_SWIVEL

    let hands = geom.loadedHands
    let angle = geom.loadedY
    let cockAngle = settings.cockAngle
    let tiltAngle = 0
    let bend = 1
    let followProgress = 0

    if (swing && currentSimTime >= swingStart) {
      if (currentSimTime < geom.contactTime) {
        ({ hands, angle, cockAngle, tiltAngle, bend, followProgress } =
          pathAt(pathContact * e))
      } else if (currentSimTime < geom.contactTime + SWING_HANDOFF) {
        // The bridge between the two paths. The stat-driven swing's own path ends on
        // the ball and the follow-through's curve begins on it, and the two leave the
        // contact frame 72.6 degrees apart (the swing arrives descending and in toward
        // the body, the follow-through leaves across it and level). Blending the two
        // *positions* across a window does not turn that corner -- it drags the hand
        // between two curves that are a tenth of a rig apart by the end of it, which
        // moves the bat further in one frame than the swing ever did. What the window
        // takes instead is a cubic Hermite: a path through the window that starts on
        // the swing's own line at the swing's own speed and ends on the follow-through's
        // line at its own speed, so the bat leaves the ball the way it met it and turns
        // off that line over four frames rather than at a corner. Both tangents are
        // measured from the two phase curves' own clocks, so neither ease has to be
        // re-derived here (and both are finite differences of `pathAt`, one ten-
        // thousandth of a second either side, which keeps every chain rule in one place).
        const h = SWING_HANDOFF
        const dt = 1e-4
        const tau = (currentSimTime - geom.contactTime) / h
        const endTime = geom.contactTime + h
        const at = (time) => pathAt(pathContact + (1 - pathContact) *
          followEase((time - geom.contactTime) / settings.followThrough))
        const from = pathAt(pathContact)
        const to = at(endTime)
        const toNext = at(endTime + dt)
        const was = pathAt(pathContact * swingProgress(
          (geom.contactTime - dt - swingStart) / settings.swingLead,
        ))
        const leave = (index) => (from.hands[index] - was.hands[index]) / dt
        const arrive = (index) => (toNext.hands[index] - to.hands[index]) / dt
        hands = from.hands.map(
          (c, i) => hermite(c, leave(i) * h, to.hands[i], arrive(i) * h, tau),
        )
        // The bat's own angle, cock and tilt ride the same bridge on the same two
        // tangents, and the two pose flags (the elbow's bend driver and the
        // follow-through's own progress) hand over on a smoothstep.
        angle = hermite(from.angle, (from.angle - was.angle) / dt * h, to.angle,
          (toNext.angle - to.angle) / dt * h, tau)
        cockAngle = hermite(from.cockAngle, (from.cockAngle - was.cockAngle) / dt * h,
          to.cockAngle, (toNext.cockAngle - to.cockAngle) / dt * h, tau)
        tiltAngle = hermite(from.tiltAngle, (from.tiltAngle - was.tiltAngle) / dt * h,
          to.tiltAngle, (toNext.tiltAngle - to.tiltAngle) / dt * h, tau)
        bend = THREE.MathUtils.lerp(from.bend, to.bend, easeSwing(tau))
        followProgress = THREE.MathUtils.lerp(from.followProgress, to.followProgress, easeSwing(tau))
      } else if (currentSimTime < followEnd) {
        ({ hands, angle, cockAngle, tiltAngle, bend, followProgress } =
          pathAt(pathContact + (1 - pathContact) * f))
      } else if (currentSimTime < holdEnd) {
        // The hold is exactly that: the swing arrived on the finish (the path's own
        // end *is* the carried pose), so the hold holds it -- nothing left to settle,
        // nothing left to carry -- and the way home's own pull is already in it, so
        // the pose the hold ends on is the pose the reset starts from and the two
        // phases meet on one without either snapping.
        hands = carried(1)
        angle = peakAngle + swivelAt(currentSimTime)
        cockAngle = peakCock
        tiltAngle = peakTilt
        bend = 0
        followProgress = 1
      } else if (currentSimTime < recoverEnd) {
        // The way home is the way out, walked backwards: the same curve through
        // the hands, the same bat angle, the same tilt and arm bend the swing
        // passed through, sampled in reverse as the body unwinds — so the bat
        // comes back down the line it went up, through the contact pose on the
        // way instead of around it.
        //
        // The hold's own settle is the one thing on screen that the swing never
        // passed through, so it is given up first, over the same ease it was
        // taken up with, and the retrace starts from the pose it settled off —
        // the finish, which is where the path it walks backwards begins.
        const unwind = Math.min(1, r / RECOVERY_UNWIND_SHARE)
        // The *held* share, and it counts down: at the first frame of the way
        // home the pose is the one the hold ended on (the lift fully in, the same
        // pose, so the two phases meet), and over the first fifth of the recovery
        // the lift is eased away until the retrace takes the pose over. The ease
        // is the hold's own, backwards, and squared so that neither end has a
        // slope: the pose leaves the hold without a start and lands on the
        // retrace without a jerk. (Written as a ramp *up* — `1 - (1 - unwind)^2` —
        // the shares are swapped: the pose would snap off the held finish onto
        // the retrace's own start on the hold's last frame, and the retrace's
        // hands would then be ignored for the rest of the way home, leaving the
        // bat up in front of the chest while the body unwound underneath it.)
        const held = 1 - unwind * unwind
        // ...and the retrace is *in step with the body*. The body unwinds on its
        // own eased clock (``torsoEase``, which is the same shape the swing's own
        // turn was driven by on the way out), so the path it walks backwards is
        // the one that goes with the turn it has made: the hands are always where
        // the pose *at that turn* puts them. Walked on a ramp of its own instead —
        // linear in the recovery — the hands lead the body through the middle of
        // the way home, and the shoulders they have to reach from are still turned
        // toward the pull side: measured, the trail arm was dragged to 1.26 of its
        // own span (the driver's stretch limit) at 1.11 s and the lead to 1.21,
        // where the same poses cost the swing itself 1.15 and 1.08.
        const back = pathAt(1 - torsoEase)
        // The retrace's own share of the same pull the hold's grip is carried on
        // (see LEAD_SHOULDER_FROM_HOLD). The poses it walks are the swing's own,
        // and the swing's own grip is at the end of the lead arm's reach by
        // design — the pull is what the way home has instead of that reach: it
        // shortens the shoulder-to-grip chord the arm is solved over, which is the
        // only lever that bends an arm whose elbow hint has no bend left to steer.
        // Taken on the *retrace* as well as on the held grip, because the reach
        // absorbs a pull taken on either one alone (a shorter chord is a shorter
        // clavicle swing to give back). Faded out as the load comes back, so the
        // pose the way home ends on is the set stance's own grip and not a pulled
        // version of it.
        const release = easeSwing(THREE.MathUtils.clamp((1 - torsoEase) / RESET_PULL_HOLD, 0, 1))
        const pull = RESET_PULL * release
        const backHands = [
          back.hands[0] - sign * LEAD_SHOULDER_FROM_HOLD[0] * pull,
          back.hands[1] + LEAD_SHOULDER_FROM_HOLD[1] * pull,
          back.hands[2] + LEAD_SHOULDER_FROM_HOLD[2] * pull,
        ]
        // ...and pushed off the trunk on the way (see RECOVERY_AWAY), by a bow that
        // is nought at both ends of the recovery: out toward the pitcher with a
        // tenth of it to the batter's own side.
        // The bow peaks late rather than halfway: the swing's own curve comes closest
        // to the trunk near the *end* of the way home (measured, the hands' own
        // distance from the body's line bottoms out at r = 0.9), so the shape that
        // widens the path most is one that is still near its own full width there —
        // sin(pi r^2)^2 is nought at both ends, nought in slope at both ends, and
        // 0.82 of its own peak at r = 0.8.
        const away = Math.sin(Math.PI * r * r) ** 2 * RECOVERY_AWAY

        // The pose the held share hands back is the hold's *last* frame — the
        // pulled one (see HELD_PULL), which is what the way home is authored from.
        const heldPose = carriedAt(1)
        hands = [
          THREE.MathUtils.lerp(backHands[0], heldPose[0], held) + away * sign * RECOVERY_AWAY_SIDE,
          THREE.MathUtils.lerp(backHands[1], heldPose[1], held),
          THREE.MathUtils.lerp(backHands[2], heldPose[2], held) - away,
        ]
        angle = THREE.MathUtils.lerp(back.angle, heldAngle, held)
        cockAngle = THREE.MathUtils.lerp(back.cockAngle, peakCock, held)
        tiltAngle = THREE.MathUtils.lerp(back.tiltAngle, peakTilt, held)
        bend = back.bend
        followProgress = back.followProgress
      }
    }

    // ...and how far *round* the trailing shoulder's own arm the bat is carried — for
    // the whole finish and the hold, because both hands are on it the whole time — so
    // that a trailing arm held straight can guide it without its bicep lying in the
    // ribs (see TRAIL_REACH_CLEAR). It is given back over the first fifth of the way
    // home, on the hold's own clock for the same reason.
    if (swing && currentSimTime >= geom.contactTime) {
      const on = easeSwing(
        THREE.MathUtils.clamp((currentSimTime - geom.contactTime) / SWING_HANDOFF, 0, 1),
      )
      const handback = currentSimTime < holdEnd
        ? 1
        : 1 - easeSwing(THREE.MathUtils.clamp(
            (currentSimTime - holdEnd) / (settings.recoveryTime * TRAIL_REACH_UNWIND), 0, 1,
          ))
      const round = TRAIL_REACH_CLEAR * on * handback
      hands = [
        hands[0] + round * sign * TRAIL_REACH_CLEAR_DIR[0],
        hands[1] + round * TRAIL_REACH_CLEAR_DIR[1],
        hands[2] + round * TRAIL_REACH_CLEAR_DIR[2],
      ]
      // ...and the arm's own reach, as the bound on where it can be carried at all
      // (see TRAIL_REACH_MAX). The trailing fist grips ``gripSplit`` up the handle, so
      // the chord from the trailing shoulder to that grip is the span the arm has to
      // cover — and past its own length the solve can only stretch the bones, which is
      // the straight line the eye reads as an arm come off its shoulder. The grip is
      // carried back along the chord's own line, i.e. the way the bat was carried out,
      // so the bat is not pulled sideways into him: only far enough that the arm can
      // hold it, with its bend left at the elbow.
      const barrel = batAxis(angle, cockAngle, tiltAngle)
      const across = hands[0] + gripSplit * barrel.x - sign * rig.shoulder.halfWidth
      const above = hands[1] + gripSplit * barrel.y - rig.shoulder.y
      const front = hands[2] + gripSplit * barrel.z - rig.shoulder.z
      // ...and the reach bound is the *reset's* now, not the swing's. Through the
      // carry and the whole hold the arm is straight and the swing's own extension is
      // what holds it — its chord runs 1.16 down to 1.00 and back out to 1.19 of its
      // span over the follow-through, a 175-to-176-degree elbow at every frame it is
      // read at, with the biggest step any of its bones takes 0.23 rig in a 0.01 s frame —
      // so a pull there does not bend the arm once and settle: it fights a chord that is
      // already
      // at the arm's own reach, and the elbow drops from 175 to 150 degrees within the frame
      // after contact and then sits in a 136-to-151-degree ribbon, a 40-degree flick of the
      // forearm about its own elbow, for the rest of the follow-through. That ribbon
      // is what this schedule takes out.
      // The pull is taken up over the reset's own first share instead, on the same
      // clock the held pose is handed back on (see TRAIL_REACH_UNWIND), because that
      // is where the retrace walks the carry's own poses backwards and the arm is
      // over its reach for longer than the bones answer for (1.19 to 1.25 of its span
      // at 0.84-0.92 s with the pull off, its bicep 0.05 rig into the ribs there).
      // Past the first fifth the retrace holds itself: its own chord is under 0.94 of
      // the span from 1.00 s on, so the excess is nought and nothing is pulled.
      const reachIn = currentSimTime < holdEnd
        ? 0
        : easeSwing(THREE.MathUtils.clamp(
            (currentSimTime - holdEnd) / (settings.recoveryTime * TRAIL_REACH_UNWIND), 0, 1,
          ))
      const chord = Math.hypot(across, above, front)
      const excess = chord - TRAIL_REACH_MAX
      if (excess > 0) {
        const back = (excess / chord) * reachIn
        hands = [
          hands[0] - back * across,
          hands[1] - back * above,
          hands[2] - back * front,
        ]
      }
    }

    batGroupRef.current.position.set(hands[0], hands[1], hands[2])
    batGroupRef.current.rotation.y = angle

    if (cockRef.current) cockRef.current.rotation.x = cockAngle
    if (tiltRef.current) tiltRef.current.rotation.x = tiltAngle

    const isRecovering = swing && currentSimTime >= holdEnd && currentSimTime < recoverEnd
    // How much of each fist's roll is taken off the arm's own reach direction and
    // held to "the back of the palm faces the sky" (see fistRotation). None of it
    // while the bat is being swung — that roll is the swing's own — and all of it
    // from the follow-through through the pose held in front of the chest, easing
    // back to the hand's own roll over the last of the reset so the set stance
    // returns to exactly the pose it was.
    // The roll is the wrist's own across the whole swing *and* the follow-
    // through, and the reference comes in over the last tenth of the follow-
    // through, once the bat has come round. A partial blend of it is not a small
    // version of it: the reference is a roll axis half a turn from the reach
    // direction, and the wrist sits on that roll's own radius, so taking part of
    // it swings the wrist *around* the handle. Measured, the trailing wrist came
    // to 0.09 rig on the leading hand's side of the handle at 0.50 s with the
    // blend at 0.7 (tilt-scaled, as the swing's roll is), and that is what
    // carried the trailing forearm through the leading one — the two arm chains
    // read 0.001 rig apart there. Held off until the bat is round, the wrist
    // keeps its own side (0.19-0.22 rig out) and the chains read 0.15 rig apart.
    // What it costs is the turnover: the roll turns over 0.53-0.54 s, a 0.32 rig
    // move of the wrist in a hundredth of a second, against the 0.18 rig the
    // swing's own fastest wrist moves are.
    //
    // The hold itself reads exactly as it did — the ramp's value at progress 1
    // is what the old `followProgress` gave there, so the pose held in front of
    // the chest is untouched — and the roll is held right through the reset,
    // since the arm travels for all of it: handed back to the hand's own roll
    // only over the last fifth of the way home, where the pose is the load again.
    //
    // It is a *held* roll, and that is what the shares below are about: the roll
    // is the wrist's own while the swing drives it, and these are the pose's. How
    // much of the reference a held roll takes is gated by the barrel's tilt and
    // *not* scaled by it (see fistRotation) — the axis the reference is built on
    // is ill-defined only at vertical, and a share scaled by the tilt is not a
    // held roll at all: at the 0.5 the barrel stands at through the crux, the 0.6
    // this used to ask for came out as 0.3, and a blend taking under half of a
    // reference passes through the reference's own opposite and comes out the far
    // side. Measured through the way home, the lead palm ran 0.25 → -0.50 over
    // 0.05 s at 0.87-0.92 s (barrel 0.5-0.6 off vertical) with the share scaled,
    // and holds 0.50 and 0.44 at those two moments gated; the back palm ran to
    // -0.50 at 1.22-1.37 s and stays at 0.44 through the same stretch.
    //
    // What the shares cost is the arm's own reach, because the wrist that puts the
    // palm on the handle swings *around* the bat's own axis with it — 0.13 rig of
    // arc — so the further the roll is taken, the further the arm has to reach to
    // close on the handle at all. Through the reset that is the whole margin: at
    // 0.96 s the back forearm reads 0 of its 116 skin vertices inside the trunk
    // at the shares above and 5 at a front share of 0.6, against a bound of none
    // (see PALM_HELD_FRONT, and the set's own test for the lead arm). The set
    // stance is untouched by all of it: the roll is released before the load,
    // over the last fifth of the way home, and the reading there is the arm's own
    // again.
    const palmUp = isRecovering
      ? PALM_HELD_BACK * THREE.MathUtils.clamp((1 - r) / 0.2, 0, 1)
      : THREE.MathUtils.clamp((followProgress - 0.9) / 0.1, 0, 1)
    const arms = updateArms(
      hands, bend, align, angle, cockAngle, tiltAngle, followProgress, isRecovering, palmUp,
    )

    if (handLRef.current && handRRef.current) {
      if (sign === 1) {
        // Righty: Left hand (lead) at knob (Z = 0), Right hand (back) on top (Z = -gripSplit)
        handLRef.current.position.set(-0.01, 0, 0)
        handRRef.current.position.set(0.01, 0, -gripSplit)
      } else {
        // Lefty: Right hand (lead) at knob (Z = 0), Left hand (back) on top (Z = -gripSplit)
        handLRef.current.position.set(-0.01, 0, -gripSplit)
        handRRef.current.position.set(0.01, 0, 0)
      }
    }

    // Drive the measured skeleton with everything the frame just computed: the
    // hips and torso carry the same turn, lean and forward drive the groups do,
    // the head the same look, and the limbs are solved by 2-bone IK onto the
    // very targets the groups were posed with — so the model performs the tuned
    // animation (front-leg step, back-leg drive, hip thrust, torso turn and
    // follow-through) while the bat stays exactly where the data-driven contact
    // geometry puts it.
    if (rigDriverRef.current) {
      rigDriverRef.current.applyPose({
        hip: {
          yaw: lowerYaw,
          leanX,
          leanZ,
          offsetY: bob - settings.hipSettle * load * (1 - drive),
          offsetZ: -hipDrive,
        },
        torsoYawExtra: bodyYaw - lowerYaw,
        torsoOffsetZ: upperOffsetZ,
        head: { yaw: headYaw, pitch: headPitch },
        legs,
        arms,
      })
    }
  })

  if (!pitchData) return null

  const batLength = geom?.batLength ?? 0.9

  return (
    <group ref={groupRef} name="batter" position={[batX, 0, stanceZ]}>
      {/* Uniformly scaled body and bat so the silhouette (height, body width,
          shoulder width) stays proportional to the batter's size. This group is
          the frame the animation's distances are authored in (named so tests can
          read the posed body back in those units). */}
      <group name="batter-frame" scale={heightScale}>
        {/* The body: the reference project's skinned player model, scaled from
            its own rest height to the tuning's body frame (feet at y = 0),
            turned to face the pitcher (the model rests facing +Z, so the batter
            needs a half turn), and shifted so its hip joints sit on the frame's
            centreline — which is where the contact geometry measures the body
            from. Every joint on it is posed each frame by the bone driver. */}
        <group
          ref={setModelNode}
          rotation={[0, Math.PI, 0]}
          position={bodyPlacement}
          scale={rig.unitScale}
        >
          <primitive object={body.model} />
        </group>

        {/* Upper body: rotates to open toward the pitcher through the swing,
            carrying the bat and the head marker with it. The group sits at the
            hip joint (HIP_Y) — the pivot the data-driven contact geometry
            assumes — so the bat is placed exactly where it has always been,
            with the inner group restoring the feet-relative child coordinates
            the joint targets are authored in. */}
        <group ref={upperRef} position={[0, HIP_Y, 0]}>
          <group ref={innerRef} position={[0, -HIP_Y, 0]}>
            {/* Head marker: stands where the head sits on the posed torso, so
                the gaze (pitcher, then the contact point, then the batted ball)
                is solved from the live body. The model's own head bone takes
                the resulting yaw and tilt. */}
            <group ref={headRef} position={[0, 1.96, 0]} />

            {/* Bat: handle at the hands, barrel toward the pitcher (-Z). This
                group is the bat's *swing* frame: it carries the swing's own yaw
                and the two groups inside it carry the bat's tilt, so its local X
                is the axis the barrel sweeps about — the normal of the plane the
                bat swings in. Named so the tests can read that plane back (see
                probeBat in the harness). */}
            <group
              ref={batGroupRef}
              name="bat-swing-frame"
              position={loadedHands}
              rotation={[0, sign * settings.loadedBaseAngle, 0]}
            >
              <group ref={cockRef} rotation={[settings.cockAngle, 0, 0]}>
                <group ref={tiltRef}>
                  <group scale={[1, 1, batLength / 0.95]}>
                    <primitive object={batModel} />
                  </group>
                  {/* Where each hand grips the handle (used for the arms' own
                      solving, and where the driver pulls the wrists onto). */}
                  <group ref={handLRef} position={[-0.01, 0, sign === 1 ? 0 : -gripSplit]} rotation={[0, 0, 0.15]} />
                  <group ref={handRRef} position={[0.01, 0, sign === 1 ? -gripSplit : 0]} rotation={[0, 0, -0.15]} />
                </group>
              </group>
            </group>
          </group>
        </group>
      </group>
    </group>
  )
}
