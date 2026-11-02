import { clamp } from './MathUtil.js'
import { BATTER_ACTOR, facingYaw, idleLookTarget, runFrame } from './playCast.js'

// ---------------------------------------------------------------------------
// The batter's own body, as the batter-runner.
//
// The plan says when the batter-runner goes and where he goes
// (playPlan.buildRuns, and playCast.runFrame for the walk itself). This is the
// body that walks it — and it is the *batter's* own, not a body the cast can
// draw. The cast's eleven are the seven fielders and the men on the bases,
// because the batter already stands at the plate with his own component, and the
// man who runs to first is him: drawing a second body at the plate to play the
// runner is exactly what used to put two batters there at once.
//
// So the handoff is the batter's own. At the plan's takeoff — the second his
// swing has resolved, which is what playPlan's `batterTakeoffSeconds` reads the
// swing's tuning for — Batter.jsx stops authoring the swing pose, starts the
// asset's own `Running` clip on the same bones through the same mixer plumbing
// the cast uses (util/playerClips.js), and moves its own group along the leg.
// Three things have to be true for that to read as one body walking out of the
// box rather than two poses swapped on one skeleton:
//
//   1. he leaves *where he stood*, not from the plate. The leg's own path starts
//      at home plate's centre; the batter stands a stride off it, out of the
//      box. `batterRunFrame` carries the leg by the offset between the two and
//      walks that offset off over the takeoff, so his first frame is exactly
//      where the swing left him and his last ones are exactly on the schedule
//      the rest of the play is drawn from (`enteredAt`/`takeoff` below).
//
//   2. the pose is *blended*, not cut. The skeleton he leaves is the loaded
//      stance the way home ended on, and the pose the run clip starts from is
//      another stride entirely: `poseSnapshot` keeps the stance he is leaving and
//      `blendSnapshot` eases it out as the clip's own first frames come in, over the
//      same window the box is walked off over — so the body turns and stands up
//      out of the swing into the run instead of snapping between the two.
//
//   3. the turn is the body's, not the group's. The swing's pose is authored
//      yawed inside the batter's own frame, so the takeoff's yaw is carried on
//      the group by the takeoff's own weight (`yaw` below): at zero the body is
//      exactly as the swing left it, at one it faces down the basepath, and the
//      blend between the two turns the pose and the frame together.
//
// Nothing here runs while the swing is being authored: the whole module is only
// read from the moment the play's own clock reaches the takeoff (see
// constants/playback.js's `playClock`), so no number of the tuned swing moves.
// ---------------------------------------------------------------------------

// How long the takeoff takes, in play seconds: the window the batter walks off
// the box (and the swing's stance) over, and the window the run clip is blended
// in across. Short enough to read as going on the ball, long enough that a body
// that has to turn most of the way round and stand up out of a crouch does it in
// one motion — 170 degrees and a full stride at the batter's own frame, which is
// about what a hitter's first two steps look like.
export const BATTER_RUN_TAKEOFF_SECONDS = 0.45

// The half turn between the asset's own frame and the batter's. The model's rest
// frame faces +Z (see util/batterLook.js, which paints the face, and playerKit.js
// on the frame every body drawn in it is yawed by), and the batter's own frame is
// that turned half round — the swing is authored facing -Z, at the pitcher, which
// is why Batter.jsx turns its body the way it does. `facingYaw` aims a frame's +Z
// at a target, which is the *front* for the cast and the catcher (both drawn in
// the asset's own frame); on the batter's own body the same yaw would face him
// away from the basepath he is running, so the half turn goes back on here rather
// than in the frame every other body is drawn in.
const BATTER_FRAME_TURN = Math.PI

/**
 * The batter-runner's own frame of the play: where the body that swung stands at
 * play time `t`, which clip it is playing, which way it faces, and how much of
 * the takeoff is still to be blended out.
 *
 * @param {object} run the plan's run for the batter (playPlan's `runs`, the
 *   entry whose actor is 'B' — published by BattedBall, see constants/playback)
 * @param {THREE.Vector3} origin where he stood in the box: his own group's place
 *   at the plate (the swing left him there, so it is the frame the run departs)
 * @param {number} t the play's own clock, in seconds since the ball was hit
 * @param {number|null} [enteredAt] the play time the handoff actually happened
 *   at. The clock a reader sees can be a frame past the takeoff (the plan can
 *   even arrive after it, when a live hit's runners land late), so the body
 *   anchors its departure to the moment it left rather than to the schedule's
 *   own — which is what keeps his first running frame exactly where the swing
 *   put him. Null reads as "exactly on the schedule" (the takeoff itself).
 * @returns {{position: THREE.Vector3, state: string, lookTarget: THREE.Vector3,
 *   yaw: number|null, takeoff: number}}
 */
export function batterRunFrame(run, origin, t, enteredAt = null) {
  const frame = runFrame(run, t)
  const entry = enteredAt ?? run.legs[0].start
  // The offset he is still carrying, and the share of the takeoff he is through:
  // nothing before the handoff (he is exactly where he stood), nothing after it
  // (he is exactly on the leg's own path, on the schedule the fielders are drawn
  // from), and the whole of it in between.
  const takeoff = clamp((t - entry) / BATTER_RUN_TAKEOFF_SECONDS, 0, 1)
  const offset = origin.clone().sub(runFrame(run, entry).position).multiplyScalar(1 - takeoff)
  const position = frame.position.clone().add(offset)
  // Where he looks: down the leg he is on, and — once he has arrived — the next
  // base along from the one he reached, which is the reading a settled runner
  // gets in the cast (see playCast's idleLookTarget).
  const lookTarget = frame.lookTarget ?? idleLookTarget({ kind: 'offense', key: run.endKey ?? BATTER_ACTOR })
  const aim = facingYaw(position, lookTarget)
  return {
    position,
    state: frame.state,
    lookTarget,
    // The takeoff's own share of the turn (see 3 above): null while he stands
    // still (there is no direction to face), which leaves the caller holding the
    // last one it had. It is a direction in the *batter's* own frame, so the half
    // turn between that frame and the asset's goes back on (see BATTER_FRAME_TURN).
    yaw: aim == null ? null : aim + BATTER_FRAME_TURN,
    takeoff,
  }
}

// The snapshot and the blend that carry a body out of the pose it was authored in
// and into the clips it is handed to (`poseSnapshot` / `blendSnapshot` in
// util/playerClips.js) are the *same* two the pitcher's own body is handed over
// with when a play gives him something to field — one body easing out of a pose and
// into the asset's clips is not a thing the batter's handoff should own alone, so
// they live with the clip binding every actor shares.
