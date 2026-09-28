import * as THREE from 'three'

// The batter's own kit, read off the model and put right — as distinct from the rig
// (playerRig.js), which poses the body. Five things:
//
//   * the helmet ships ear cover on *both* sides — a separate flap shell on each, and
//     a lobe of the main shells hanging beside each ear below the brim. A batting
//     helmet has one, over the ear on the side the pitcher is on (the lead side), so all
//     of it comes off the trailing side — the lobe cut away along the curve the
//     helmet's own lower edge would run, rather than along a box — and the one that
//     stays is lengthened so it covers more of the side of the face.
//   * the face wears no eyebrows: the eyes are bare plates on it, so a brow is laid over
//     the top of each one, in the face's own tone taken down.
//   * the eyes are tall enough that their tops run up behind the brim, so they are
//     scaled down until they sit clear under it — and *flat* plates on a face that
//     curves, so their edges sink into it and the nose takes their inner corners: each
//     plate is then conformed to the face it is drawn on.
//   * the jersey has no front on it, so its opening is added: a line down the chest from
//     the collar to the belt, with hollow buttons on it — drawn in the cloth's own
//     material and tone, so it is the fabric taken down rather than a grey shape laid over
//     the chest.
//   * the shoes are plain: the leg above each one runs straight into it, and there are
//     no laces on it. So each shoe gets the edge of its own sole, a tongue over the
//     instep and laces across it. The trousers already cover the leg down past the
//     shoe's own rim, so nothing is added where the shoe meets the leg.
//
// Everything is *geometry* on meshes the model already ships: the pass runs once per
// loaded body, after the rig has shaped it (see the body memo in Batter.jsx), and it
// works on its own clone of each geometry, so nothing it does can leak into the cached
// asset or into the other players on the field.
//
// The numbers below are this model's own, measured off it, in rig units, in the
// model's rest frame (which faces +Z, so its own +x is its left — the same frame
// playerRig's shapeRigidParts documents):
//
//   the helmet, 734 vertices in 7 shells: the shell, the crown, the brim, the inner
//     shell, the back shell, and two that hang down beside the face —
//       the model's left ear   58 verts, x[ 0.078,  0.196], y[1.6003, 1.8171]
//       the model's right ear  36 verts, x[-0.196, -0.122], y[1.6220, 1.8140]
//     ...and the *main* shells carry ear cover as well: hung below the brim's underside
//     (1.7954) and off the midline they reach y 1.6235 at x -0.1715 on the trailing
//     side (z -0.0227 to 0.1089, i.e. over the ear and forward of it) and y 1.6021 at
//     x 0.078 on the lead one.
//   the brim's own band runs y[1.7954, 1.821], so its underside is at 1.7954.
//   the eyes, 53 vertices each: x[0.018, 0.097] and x[-0.097, -0.018], y[1.681,
//     1.834], z[0.085, 0.136]. Their tops reach 0.039 rig *above* the brim's
//     underside, which is what hides them; and measured against the face's own surface
//     at their footprint, *half* of each plate's 53 vertices sit behind it — 36 of 53,
//     up to 0.0258 rig deep at the inner corner (the plate is at z 0.0964 beside the
//     brow, where the face's own surface is at 0.1222) — with the nose (57 verts,
//     x[-0.0342, 0.0309], y[1.6486, 1.6927], z up to 0.1394) taking the inner corners.
//   the face has nothing drawn on it above the eyes: the skin is one flat tone in the
//     atlas — 0.898, 0.773, 0.435 (a luminance of 0.775) — and the eyes are painted
//     black on it (0.059, 0.008, 0.016, a luminance of 0.05). So a brow has to be
//     drawn: darker than the skin it sits on and lighter than the eye under it, or it
//     reads as neither.
//   the jersey's own top is its collar: a rim at y 1.5544 whose front tapers in to
//     z 0.0143 by y 1.5158 (the cloth is pale blue at 0.682, 0.678, 0.804 with the
//     collar a shade darker). Above it is the *neck* — skin — and the neck's own front
//     stands proud of the collar: z 0.1003 at y 1.5586. So an opening read off the
//     body's front near the midline finds the neck above the collar and the jaw above
//     that, which is how a line drawn to 1.588 ended up on the face.
//   the jersey's front, from the trunks' band (y 1.258-1.293) up to the collar: a line
//     of vertices down the chest's centre, x 0.000, whose front runs z 0.101 at the
//     belly (y 1.30), in to 0.076 at the sternum (y 1.46) and back out to 0.100 at the
//     chest (y 1.56). The cloth is one flat colour in the atlas, read off it there:
//     0.682, 0.678, 0.804 — a pale blue with a luminance of 0.69, so a grey read off it
//     is the uniform's own grey.
//   the shoes: one shell per foot, 155 verts, x[0.015, 0.2238], y[-0.0101, 0.2992],
//     z[-0.2597, 0.1771] for the model's left, painted warm (0.847, 0.369, 0.208) at
//     every height. Above it is the trouser leg, a shell of its own that starts at
//     y 0.2716 — *below* the shoe's own rim — painted the same pale blue as the jersey:
//     the trousers already come down over the shoe. The shoe's opening — its top edge, read
//     as the highest vertex in each sector about the ankle — runs y 0.2743 at the
//     front, 0.2992 at the back, and its instep falls from 0.155 at z -0.02 to 0.098 at
//     z 0.10.

// An ear flap, looked for as a shell of the helmet that hangs *below* the crown and
// lies wholly on one side of the model's own midline. Measured above: both flaps top
// out under 1.82, and every other shell of the helmet either crosses the midline or
// carries up to the crown. A shell the pass has already taken out of the index has no
// triangles left, so it is not looked at again: the pass reads the mesh it is given
// rather than assuming it is the first to see it.
const FLAP_SIDE_MIN_X = 0.04 // how far off the midline a flap's nearest vertex sits
const FLAP_TOP_MAX_Y = 1.86 // ...and how high its own top may reach
const FLAP_MIN_VERTS = 8 // a shell rather than a vertex left over from one

// The ear cover built into the *main* shells: the geometry that hangs below the brim
// beside an ear. Where it is, read off the helmet: below the brim's underside (so the
// lengthening that is graded about its hinge can stop under it), off the midline, and
// forward of the nape (the back shell reaches down to z -0.2239 there, and that is the
// helmet's own back, not an ear cover).
const EAR_COVER_SIDE_X = 0.06
const EAR_COVER_FRONT_Z = -0.055
// ...and what taking that cover off leaves behind: the band of the main shell that
// still hangs beside that ear, down to its own lower rim at y 1.6442 just behind the
// ear (x -0.1816, z -0.0229) — 0.15 rig below the brim. That band is what still reads
// as a rear ear flap, and it goes too: the shell comes off along the curve a helmet
// that never had the cover ends on.
//
// Read as a curve rather than as a box, because where the edge runs is the whole of
// how it reads. Cut off level, the helmet keeps a straight edge across the side of the
// face with a step at each end of it, which is what a cutout looks like — and the step
// in front of the ear, where the edge has to climb back up to the brim over a short
// stretch of z, is the worst of it. A helmet's own edge sweeps: lowest just behind the
// ear, rising forward to meet the brim's underside in front of it, where the shell and
// the brim are one edge anyway, and falling away behind it into the nape's own line —
// y 1.6584 at z -0.10, rising to 1.6831 at z -0.17 — which is the helmet's back and is
// left alone.
//
// Read as one curve with the slope turning through it rather than as a run of its own
// stations joined by smoothsteps. Each smoothstep is level at both of its own ends, so
// the run of them draws a level rim across the side of the face — 0.14 of z carrying
// 0.02 of height, dead flat at the ear — with a step where it turns down into the nape:
// a level edge with a corner in it, which is a rectangle. A cubic through the same
// stations, with the slope stated at each of them (see EAR_EDGE_SLOPE_*), leaves the
// edge one continuous curve the whole way: level where it leaves the brim's underside,
// turned over the ear, and steep by the time it reaches the nape's line, which is the
// sweep a shell cut out of a dome ends on.
//
// ...and *turned* where it meets the brim, rather than squared off against it: the slope
// the edge arrives at the level run with is nought (see EAR_EDGE_SLOPE_FRONT). A slope of
// its own there is exactly a corner — the edge runs dead level under the brim and then
// breaks down through the 0.02 of height to the ear inside one station's worth of z — and
// it is in front of the ear, where the eye is looking. Reaching the level with no slope
// of its own makes the two one sweep: the edge eases off the brim and builds its descent
// as it comes over the ear, so what is left in front of the ear is a rounded turn rather
// than a step.
const EAR_EDGE_FRONT_Z = 0.12 // in front of the ear the cover ends by here...
const EAR_EDGE_FRONT_Y = 1.7954 // ...at the brim's own underside
// ...and the edge runs on *under the brim* to the cover's own front end: the model's two
// sides are not mirror images, and the cover it ships on its left ear is the long one —
// measured, that side's shell still hangs below 1.79 out to z 0.181 (at x 0.097, y 1.63),
// against the right ear's 0.116. Read as one number for the *cover* rather than for a
// side, because it is the model's asymmetry and not the batting hand that decides where
// the cover stops: a right-handed batter's trailing side is the right ear, whose cover is
// already inside EAR_EDGE_FRONT_Z, but a *left-handed* one's is the left ear, and there the
// band from z 0.12 to 0.18 is left hanging beside the face — a lobe of shell under the brim
// in front of the ear, which is exactly the ear flap the pass exists to take off. Between
// the two stations the edge sits at the brim's own underside, so the fold it leaves is
// under the brim rather than across the temple.
const EAR_EDGE_COVER_Z = 0.19 // the cover's own front end: nothing hangs below 1.79 past here
const EAR_EDGE_EAR_Z = -0.02 // over the ear's own back edge the edge is at its lowest...
// ...and there the edge is at the ear's own *middle*: the head's ear runs y 1.7346 to
// 1.8165 (at |x| 0.147 to 0.1725, z -0.0187 to 0.0531), so an edge at 1.7756 covers the
// top half of it and leaves the bottom half showing. Read as a height rather than as
// "clear of the ear", because a rim hung down to the ear's own bottom (1.72, measured
// on the first pass at this) is a lobe of shell hanging 0.075 below the brim beside that
// ear — an ear flap where there is no flap, and one that read as a jaw guard. Half an
// ear covered is what a helmet that has no flap over it looks like.
const EAR_EDGE_EAR_Y = 1.7756 // the ear's own middle: 1.7346 + (1.8165 - 1.7346) / 2
const EAR_EDGE_NAPE_Z = -0.10 // and behind the ear it has reached the nape's line by here...
const EAR_EDGE_NAPE_Y = 1.6584 // ...at the nape's own height, which is not touched behind it
// ...and the slope the edge carries into each of them, in rig of height per rig of z: none
// at all where it meets the brim's level run (the brim's own underside is level and the
// shell and the brim are one edge there — see the note above: a slope of its own stated
// there is the corner), turned over by the time it is above the ear, and steep at the
// nape, where the helmet's own back edge is already falling away at 0.35 and the two of
// them meet. Measured, the edge then holds its level to within 0.001 of the brim out to
// z 0.06 — against the 0.11 the old slope held it to — and comes down over the 0.14 of z
// between there and the ear's own station all the same, which is the turn spread across
// the stretch instead of taken at the corner.
const EAR_EDGE_SLOPE_FRONT = 0.0
const EAR_EDGE_SLOPE_EAR = 0.50
const EAR_EDGE_SLOPE_NAPE = 1.90

// Lengthening the cover that stays: it hangs from a hinge under the crown, so it may
// only be stretched about that hinge, graded, so the surface it hangs from is not torn.
// It is a jaw guard, so the deeper it goes the further forward it belongs: measured,
// the lead side's ear cover runs y 1.6021 to 1.8148 with the hinge at 1.82, so a
// stretch of 0.24 takes its bottom to 1.5472 — level with the jaw — and carries the
// deepest part 0.03 forward with it, over the cheek, the way a real flap's edge flares
// off the face.
const FLAP_HINGE_Y = 1.82
// ...and it lengthens the *guard*, not the brim: the brim's own band runs y 1.7915 to
// 1.821, low enough to fall inside the cover's region, and pulling it down with the
// guard would tilt the brim's outer edges and eat into the clearance under it, so the
// lengthening stops below it. Nothing is torn by that: the stretch is graded by how far
// below the hinge a vertex hangs, so it is already at a hair's breadth up there.
const FLAP_TOP_Y = 1.78
const FLAP_STRETCH = 1.24
const FLAP_FORWARD = 0.03

// The eyes: small shells on the face's own front. Measured above; the head's own ears
// (z <= 0.003) and its nose (which crosses the midline) are what this has to tell them
// apart from.
const EYE_VERT_MIN = 20
const EYE_VERT_MAX = 90
const EYE_FRONT_MIN_Z = 0.05
const EYE_BOTTOM_MIN_Y = 1.6
const EYE_TOP_MAX_Y = 1.9
// How much of its own size an eye keeps: exactly enough for its top to come in under
// the brim, which is the whole reason for taking it down. The brim's own band runs
// y[1.7954, 1.821], so an eye is aimed at 1.785 and is taken down about its own bottom
// edge, which keeps it on the face it is drawn on. Measured, that is 0.68 of its own
// height — from a top at 1.834 to 1.785 — and the eye then reads 0.104 by 0.054. The
// body-parts model's own eye is 0.265 of its head's height (see the README); this
// model's head is 0.355 tall, so 0.094 would be the reference's own eye and this one
// is a shade bigger, which is what was asked for.
//
// Read as a target rather than as a factor, so the pass is idempotent: an eye already
// under the brim is left alone, and one that is somehow over it is taken down without a
// second pass compounding the first.
// The eye is taken down to here and no further: the brim's underside is at 1.7954, so
// this leaves 0.025 rig of clearance under it — and leaves the room *above* the eye a
// brow needs, which is the whole of what there is: skin (BROW_GAP_Y) and the brow itself
// (BROW_DEPTH_Y and its arch) come to 0.029. Measured, the eye ends up 0.089 rig tall,
// against the 0.094 the reference model's own proportions call for.
const EYE_TOP_CLEAR_Y = 1.7664
const EYE_SCALE_MIN = 0.5 // ...and never below this share of its own size, whatever the brim says
// ...and then out onto the face: a plate is flat and the face is not, which is what put
// *half* of each eye's 53 vertices inside it — 36 of 53 on the one measured, up to 0.026
// rig deep at the inner corner, where the plate's own edge runs into the cheek. The
// head's own shells are coarse (the face is 63 vertices for the whole thing), so the
// front has to be read as a *surface*: the triangles that cover a point looking down the
// model's own front, interpolated at it and taken front-most. A reading taken off the
// nearest vertices misses the surface between them, and the surface between them is
// exactly what a flat, eyelid-shaped plate sinks into. Every eye vertex is then put this
// far in front of that surface — the eyes themselves excluded from the reading, so a
// plate cannot hold itself up.
const EYE_FACE_CLEAR = 0.003

// The brows: the face has nothing drawn on it above the eyes, so one is laid *above*
// each eye plate — clear of it, with skin between the two, which is what makes what
// reads a brow over an eye rather than one long dark shape. Sized off the eye it belongs
// to (its own ends, plus an overhang at each, so it is longer than the eye under it — and
// longer still towards the ear than towards the nose, because that is the way a brow
// runs) and drawn in the face's own tone taken down per channel into a brown: measured,
// the skin is 0.775 in luminance and the eye 0.05, so the brow lands dark against the
// face it sits on and clear of the eye below it. It stays under the brim's underside
// (1.7954), which is the whole of the room above an eye.
//
// The room above an eye is fixed at 0.029 rig (the eye's top at 1.7664, the brim at
// 1.7954), and a *thicker* brow is bought out of it: the skin band, the brow's own depth
// and its arch are all three paid for out of that 0.029. Measured, the first pass gave the
// skin 0.010 and the brow 0.0136 with a 0.003 arch; the skin band is cut to the suite's own
// 0.009 (0.0092, a hair over it) and the arch to 0.0015, which is what lets the 0.016 the
// shape was drawn for fit: the brow's depth is 0.0160 as drawn, a hair thicker than the
// 0.0136 the brim used to leave room for.
const BROW_GAP_Y = 0.0092 // skin between the top of the eye and the bottom of the brow
const BROW_DEPTH_Y = 0.016 // ...and how deep the brow itself is (0.0160 as drawn)
const BROW_TOP_MAX_Y = 1.7932 // never past here: the brim's underside is at 1.7954, the
// ...suite wants 0.002 of room under it, and the brow's own middle arches BROW_ARCH above
// ...the rest of it
// How much longer than its own eye a brow is at each end: in towards the nose, and out
// towards the ear, which is the end that runs on towards the temple.
const BROW_OVERHANG_IN_X = 0.010
const BROW_OVERHANG_OUT_X = 0.024
const BROW_ARCH = 0.0015 // how much higher its middle rides than its own ends
// The brow's own shape: a rectangle with its four corners rounded, and nothing else
// tapered. An eye is a rounded plate — its own outline turns at every corner — so a bar
// laid over one has to turn at its corners too; but an *oval* end, which is what a taper
// over the last sixth of the brow's length draws, reads as a leaf laid beside the eye
// rather than as a brow over it. So the two long sides stay straight and full-depth to the
// last station and only the four corners are filleted: a quarter-circle of this radius at
// each of them, with the end left as a short vertical edge between the two — a squircle,
// which is what a brow drawn on a face at this size is.
//
// Read against the brow's own half-depth (0.008): the corner is 0.8 of it, so a corner is
// nearly a round end — the bar closes to four fifths of its depth 0.0064 in from either
// end, and what is left of the end edge itself is 0.0032 against a middle of 0.008, a
// fifth of it. What that reads as is a bar with its corners turned, which is a brow; an
// oval is not: the two long sides still run full-depth along most of it. Sized in rig
// rather than as a share of the brow's own length, so both ends of both brows turn the
// same way however the overhangs fall, and the walk across it is bunched towards the ends
// (see BROW_SAMPLES) because a corner this size is a stretch of the brow and wants
// stations under it to be drawn as a turn rather than as a chamfer. It costs the brow
// nothing it is read by: the *depth* a station is at is the full half-depth from a
// corner's radius in — measured, the box the brows span is 0.0171 deep against the box
// they spanned before any of it was turned (0.0175), and against the suite's own 0.012
// floor.
const BROW_CORNER_R = 0.0064
const BROW_SAMPLES = 30 // how many stations across it follow the face, bunched towards
// ...the two ends, where its own corners are
const BROW_LIFT_Z = 0.005 // how far in front of the face it stands, over the eye's own 0.003
// The face's own tone, taken down *per channel* into a brown: skin darkened evenly comes
// back grey, and a brow is not grey. Measured against the face's own texel (0.898, 0.773,
// 0.435) this is (0.238, 0.100, 0.027) — a brown, at a luminance of 0.12, against 0.161
// before the second darkening pass and 0.226 on the first (the eye it sits above is
// painted black at 0.05, so it stays well clear of that).
const BROW_BROWN = [0.265, 0.13, 0.062]
const FACE_FALLBACK = [0.898, 0.773, 0.435] // the face's own texel, measured above

// The jersey's opening: a line down the chest, and hollow buttons on the cloth beside
// it. Its own height is read off the model (below); these are how it is drawn.
//
// It is *part of the jersey's own mesh* — the same geometry, the same material, the same
// atlas texel under it, the same skin weights, lit by the cloth's own normal and blended
// into the cloth's own vertex colour taken down (see weldDetail and addJerseyFront) — so
// what the chest wears is the fabric, darkened: a seam. That is the whole of what a piece
// of detail laid on the body has to get right to stop reading as a card stuck to it. A
// second mesh is a decal whatever its stand-off: measured, the earlier opening was a flat
// grey strip of a strip, pale enough against the cloth that it read as a sprite laid over
// the chest, with the buttons beside it as a second one — and, once its colour was the
// cloth's own, still a second *surface*, which the cloth's own facets then drew in front
// of wherever the pose sheared them apart.
const LINE_HALF_WIDTH = 0.0015 // 0.003 rig across: a line drawn on the cloth, not a ribbon
// How far the opening stands off the jersey. It is drawn *on* the cloth — the fabric's own
// material, the fabric's own normal, the fabric's own tone taken down — so what is left to
// get right is only that the line is not *behind* it, and the cloth moves under the pose.
//
// That last part is the whole of the number. The line is read off the cloth's triangles in
// the model's own frame; the cloth is coarse (a few facets across the chest) and the pose
// shears it, so a point placed exactly on the surface as the model ships can end up
// 0.0024 rig *inside* the cloth as it stands. Measured with the ribbon's own stations: in
// the set stance every one of them sat 0.0019 to 0.0024 rig behind the cloth it was drawn
// on, which is why the opening read along the upper chest — where the facets agree — and
// vanished across the belly, where they do not. The lift has to clear that shear and a
// little more; past it the tone does the rest. It stood at 0.0015 (which lost the belly to
// the cloth) and before that at 0.008-0.014 (which read as a ribbon laid over the chest,
// a third of a button's own height off the surface). This is a third of the way back to
// the first of those and still under a fifth of the second: at this model's scale it is
// about three millimetres of stand-off, and it is the *shading* — the cloth's own normal,
// the cloth's own tone — that keeps the line reading as a seam in the fabric rather than
// a strip laid on it.
const LINE_LIFT = 0.005
const LINE_FROM_Y = 1.293 // the belt's own top edge, read off the model's texture (the
// ...trunks' band runs y 1.258-1.293 — see `the twist reads at the waistband`): the
// ...opening ends just before the belt, not short of it and not on it
const LINE_TO_Y = 1.548 // ...and up to the jersey's *own* collar, whose rim is at 1.5544
const LINE_BANDS = 24 // how many rings of the line follow the surface
// The buttons: hollow rings, on the cloth beside the line, from the collar down to the
// belt. A men's jersey buttons on the wearer's right, which is the model's -x.
//
// Buttons are *on* the opening, not beside it: a men's placket is one piece of cloth with
// the seam down its edge and the buttons a buttonhole's width in from it, so the rings are
// set hard against the line — measured, the outward edge of a ring now comes to 0.0015 rig
// from the seam's own edge, where at 0.0215 out it stood 0.0085 clear of it. Two columns
// of grey a centimetre apart on a bare chest are two things laid on the jersey; one column
// of rings down the seam is a jersey that buttons.
const BUTTON_COUNT = 6
const BUTTON_X = -0.0145
const BUTTON_MARGIN_Y = 0.006 // the first and last sit this far inside the line's own ends
const BUTTON_OUTER_RADIUS = 0.0115
const BUTTON_INNER_RADIUS = 0.0055
const BUTTON_SEGMENTS = 12
const BUTTON_LIFT = 0.0009 // a hair proud of the line's own face: a ring read on the
// ...cloth, not a stud standing off it
// How far down the cloth's own colour each is taken, per channel: the jersey is one flat
// colour in the atlas, so both tones are read off *that* colour rather than kept in two
// places, and neither is a grey of its own — a seam in pale blue fabric is the same fabric
// without so much light in it. Measured, the cloth is (0.682, 0.678, 0.804) and a seam
// drawn at 0.78 of it — three quarters of the cloth — read too light to see on it: a seam
// is *darker* than the cloth it is sewn in. So both come down: the seam to 0.42 of the
// cloth, the buttons to 0.62, which keeps the buttons a shade brighter than the seam and
// both of them the jersey's own blue rather than black. Measured on the render, a seam at
// 0.42 of the cloth reads 0.29 in luminance against the cloth's 0.69 — a line drawn on the
// chest rather than a suggestion of one, which is what the opening at half the cloth was.
const LINE_GREY = 0.42
// ...and the buttons are the opening's own tone, not a shade off it: a placket's buttons
// are sewn in the cloth the seam is, so the two are one colour down the chest.
const BUTTON_GREY = LINE_GREY
const JERSEY_FALLBACK = [0.169, 0.424, 0.69] // the tuning's own jersey blue
const SHOE_FALLBACK = [0.847, 0.369, 0.208] // the shoe's own texel, measured above

// The shoes. Everything below is read off the shoe's own shell: the edge of its sole
// follows its rim on the ground, and the laces their own stations across the instep.
//
// Nothing is added where the shoe meets the leg. Measured, the trousers already cover
// the leg down past the shoe's own rim — the leg shell reaches y 0.2716 and the shoe's
// rim is at 0.2992 — so a sock is never seen above a shoe, and a collar over the shoe's
// opening or a cuff above that is a band that reads as a sock pulled out over the
// trouser: it was the white band above each ankle in the kit's own reference shots,
// which is why the model no longer wears one.
const SHOE_MIN_VERTS = 60 // a shoe is a shell, not a scrap left over from one
const SHOE_TOP_MAX_Y = 0.36 // ...and a shoe is below the knee
const SHOE_SEGMENTS = 16 // how many samples go round the shoe for its bands
const SOLE_OFFSET_Y = 0.03 // the sole's edge, this far up from the ground
const SOLE_DEPTH = 0.022
const SOLE_PROUD = 0.004
const SOLE_SHARE = 0.62 // the sole's edge and the tongue, as a share of the shoe's own colour
// The laces: bars across the instep, from the throat of the shoe forward over the rise
// of the foot and down towards the toe. Each bar is laid on the shoe's *own* top surface
// — sampled from the shell, so a re-export cannot leave them floating — and stops short
// of the shoe's edge on both sides. Laces are not the shoe's colour, so they take the
// uniform's own pale tone instead, lifted towards white.
const LACE_Z = [0.0, 0.024, 0.048, 0.072, 0.096, 0.12]
//
// ...and every face of them looks *up*. A bar is a strip across the shoe's top surface,
// built row by row across the foot and row by row along it, and wound that way it comes
// out facing down — into the shoe — which is a face the renderer draws from behind and
// so never draws at all. Measured, that is exactly what the laces were: twelve bars of
// them on the model and not one of them on screen, with only their own edges catching.
// So the tongue and the bars are both wound by the surface they lie on (see faceUp).
const LACE_HALF_WIDTH = 0.008 // the bar's own width along the foot
// How far in from the shoe's own ridge a bar stops. Measured, the ridge is a *reading*
// of the shoe's upper face (0.128 rig across at its widest) rather than the laced part
// of it, so a bar run right out to it walks down the rounded side of the shoe and hangs
// there as a fringe: this is what keeps the bars on the face of the shoe, between the
// rows of eyelets a laced shoe has.
const LACE_INSET_X = 0.021
const LACE_LIFT = 0.01 // standing off the surface, over the tongue
const LACE_THICKNESS = 0.005 // ...and how deep the bar is, so it is a lace and not paper
const LACE_SAMPLES = 7
const LACE_WHITEN = 0.9 // how far the trouser's own pale tone is taken towards white
// The tongue, under them: a pad over the instep in the shoe's own tone taken down, so
// the front of the shoe has a piece to it — and a darker surface for the laces to be
// laces *across* — rather than one unbroken surface from toe to collar.
// Where it starts: at the first lace bar, not at the shoe's throat — the shell's own top
// at the throat *is* the shoe's opening, 0.28 rig up the ankle, so a pad run back to it
// climbs the leg instead of lying on the instep.
const TONGUE_BACK_Z = 0.0
const TONGUE_FRONT_Z = 0.13 // ...and how far down the instep it runs
const TONGUE_BANDS = 3 // how many rows of it follow the shoe's own surface
const TONGUE_INSET_X = 0.021 // how far in from the shoe's own ridge it stops
const TONGUE_LIFT = 0.003 // under the laces, but off the shoe
// How far down the shoe's own tone is taken for the tongue. Measured, a panel this
// flat faces the light *up* the way the curved shoe around it does not, so at 0.7 of
// the shoe's tone it came out lighter than the shoe it is supposed to sit *in*. Taken
// down to 0.45 it reads as the recessed instep the laces are laced across.
const TONGUE_SHARE = 0.45

const clamp01 = (value) => Math.min(1, Math.max(0, value))

// What a value has to be *multiplied* by to go back into a vertex attribute's own
// storage. Reading is the other way round and needs nothing: the body's colour rides in
// an unsigned byte array marked normalised (COLOR_0 in the glTF), and three's own
// `getX` hands that back as the 0-1 the shader sees — the 0-255 is only what the array
// holds, which is what writing to it has to produce.
function storageScale(attribute) {
  const array = attribute?.array
  if (!array || array instanceof Float32Array || array instanceof Float64Array) return 1
  return attribute.normalized ? (2 ** (array.BYTES_PER_ELEMENT * 8)) - 1 : 1
}

// One vertex of the body, as the colour the shader would draw it in: the toned-down
// detail welded onto it is *this* taken down, so the seam and the shoe's edge are the
// cloth and the leather they are sewn in rather than a tone of their own that has to be
// kept in step with the model by hand.
// A welded strip's uv, carried into the copy of its island that leaves it nearest the
// vertex before it in the strip. The model's atlas is packed with copies of the same
// island — the cloth's own triangles across the belly carry u 1.50 and the ones above
// them u 0.50 for the same patch of fabric — and sampling a *point* in either is exact,
// because they are the same texel. A quad drawn between two of them is not: it
// interpolates the whole way across the atlas in between, which is how a seam in pale
// blue came out with a band of the uniform's red trim through it. A strip is therefore
// unwrapped along itself, whole units at a time, so every quad's two ends are the two
// copies of the island that agree.
function unwrapUv(previous, uv) {
  if (!uv || !previous) return uv
  let [u, v] = uv
  while (u - previous[0] > 0.5) u -= 1
  while (previous[0] - u > 0.5) u += 1
  while (v - previous[1] > 0.5) v -= 1
  while (previous[1] - v > 0.5) v += 1
  return [u, v]
}

function colourAt(geometry, vertex) {
  const attribute = geometry.getAttribute('color')
  if (!attribute) return [1, 1, 1]
  return [attribute.getX(vertex), attribute.getY(vertex), attribute.getZ(vertex)]
}

// The shells of a mesh's geometry: the model is one mesh per body part, so its separate
// pieces (the helmet's flaps, the eyes, the nose) are separate closed surfaces in one
// index buffer. Union-find over the triangles is the whole of it.
function shellsOf(geometry) {
  const index = geometry.getIndex()
  const count = geometry.getAttribute('position').count
  if (!index) return [Array.from({ length: count }, (_, i) => i)]
  const parent = new Int32Array(count)
  for (let i = 0; i < count; i += 1) parent[i] = i
  const find = (start) => {
    let root = start
    while (parent[root] !== root) root = parent[root]
    let walk = start
    while (parent[walk] !== root) {
      const next = parent[walk]
      parent[walk] = root
      walk = next
    }
    return root
  }
  const array = index.array
  for (let i = 0; i < array.length; i += 3) {
    parent[find(array[i + 1])] = find(array[i])
    parent[find(array[i + 2])] = find(array[i])
  }
  const byRoot = new Map()
  for (let i = 0; i < count; i += 1) {
    const root = find(i)
    if (!byRoot.has(root)) byRoot.set(root, [])
    byRoot.get(root).push(i)
  }
  return [...byRoot.values()]
}

function boundsOf(geometry, vertices) {
  const position = geometry.getAttribute('position')
  const box = { x: [Infinity, -Infinity], y: [Infinity, -Infinity], z: [Infinity, -Infinity] }
  for (const vertex of vertices) {
    box.x[0] = Math.min(box.x[0], position.getX(vertex))
    box.x[1] = Math.max(box.x[1], position.getX(vertex))
    box.y[0] = Math.min(box.y[0], position.getY(vertex))
    box.y[1] = Math.max(box.y[1], position.getY(vertex))
    box.z[0] = Math.min(box.z[0], position.getZ(vertex))
    box.z[1] = Math.max(box.z[1], position.getZ(vertex))
  }
  return box
}

/**
 * The helmet's own ear flaps, in the model's rest frame: the shells that hang below the
 * crown and lie wholly on one side of the midline. Returned in the model's own terms,
 * where +x is its left — the side the pitcher is on for a right-handed batter.
 */
export function earFlapsOf(geometry) {
  return shellsOf(geometry)
    .filter((vertices) => vertices.length >= FLAP_MIN_VERTS
      && trianglesOf(geometry, vertices) > 0)
    .map((vertices) => ({ vertices, box: boundsOf(geometry, vertices) }))
    .filter(({ box }) => box.y[1] < FLAP_TOP_MAX_Y
      && (box.x[0] >= FLAP_SIDE_MIN_X || box.x[1] <= -FLAP_SIDE_MIN_X))
}

/**
 * The eyes: the small shells lying on the face's own front. Read as shells rather than
 * as vertex ranges, so a re-export of the model cannot silently move them.
 */
export function eyeShellsOf(geometry) {
  return shellsOf(geometry)
    .filter((vertices) => vertices.length >= EYE_VERT_MIN && vertices.length <= EYE_VERT_MAX)
    .map((vertices) => ({ vertices, box: boundsOf(geometry, vertices) }))
    .filter(({ box }) => box.y[0] >= EYE_BOTTOM_MIN_Y && box.y[1] <= EYE_TOP_MAX_Y
      && box.z[0] >= EYE_FRONT_MIN_Z
      && (box.x[0] > 0.004 || box.x[1] < -0.004))
}

/**
 * The shoes: one shell per foot, below the knee and off the midline — the surface the
 * collar, the sole's edge and the laces are all read off.
 */
export function shoeShellsOf(geometry) {
  return shellsOf(geometry)
    .filter((vertices) => vertices.length >= SHOE_MIN_VERTS)
    .map((vertices) => ({ vertices, box: boundsOf(geometry, vertices) }))
    .filter(({ box }) => box.y[1] < SHOE_TOP_MAX_Y && box.y[0] < 0
      && (box.x[0] > 0.01 || box.x[1] < -0.01))
}

// How many triangles still draw a shell: none, for a shell an earlier pass has already
// taken out of the index.
function trianglesOf(geometry, shell) {
  const index = geometry.getIndex()
  if (!index) return 0
  const wanted = shell instanceof Set ? shell : new Set(shell)
  const array = index.array
  let count = 0
  for (let i = 0; i < array.length; i += 3) {
    if (wanted.has(array[i]) || wanted.has(array[i + 1]) || wanted.has(array[i + 2])) count += 1
  }
  return count
}

// Drop a shell from a mesh: the triangles that reference it go, and its vertices are
// left where they are (nothing draws them). Rebuilding the index is cheaper and far
// safer than compacting every attribute, and it cannot disturb the skin weights the rig
// has just shaped.
export function dropShell(geometry, shell) {
  const index = geometry.getIndex()
  const dropped = shell instanceof Set ? shell : new Set(shell)
  const array = index.array
  const kept = []
  for (let i = 0; i < array.length; i += 3) {
    if (dropped.has(array[i]) || dropped.has(array[i + 1]) || dropped.has(array[i + 2])) continue
    kept.push(array[i], array[i + 1], array[i + 2])
  }
  geometry.setIndex(new THREE.BufferAttribute(new array.constructor(kept), 1))
  return (array.length - kept.length) / 3
}

// Drop the triangles that lie wholly inside a region of the mesh: how the ear cover
// built into the helmet's main shells comes off without disturbing the dome it hangs
// from. A triangle goes only when *all three* of its corners are in, so the surface
// keeps its own edge along the region's boundary.
export function dropRegion(geometry, inside) {
  const index = geometry.getIndex()
  const position = geometry.getAttribute('position')
  const array = index.array
  const kept = []
  for (let i = 0; i < array.length; i += 3) {
    const [a, b, c] = [array[i], array[i + 1], array[i + 2]]
    if (inside(position, a) && inside(position, b) && inside(position, c)) continue
    kept.push(a, b, c)
  }
  geometry.setIndex(new THREE.BufferAttribute(new array.constructor(kept), 1))
  return (array.length - kept.length) / 3
}

// Take the shell's lower edge back up onto the line the cover comes off by, without
// dropping a single triangle: every vertex that hangs *below* that line is put *on* it.
//
// Cutting the band away is not available. The band and the shell it hangs from are one
// surface, and the line is a curve limited to the stretch of the head the ear is on, so
// the piece to remove is not a half-space and no clipping plane expresses it; and dropping
// whole triangles — a triangle goes only when all three of its corners are in the piece —
// leaves the rim ragged by up to a triangle's own height, and, where every corner of a
// triangle is outside the piece while its own surface is mostly inside it, a plate of the
// cover is left hanging beside the ear: measured, 56 vertices up to 0.162 rig below the
// line, which is a jaw guard on the side of the helmet that has no flap.
//
// A cubic through two stations with a stated slope at either end: how the edge above is
// carried between the stations it was measured at, so it is one curve rather than the
// level runs and steps a pair of smoothsteps leaves.
function hermite(z, z0, y0, m0, z1, y1, m1) {
  const h = z1 - z0
  const t = (z - z0) / h
  const t2 = t * t
  const t3 = t2 * t
  return (2 * t3 - 3 * t2 + 1) * y0
    + (t3 - 2 * t2 + t) * h * m0
    + (-2 * t3 + 3 * t2) * y1
    + (t3 - t2) * h * m1
}

// Moving the vertices instead keeps the surface whole. The band's own triangles collapse
// to nothing along the line (a triangle with all three corners on it has no area), the
// wall above the line is left exactly as the helmet's own shape has it, and the edge the
// shell ends with is the line itself, to the resolution of the mesh. It is idempotent by
// construction — a vertex already on the line is not below it — and nothing outside the
// line's own stretch of the head is touched, so the nape and the brim keep their edges.
function foldOntoEdge(geometry, { edge, side }) {
  const position = geometry.getAttribute('position')
  let folded = 0
  let lowY = Infinity
  for (let vertex = 0; vertex < position.count; vertex += 1) {
    const x = position.getX(vertex)
    const y = position.getY(vertex)
    if (!side(x)) continue
    const on = edge(position.getZ(vertex))
    if (!Number.isFinite(on) || y >= on) continue
    position.setY(vertex, on)
    lowY = Math.min(lowY, on)
    folded += 1
  }
  if (folded) position.needsUpdate = true
  geometry.boundingBox = null
  geometry.boundingSphere = null
  return { folded, lowY: Number.isFinite(lowY) ? lowY : null }
}

// Scale a shell about a point of its own: an eye is taken down about its own bottom
// edge, so it shrinks where it hangs rather than sliding up the face. Uniform, so the
// painted eye inside it keeps its own shape.
export function scaleShell(geometry, shell, scale, about) {
  const position = geometry.getAttribute('position')
  for (const vertex of shell) {
    position.setXYZ(
      vertex,
      about.x + (position.getX(vertex) - about.x) * scale,
      about.y + (position.getY(vertex) - about.y) * scale,
      about.z + (position.getZ(vertex) - about.z) * scale,
    )
  }
  position.needsUpdate = true
}

// A colour read off the model's own base-color texture at one of its vertices — the same
// "read it off the model" rule the waistband uses, so the kit's detail is the uniform's
// own tone rather than numbers kept in two places.
function texelAt(mesh, geometry, vertex) {
  const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
  const map = material?.map
  const image = map?.image
  const uv = geometry.getAttribute('uv')
  if (!image || !uv || typeof document === 'undefined' || vertex == null || vertex < 0) return null
  try {
    const canvas = document.createElement('canvas')
    canvas.width = image.width
    canvas.height = image.height
    const context = canvas.getContext('2d', { willReadFrequently: true })
    context.drawImage(image, 0, 0)
    // The atlas may be laid out with a mirrored copy a whole unit of u away (this one
    // is), so the texel is taken in the unit the UV falls in.
    const u = uv.getX(vertex)
    const v = uv.getY(vertex)
    const row = map.flipY ? 1 - v : v
    const px = Math.min(image.width - 1, Math.max(0, Math.floor((u - Math.floor(u)) * image.width)))
    const py = Math.min(image.height - 1, Math.max(0, Math.floor(row * image.height)))
    const data = context.getImageData(px, py, 1, 1).data
    return [data[0] / 255, data[1] / 255, data[2] / 255]
  } catch {
    return null
  }
}

// The vertex whose own position is nearest a place on the body: how a piece of detail
// is skinned by the body it is hung on, and sampled for its colour.
function nearestVertex(position, x, y, z) {
  let best = -1
  let bestDistance = Infinity
  for (let vertex = 0; vertex < position.count; vertex += 1) {
    const dx = position.getX(vertex) - x
    const dy = position.getY(vertex) - y
    const dz = position.getZ(vertex) - z
    const distance = dx * dx + dy * dy + dz * dz
    if (distance < bestDistance) {
      bestDistance = distance
      best = vertex
    }
  }
  return best
}

// The jersey's own colour: the texel at the front-most vertex of the chest, which is
// the cloth the opening is drawn on.
function jerseyColourOf(body) {
  const position = body.geometry.getAttribute('position')
  let best = -1
  for (let vertex = 0; vertex < position.count; vertex += 1) {
    if (Math.abs(position.getX(vertex)) > 0.05) continue
    const y = position.getY(vertex)
    if (y < LINE_FROM_Y || y > LINE_TO_Y) continue
    if (best < 0 || position.getZ(vertex) > position.getZ(best)) best = vertex
  }
  return texelAt(body, body.geometry, best) ?? JERSEY_FALLBACK
}

// The shoe's own colour, and the trouser leg's above it: read off the model at the top
// of the shoe's instep — the front of the foot, where the shoe's own paint is — and at
// the leg above it, so what is added is the kit's own tones.
function shoeColourOf(body, shells) {
  const position = body.geometry.getAttribute('position')
  let shoe = -1
  let pant = -1
  for (const { vertices } of shells) {
    for (const vertex of vertices) {
      if (position.getZ(vertex) < 0.03) continue
      if (shoe < 0 || position.getY(vertex) > position.getY(shoe)) shoe = vertex
    }
  }
  for (let vertex = 0; vertex < position.count; vertex += 1) {
    const y = position.getY(vertex)
    if (y < 0.36 || y > 0.5) continue
    if (pant < 0 || y < position.getY(pant)) pant = vertex
  }
  return {
    shoe: texelAt(body, body.geometry, shoe) ?? SHOE_FALLBACK,
    // The trouser leg's own pale tone, which the laces take towards white: laces are
    // the kit's cloth, not the shoe's own orange.
    pant: texelAt(body, body.geometry, pant) ?? [0.682, 0.678, 0.804],
  }
}

// The jersey's own chest, as the vertices the opening is allowed to be drawn on: the
// shells that carry its front. They reach down to the belt and stop at the jersey's own
// collar — whose rim is at y 1.5544 — and their own front is the chest's (z 0.101 at
// the belly), where the back's shells are behind z -0.08.
//
// Read as shells rather than as "the body's front near the midline" because the *neck*
// stands proud of the collar: measured, the neck's own front is at z 0.1003 by y 1.5586
// against the collar's 0.0143, with the jaw above that. So a front read off the whole
// body finds the neck the moment the line reaches the collar and the jaw above it —
// which is how the opening came to be drawn up onto the face.
const CHEST_TOP_MAX_Y = 1.56 // the jersey's own collar rim is at 1.5544
// The bones that carry the torso's own cloth. The chest is read off the triangles those
// bones hold, rather than off a shell or a column of vertices, because the body is one
// mesh: the *arms* swing across the front of the belly (measured in the set stance, the
// lead forearm passes 0.26 rig in front of the opening's lower half) and the *neck*
// stands proud of the collar, so a front read off whatever is nearest the midline finds
// an arm or the neck instead of the cloth.
const TORSO_BONES = ['spine', 'spine001', 'spine002', 'spine006',
  'shoulderL', 'shoulderR', 'pelvisL', 'pelvisR']
const CHEST_FRONT_MIN_Z = 0.02 // ...and how far out a triangle has to reach to be its front
const CHEST_WINDOW = 0.045 // how far either way of a station a covering triangle may sit

// The jersey's own front, as the surface the opening is drawn on: the torso's own cloth
// triangles, and — at a station on them — how far forward that surface runs, the skinning
// that same point has and the cloth's own shading there, all three interpolated across the
// triangle that covers the station.
//
// Read off the *triangles* rather than off the vertices near the station, because a
// surface drawn between two vertices bulges forward of both of them: measured at the
// belly, the drawn facet runs 0.003 rig forward of the front-most vertex within the
// station's own window, which is more than the line's whole stand-off.
function chestSurfaceOf(body) {
  const position = body.geometry.getAttribute('position')
  const index = body.geometry.getIndex()
  const skinIndex = body.geometry.getAttribute('skinIndex')
  const skinWeight = body.geometry.getAttribute('skinWeight')
  const boneNames = body.skeleton ? body.skeleton.bones.map((bone) => bone.name) : []
  if (!index || !skinIndex || !skinWeight) return null
  const torso = new Set(TORSO_BONES)
  // The bone carrying most of a vertex, and so what the vertex is: a triangle is cloth
  // when all three of its corners are the torso's.
  const isTorso = (vertex) => {
    let best = -1
    let heaviest = -1
    for (let slot = 0; slot < 4; slot += 1) {
      const weight = [skinWeight.getX(vertex), skinWeight.getY(vertex), skinWeight.getZ(vertex), skinWeight.getW(vertex)][slot]
      if (weight <= heaviest) continue
      heaviest = weight
      best = [skinIndex.getX(vertex), skinIndex.getY(vertex), skinIndex.getZ(vertex), skinIndex.getW(vertex)][slot]
    }
    return torso.has(boneNames[best] ?? '')
  }
  const array = index.array
  const triangles = []
  for (let i = 0; i < array.length; i += 3) {
    const [a, b, c] = [array[i], array[i + 1], array[i + 2]]
    if (!isTorso(a) || !isTorso(b) || !isTorso(c)) continue
    const ys = [position.getY(a), position.getY(b), position.getY(c)]
    if (Math.min(...ys) > CHEST_TOP_MAX_Y || Math.max(...ys) < LINE_FROM_Y - 0.03) continue
    // ...and a triangle has to *reach out to the front* to be the cloth's front. The
    // shoulders are the torso's own bone and their slope passes over the top of the cloth
    // at the height the opening's stations are on: measured, covering a station at y 1.53
    // from z 0.008 and −0.002 where the cloth's own front is 0.036, which is what the
    // opening diving inside the body under the collar was. The cloth's front reaches out
    // past 0.04 on the way up to the collar and past 0.09 at the belt, and the shoulder's
    // slope and the body's own seams are all well inside this.
    const zs = [position.getZ(a), position.getZ(b), position.getZ(c)]
    if (Math.max(...zs) < CHEST_FRONT_MIN_Z) continue
    triangles.push([a, b, c])
  }
  // The skinning a point on a triangle has: the corners' own bones and weights, mixed by
  // the same barycentric shares the point's own position is mixed by, then cut down to
  // the four the shader can carry and renormalised.
  const skinAt = (corners, shares) => {
    const mixed = new Map()
    for (const [at, vertex] of corners.entries()) {
      const share = shares[at]
      if (share <= 0) continue
      for (let slot = 0; slot < 4; slot += 1) {
        const weight = [skinWeight.getX(vertex), skinWeight.getY(vertex), skinWeight.getZ(vertex), skinWeight.getW(vertex)][slot]
        if (weight <= 0) continue
        const bone = [skinIndex.getX(vertex), skinIndex.getY(vertex), skinIndex.getZ(vertex), skinIndex.getW(vertex)][slot]
        mixed.set(bone, (mixed.get(bone) ?? 0) + share * weight)
      }
    }
    const heaviest = [...mixed.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
    const total = heaviest.reduce((sum, [, weight]) => sum + weight, 0)
    if (!total) return null
    return {
      bones: [...heaviest.map(([bone]) => bone), 0, 0, 0, 0].slice(0, 4),
      weights: [...heaviest.map(([, weight]) => weight / total), 0, 0, 0, 0].slice(0, 4),
    }
  }
  // The cloth's own shading, mixed across the same triangle the height was read off: the
  // opening is a seam *in* the fabric, so it has to be lit by the fabric rather than by a
  // normal of its own (see the material note below).
  const normalAttr = body.geometry.getAttribute('normal')
  // ...and the cloth's own uv and vertex colour, mixed across the same triangle: a
  // piece of detail welded into this mesh is drawn with the body's own material, which
  // samples the model's atlas at whatever uv it carries. Taking the texel the cloth
  // itself samples at the station — by mixing the covering triangle's own uv — is what
  // makes the seam the fabric it is drawn on, and it is exact where a uv read off the
  // nearest vertex is not: the chest is coarse, so a neighbouring vertex can belong to
  // another piece of the uniform and put a stripe of its trim down the opening.
  const uvAttr = body.geometry.getAttribute('uv')
  const colourAttr = body.geometry.getAttribute('color')
  const mix = (attribute, corners, shares, components = 3) => {
    if (!attribute) return null
    const out = new Array(components).fill(0)
    for (const [at, vertex] of corners.entries()) {
      const share = shares[at]
      if (share <= 0) continue
      out[0] += share * attribute.getX(vertex)
      if (components > 1) out[1] += share * attribute.getY(vertex)
      if (components > 2) out[2] += share * attribute.getZ(vertex)
    }
    return out
  }
  // The station the cloth last reached, and its height: a station above the cloth's own
  // top edge holds the height of the last one that was on it rather than falling back, so
  // the opening runs on up to the collar instead of turning inwards where the chest ends.
  let held = null
  let heldSkin = null
  let heldNormal = null
  let heldUv = null
  let heldColour = null
  const at = (x, y) => {
    let front = -Infinity
    let skin = null
    let normal = null
    let uv = null
    let colour = null
    for (const [a, b, c] of triangles) {
      const ax = position.getX(a)
      const ay = position.getY(a)
      const bx = position.getX(b)
      const by = position.getY(b)
      const cx = position.getX(c)
      const cy = position.getY(c)
      if (Math.max(ay, by, cy) < y - CHEST_WINDOW) continue
      if (Math.min(ay, by, cy) > y + CHEST_WINDOW) continue
      const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
      if (Math.abs(det) < 1e-9) continue
      const wa = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det
      const wb = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det
      const wc = 1 - wa - wb
      // The station has to be *on* the triangle. A tolerance here reads a station that
      // only nearly misses one off the surface extended past its own edge, and the height
      // that comes back is nothing like the cloth's: measured, allowing a third of a
      // triangle of slack put the opening's top three stations at z 0.014, 0.001 and
      // −0.010 against the cloth's own 0.036 to 0.042, so the opening dived a third of
      // the way into the body under the collar.
      if (wa < -0.02 || wb < -0.02 || wc < -0.02) continue
      const z = wa * position.getZ(a) + wb * position.getZ(b) + wc * position.getZ(c)
      if (z <= front) continue
      // ...and the height that comes back has to be *the cloth's own front* as well, not a
      // shoulder's slope crossing the station from inside: measured, one of those reaches
      // the opening's upper stations at z 0.014 where the cloth's own front there is 0.036.
      if (z < CHEST_FRONT_MIN_Z) continue
      front = z
      skin = skinAt([a, b, c], [wa, wb, wc])
      const mixed = mix(normalAttr, [a, b, c], [wa, wb, wc])
      if (mixed) {
        const length = Math.hypot(...mixed) || 1
        normal = mixed.map((value) => value / length)
      }
      uv = mix(uvAttr, [a, b, c], [wa, wb, wc], 2)
      colour = mix(colourAttr, [a, b, c], [wa, wb, wc])
    }
    if (Number.isFinite(front)) {
      held = front
      heldSkin = skin
      heldNormal = normal
      heldUv = uv
      heldColour = colour
      return { z: front, skin, normal, uv, colour }
    }
    return held === null
      ? { z: 0.1, skin: null, normal: null, uv: null, colour: null }
      : { z: held, skin: heldSkin, normal: heldNormal, uv: heldUv, colour: heldColour }
  }
  return { at, triangles: triangles.length }
}

// The head's own front surface at a point on the face: the front-most of the head's
// triangles that cover that point looking straight down the model's own front (+z),
// interpolated at it. Read off the *triangles* rather than off the vertices near the
// point because the head's shells are coarse and a surface drawn between two vertices
// bulges forward of both of them — which is exactly where a flat eye plate sinks in.
// Triangles with any corner among `skip` (the eyes) are left out, so a plate cannot
// hold itself up, and -Infinity comes back where nothing covers the point at all:
// the eye vertex is the front-most surface there and is not buried in anything.
function frontOfHead(position, index, x, y, skip) {
  if (!index) return -Infinity
  const array = index.array
  let front = -Infinity
  for (let i = 0; i < array.length; i += 3) {
    const [a, b, c] = [array[i], array[i + 1], array[i + 2]]
    if (skip.has(a) || skip.has(b) || skip.has(c)) continue
    const ax = position.getX(a)
    const ay = position.getY(a)
    const bx = position.getX(b)
    const by = position.getY(b)
    const cx = position.getX(c)
    const cy = position.getY(c)
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
    if (Math.abs(det) < 1e-9) continue
    const wa = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det
    const wb = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det
    const wc = 1 - wa - wb
    if (wa < 0 || wb < 0 || wc < 0) continue
    front = Math.max(
      front,
      wa * position.getZ(a) + wb * position.getZ(b) + wc * position.getZ(c),
    )
  }
  return front
}

// Every piece of detail below is built as one small skinned mesh sharing the body's own
// skeleton: each vertex takes the bone weights of the nearest vertex of the body, so
// what is added bends with the part it sits on, and its own colour rides in the vertex
// colours over a white material.
//
// A vertex may instead be given `weights` — the skinning of the *surface* it sits on,
// mixed across the triangle under it the way that triangle's own interpolation mixes it.
// That is exact rather than approximate: linear blend skinning is linear in the weights,
// so a point on a drawn facet moves with the mix of its corners' weights. A detail that
// takes a single nearest vertex's weights instead — and the cloth is coarse and twisted
// by the pose — can be left the width of that twist *inside* the cloth it is drawn on,
// which is how the jersey's opening came to be missing its lower half in the set stance.
//
// `normals` is the same idea one step on: the shading of the surface a detail is drawn
// on, taken at that detail's own stations, so what is added is lit as the cloth around
// it is rather than as a surface with a lighting of its own. The jersey's opening is not
// hung this way at all any more — it is welded into the cloth's own mesh (see
// weldDetail) — so what is left here is the kit's flat detail: the brows and the laces.
function skinnedDetail(body, { vertices, colors, indices, donors, weights, normals, name }) {
  const source = body.geometry
  const skinIndex = source.getAttribute('skinIndex')
  const skinWeight = source.getAttribute('skinWeight')
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  if (normals) geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  const bones = []
  const shares = []
  for (let at = 0; at < donors.length; at += 1) {
    const mixed = weights?.[at]
    if (mixed) {
      bones.push(...mixed.bones)
      shares.push(...mixed.weights)
      continue
    }
    const donor = donors[at]
    bones.push(
      skinIndex.getX(donor), skinIndex.getY(donor), skinIndex.getZ(donor), skinIndex.getW(donor),
    )
    shares.push(
      skinWeight.getX(donor), skinWeight.getY(donor),
      skinWeight.getZ(donor), skinWeight.getW(donor),
    )
  }
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(bones, 4))
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(shares, 4))
  geometry.setIndex(new THREE.BufferAttribute(new Uint16Array(indices), 1))
  // A detail that brought its own normals — the surface it was read off — keeps them; the
  // rest are the flat surface they are drawn as, averaged from their own faces.
  if (!normals) geometry.computeVertexNormals()
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial({
    color: new THREE.Color(1, 1, 1),
    vertexColors: true,
    roughness: 0.8,
    metalness: 0,
    // A detail drawn on the body is a *surface*, seen from whichever side the pose puts
    // towards the camera. Measured, the opening's whole ribbon turned its back on it in
    // the follow-through — the chest had swung round past it — and drew nothing at all,
    // though nothing stood in front of it either.
    side: THREE.DoubleSide,
    // ...and a hair of depth bias, because the opening is drawn *on* the cloth now: the two
    // are the same surface to within a millimetre, and a depth test that close is a coin
    // toss between a seam and the jersey it is sewn in.
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  }))
  mesh.name = name
  mesh.castShadow = true
  mesh.receiveShadow = true
  // ...and it is never culled. Three culls a mesh by a bounding sphere carried by the
  // *object's* own transform, which does not follow the skeleton: measured, the sphere
  // cached for the opening sat at the set stance's chest in every pose — including the
  // follow-through, which has carried the chest 0.6 rig away from it. A detail this
  // small is cheaper to draw than to lose.
  mesh.frustumCulled = false
  // The body's own bind pose, so the detail is skinned in the space its weights were
  // read in, and hung beside the body rather than under it.
  mesh.bind(body.skeleton, body.bindMatrix)
  body.parent.add(mesh)
  return { verts: vertices.length / 3, triangles: indices.length / 3 }
}

// A piece of detail *welded into* the body's own geometry: the mesh's every attribute is
// grown by the new vertices and its index by the new faces, so what is added is part of
// the surface it is drawn on rather than a second mesh hung beside it.
//
// This is what makes a detail sit on the body rather than on top of it. A separate mesh
// is skinned by the same skeleton either way, and a mesh this small is cheaper to draw
// than to lose — but the two are separate *surfaces*, and where they are meant to be one
// (a seam in the cloth, the edge of a sole) the renderer chooses between them by depth,
// and the depth it chooses by is not the depth either was authored at: the cloth's own
// facets shear apart under the pose (measured, 0.0019 to 0.0024 rig across the whole
// opening in the set stance), and a detail a millimetre in front of the surface as the
// model ships ends up behind it where it matters. Welded, there is nothing to choose
// between: the detail's vertices carry the skinning of the surface *under* them, so they
// travel with it, and its triangles are drawn by the body's own draw call, in the body's
// own material, lit by the body's own maps — which is also what keeps the uniform's trim,
// its shading and its fade over the frame all applying to the detail for free.
//
// `uvs` and `colors` are the surface's own, taken at the detail's own stations: the
// body's material samples the model's atlas, so a welded piece that carried a uv of its
// own would take whatever colour of the uniform that texel happens to be. `normals` falls
// back to the faces the detail itself draws, averaged at each vertex — right for a strap
// or a band, which are their own surface, and wrong for anything laid flat on another
// one, which is why the seam brings the cloth's own mixed normals instead.
// The skinning a list of welded vertices carries: for each of them, the four bone slots
// and weights it is drawn with — the surface's own mix where one was read (the jersey's
// seam, whose station knows the triangle under it), and otherwise the body's own near
// vertex, which is what a piece of detail hung on the leather or the cloth takes.
function skinOf(body, donors, weights) {
  const source = body.geometry
  const skinIndex = source.getAttribute('skinIndex')
  const skinWeight = source.getAttribute('skinWeight')
  const bones = []
  const shares = []
  for (let at = 0; at < donors.length; at += 1) {
    const mixed = weights?.[at]
    if (mixed) {
      bones.push(...mixed.bones)
      shares.push(...mixed.weights)
      continue
    }
    const donor = donors[at]
    bones.push(
      skinIndex.getX(donor), skinIndex.getY(donor), skinIndex.getZ(donor), skinIndex.getW(donor),
    )
    shares.push(
      skinWeight.getX(donor), skinWeight.getY(donor),
      skinWeight.getZ(donor), skinWeight.getW(donor),
    )
  }
  return { bones, shares }
}

function weldDetail(body, { positions, normals, uvs, colors, bones, shares, indices, name }) {
  const geometry = body.geometry
  const source = geometry.getAttribute('position')
  const from = source.count
  const added = positions.length / 3
  const total = from + added
  // The body's material is double-sided, so the detail's winding is only a question of
  // which way its own normals lean; the fallback takes the faces it draws.
  const surface = normals ?? (() => {
    const shape = new THREE.BufferGeometry()
    shape.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    shape.setIndex(indices)
    shape.computeVertexNormals()
    return Array.from(shape.getAttribute('normal').array)
  })()
  // Every attribute the body already carries grows by the same vertices, in the body's
  // own storage: the position and the normals are floats, the uv is two of them, the
  // colour is a normalised byte array (so the tone is written as 0-255) and the skinning
  // is four byte indices and four floats. Nothing is created that the mesh did not
  // already have; a piece of detail cannot change how the body itself is drawn.
  const grow = (attributeName, values, components) => {
    const attribute = geometry.getAttribute(attributeName)
    if (!attribute || !values) return
    const { itemSize, normalized, array } = attribute
    const Ctor = array.constructor
    const out = new Ctor(total * itemSize)
    out.set(array)
    const scale = storageScale(attribute)
    for (let at = 0; at < added; at += 1) {
      for (let k = 0; k < itemSize; k += 1) {
        // A channel the detail has no value for keeps the neutral one: the alpha of a
        // vertex colour, or a fourth weight nothing writes.
        const value = k < components ? values[at * components + k] : (k === 3 ? 1 : 0)
        out[(from + at) * itemSize + k] = Ctor === Float32Array ? value : Math.round(value * scale)
      }
    }
    const next = new THREE.BufferAttribute(out, itemSize)
    next.normalized = normalized
    next.gpuType = attribute.gpuType
    geometry.setAttribute(attributeName, next)
  }
  grow('position', positions, 3)
  grow('normal', surface, 3)
  grow('uv', uvs, 2)
  grow('color', colors, 3)
  grow('skinIndex', bones, 4)
  grow('skinWeight', shares, 4)
  // ...and the faces, after the ones already there. The model's own index is 16-bit and
  // this body is three thousand vertices, so it stays 16-bit unless the detail is what
  // takes it past the ceiling.
  const index = geometry.getIndex()
  const kept = index.array
  const Ctor = total > 65535 ? Uint32Array : Uint16Array
  const grown = new Ctor(kept.length + indices.length)
  for (let i = 0; i < kept.length; i += 1) grown[i] = kept[i]
  for (let i = 0; i < indices.length; i += 1) grown[kept.length + i] = indices[i] + from
  geometry.setIndex(new THREE.BufferAttribute(grown, 1))
  // The material's own draw call covers every group, and the body is one primitive, so
  // the only group that exists is the one the whole thing belongs to: it grows by the
  // detail's faces.
  for (const group of geometry.groups ?? []) group.count += indices.length
  geometry.computeBoundingSphere()
  geometry.computeBoundingBox()
  return {
    name,
    verts: added,
    triangles: indices.length / 3,
    // Where the detail's own vertices start and end in the body's buffers: what a probe
    // reads to look at one piece of it again (see the kit probe in the harness).
    from,
    to: total,
  }
}

// The jersey's opening and its buttons, welded into the jersey's own mesh: a line down
// the chest and a column of hollow rings on the cloth beside it — part of the chest's own
// surface, drawn in the cloth's own material and the cloth's own tone, so it is a seam in
// the jersey rather than a grey shape laid on it.
function addJerseyFront(body, jersey) {
  const position = body.geometry.getAttribute('position')
  const chest = chestSurfaceOf(body)
  const vertices = []
  const colors = []
  const normals = []
  const uvs = []
  const indices = []
  const donors = []
  const weights = []
  // Each vertex is laid on the chest's surface at its own station — the cloth's own front,
  // read at that exact place, plus LINE_LIFT and nothing else — carrying that point of the
  // surface's own skinning, uv and shading, so it bends with the cloth, samples the
  // fabric's own texel and catches the light the way the cloth around it does.
  //
  // Its *colour* is the cloth's own vertex colour taken down, per channel, and not a grey
  // of its own worked out from the atlas by hand (see colourAt): a seam in pale blue
  // fabric is that fabric with less light in it, so one number scales the fabric and the
  // fabric is whatever the model's own vertex colours say it is. Measured on the chest,
  // those are white — so the seam comes out at LINE_GREY of the cloth and the buttons at
  // BUTTON_GREY of it, and the two of them are the jersey's own blue rather than a grey
  // laid over it.
  let firstCloth = null
  // ...and its uv is unwrapped along the strip it belongs to, so a quad between two
  // stations cannot interpolate across the atlas (see unwrapUv).
  let chainUv = null
  const add = (x, y, lift, share, skin) => {
    const { z, skin: surface, normal, uv, colour } = chest.at(x, y)
    vertices.push(x, y, z + LINE_LIFT + lift)
    const cloth = colour ?? jersey
    if (!firstCloth) firstCloth = cloth
    colors.push(cloth[0] * share, cloth[1] * share, cloth[2] * share)
    normals.push(...(normal ?? [0, 0, 1]))
    chainUv = unwrapUv(chainUv, uv)
    uvs.push(...(chainUv ?? [0, 0]))
    donors.push(nearestVertex(position, x, y, z))
    weights.push(skin ?? surface)
    return vertices.length / 3 - 1
  }
  const seam = LINE_GREY
  const button = BUTTON_GREY

  // The opening, from the belt to the collar, hugging the chest's own front.
  const line = []
  for (let band = 0; band <= LINE_BANDS; band += 1) {
    const y = LINE_FROM_Y + (LINE_TO_Y - LINE_FROM_Y) * (band / LINE_BANDS)
    line.push([
      add(-LINE_HALF_WIDTH, y, 0, seam),
      add(LINE_HALF_WIDTH, y, 0, seam),
    ])
  }
  for (let band = 0; band < LINE_BANDS; band += 1) {
    const [left, right] = line[band]
    const [nextLeft, nextRight] = line[band + 1]
    indices.push(left, right, nextRight, left, nextRight, nextLeft)
  }

  // The buttons, hard against it: a ring of quads each, so each one is a hollow circle
  // rather than a disc, with the cloth showing through the hole — a buttonhole, with the
  // button in it.
  const top = LINE_TO_Y - BUTTON_MARGIN_Y
  const bottom = LINE_FROM_Y + BUTTON_MARGIN_Y
  for (let step = 0; step < BUTTON_COUNT; step += 1) {
    const share = BUTTON_COUNT === 1 ? 0.5 : step / (BUTTON_COUNT - 1)
    const y = top - share * (top - bottom)
    const inner = []
    const outer = []
    for (let segment = 0; segment < BUTTON_SEGMENTS; segment += 1) {
      const angle = (segment / BUTTON_SEGMENTS) * Math.PI * 2
      for (const [radius, ring] of [[BUTTON_INNER_RADIUS, inner], [BUTTON_OUTER_RADIUS, outer]]) {
        ring.push(add(
          BUTTON_X + Math.cos(angle) * radius,
          y + Math.sin(angle) * radius,
          BUTTON_LIFT,
          button,
        ))
      }
    }
    for (let segment = 0; segment < BUTTON_SEGMENTS; segment += 1) {
      const next = (segment + 1) % BUTTON_SEGMENTS
      indices.push(inner[segment], outer[segment], outer[next])
      indices.push(inner[segment], outer[next], inner[next])
    }
  }

  const luminance = (colour) => Number((0.2126 * colour[0] + 0.7152 * colour[1] + 0.0722 * colour[2]).toFixed(3))
  const cloth = firstCloth ?? jersey
  return {
    ...weldDetail(body, {
      positions: vertices,
      normals,
      uvs,
      colors,
      indices,
      ...skinOf(body, donors, weights),
      name: 'JerseyFront',
    }),
    surfaceTriangles: chest.triangles,
    fromY: LINE_FROM_Y,
    toY: LINE_TO_Y,
    buttonX: BUTTON_X,
    buttons: BUTTON_COUNT,
    lineWidth: LINE_HALF_WIDTH * 2,
    lift: LINE_LIFT,
    hollow: (BUTTON_OUTER_RADIUS - BUTTON_INNER_RADIUS) / BUTTON_OUTER_RADIUS,
    // The two tones as the suite reads them — a luminance, off the vertex colours — and
    // the cloth's own colour they were taken down from. The tones are the cloth's own
    // vertex colour scaled, so what comes back is the cloth's own luminance times the
    // share (measured, the chest's vertex colours are white, so this is the share itself).
    grey: luminance(cloth.map((channel) => channel * seam)),
    buttonGrey: luminance(cloth.map((channel) => channel * button)),
    cloth: cloth.map((channel) => Number(channel.toFixed(3))),
  }
}

// The face's own tone, read off it just above each eye: the skin the brows are drawn on,
// taken down for them (see BROW_DARKEN). The eyes themselves are left out of the
// reading, or what came back would be the painted black of the eye.
function faceToneOf(body, eyes) {
  const position = body.geometry.getAttribute('position')
  const skip = new Set(eyes.flatMap((eye) => eye.vertices))
  let best = -1
  let bestDistance = Infinity
  for (const { scaledBox } of eyes) {
    const x = (scaledBox.x[0] + scaledBox.x[1]) / 2
    const y = scaledBox.y[1] + 0.012 // a hair above the eye's own top: the brow's own place
    const z = scaledBox.z[1]
    for (let vertex = 0; vertex < position.count; vertex += 1) {
      if (skip.has(vertex)) continue
      const dx = position.getX(vertex) - x
      const dy = position.getY(vertex) - y
      const dz = position.getZ(vertex) - z
      const distance = dx * dx + dy * dy + dz * dz
      if (distance >= bestDistance) continue
      bestDistance = distance
      best = vertex
    }
  }
  return texelAt(body, body.geometry, best) ?? FACE_FALLBACK
}

// The brows, as one small skinned mesh over both eyes: a bar laid across the top of
// each eye plate, arched, and read off the face's own front at every station it is
// drawn at, so it cannot float off the face.
function addBrows(body, eyes, face) {
  const position = body.geometry.getAttribute('position')
  const index = body.geometry.getIndex()
  const own = new Set(eyes.flatMap((eye) => eye.vertices))
  const shade = face.map((channel, at) => channel * BROW_BROWN[at])
  const vertices = []
  const colors = []
  const indices = []
  const donors = []
  const add = (x, y, z) => {
    vertices.push(x, y, z)
    colors.push(shade[0], shade[1], shade[2])
    donors.push(nearestVertex(position, x, y, z))
    return vertices.length / 3 - 1
  }
  for (const { scaledBox } of eyes) {
    // The ear lies outboard of its eye and the nose inboard of it, so the brow reaches
    // further out than in: the model's own +x is its left, and an eye's own box is on one
    // side of the midline or the other, which is what tells its two ends apart.
    const earIsPositive = scaledBox.x[1] > 0
    const from = scaledBox.x[0] - (earIsPositive ? BROW_OVERHANG_IN_X : BROW_OVERHANG_OUT_X)
    const to = scaledBox.x[1] + (earIsPositive ? BROW_OVERHANG_OUT_X : BROW_OVERHANG_IN_X)
    // The brow rides *above* the eye's own top edge, with skin between the two of them:
    // a bar laid over the top of the eye reads as more eye, which is what it looked like.
    const bottom = scaledBox.y[1] + BROW_GAP_Y
    const top = Math.min(bottom + BROW_DEPTH_Y, BROW_TOP_MAX_Y - BROW_ARCH)
    const half = (top - bottom) / 2
    const middle = (bottom + top) / 2
    const low = []
    const high = []
    for (let sample = 0; sample <= BROW_SAMPLES; sample += 1) {
      // Stations bunched towards the two ends — a cosine walk, so the rounded corners are
      // drawn with stations to draw them — where an even walk across the brow leaves
      // the turn a single segment long.
      const share = 0.5 - 0.5 * Math.cos((Math.PI * sample) / BROW_SAMPLES)
      const x = from + (to - from) * share
      // The arch: the middle of the brow rides a little higher than its own ends, the
      // way a brow sits over an eye rather than straight across it.
      const arch = Math.sin(Math.PI * share) * BROW_ARCH
      // The corner: the brow's own depth at this station, as a rectangle with its corners
      // rounded — the full half-depth everywhere except within a corner's radius of either
      // end, where a quarter-circle turns it in. Read from the nearer end in rig units, so
      // the turn is the same corner at both ends of both brows.
      const fromEnd = Math.min(share, 1 - share) * (to - from)
      const corner = Math.min(BROW_CORNER_R, half)
      const turned = fromEnd < corner
        ? corner - Math.sqrt(corner * corner - (corner - fromEnd) ** 2)
        : 0
      const depth = half - turned
      const front = frontOfHead(position, index, x, middle + arch, own)
      const z = (Number.isFinite(front) ? front : scaledBox.z[1]) + BROW_LIFT_Z
      low.push(add(x, middle + arch - depth, z))
      high.push(add(x, middle + arch + depth, z))
    }
    // Wound across the face and up it, so the strip looks forward (the model's own
    // front is +z), and its own two rows are the brow's own bottom and top edges.
    for (let sample = 0; sample + 1 < low.length; sample += 1) {
      indices.push(low[sample], low[sample + 1], high[sample + 1])
      indices.push(low[sample], high[sample + 1], high[sample])
    }
  }
  return {
    ...skinnedDetail(body, { vertices, colors, indices, donors, name: 'BrowDetail' }),
    count: eyes.length,
    tone: shade.map((channel) => Number(channel.toFixed(3))),
    depth: BROW_DEPTH_Y,
    overhang: [BROW_OVERHANG_IN_X, BROW_OVERHANG_OUT_X],
    arch: BROW_ARCH,
    lift: BROW_LIFT_Z,
    corner: BROW_CORNER_R,
  }
}

// One shoe's own surface, read off its shell: the ring of points round its opening (the
// highest vertex in each sector about the ankle), the ring of points it stands on, and
// the height of its top surface anywhere across the instep.
function shoeSurface(geometry, shell) {
  const position = geometry.getAttribute('position')
  const centre = { x: 0, z: 0 }
  for (const vertex of shell.vertices) {
    centre.x += position.getX(vertex)
    centre.z += position.getZ(vertex)
  }
  centre.x /= shell.vertices.length
  centre.z /= shell.vertices.length
  const ring = (highest) => {
    const points = []
    for (let step = 0; step < SHOE_SEGMENTS; step += 1) {
      const angle = (step / SHOE_SEGMENTS) * Math.PI * 2
      const dx = Math.cos(angle)
      const dz = Math.sin(angle)
      let best = null
      for (const vertex of shell.vertices) {
        const px = position.getX(vertex) - centre.x
        const pz = position.getZ(vertex) - centre.z
        const length = Math.hypot(px, pz) || 1
        if ((px * dx + pz * dz) / length < 0.85) continue
        if (best === null) best = vertex
        else if (highest ? position.getY(vertex) > position.getY(best) : position.getY(vertex) < position.getY(best)) best = vertex
      }
      if (best === null) continue
      points.push({ x: position.getX(best), y: position.getY(best), z: position.getZ(best), dx, dz })
    }
    return points
  }
  // The shoe's own top surface at a spot on it: the highest vertex within a window of
  // that spot, opened out once where the shell is coarse, and failing that the *nearest*
  // vertex of the shell — never the value found at the spot before, which is what leaves
  // a row stepping off the shoe where a reading runs out.
  const topAt = (x, z, window = 0.012) => {
    let best = -Infinity
    let nearest = -1
    let nearestDistance = Infinity
    for (const vertex of shell.vertices) {
      const dx = position.getX(vertex) - x
      const dz = position.getZ(vertex) - z
      if (Math.abs(dx) <= window && Math.abs(dz) <= window) {
        best = Math.max(best, position.getY(vertex))
      }
      const distance = dx * dx + dz * dz
      if (distance >= nearestDistance) continue
      nearestDistance = distance
      nearest = vertex
    }
    if (Number.isFinite(best)) return best
    if (window < 0.03) return topAt(x, z, window + 0.018)
    return nearest < 0 ? null : position.getY(nearest)
  }
  // How far across the shoe's upper face runs at a station along the foot. The shell's
  // own vertices are spread unevenly along the foot (its toe end is sparse), so the band
  // a reading is taken in opens out until it finds a real ridge: a station that read a
  // ridge a hair wide would otherwise draw a lace bar a hair wide, out at the shoe's
  // edge.
  const ridgeAt = (z, window = 0.02) => {
    const band = shell.vertices.filter((vertex) => Math.abs(position.getZ(vertex) - z) <= window)
    if (band.length < 2) return null
    const top = Math.max(...band.map((vertex) => position.getY(vertex)))
    const upper = band.filter((vertex) => position.getY(vertex) >= top - 0.05)
    const ridge = [
      Math.min(...upper.map((vertex) => position.getX(vertex))),
      Math.max(...upper.map((vertex) => position.getX(vertex))),
    ]
    if (ridge[1] - ridge[0] >= 0.05 || window >= 0.05) return ridge
    return ridgeAt(z, window + 0.015)
  }
  return { centre, opening: ring(true), sole: ring(false), topAt, ridgeAt }
}

// The shoes' own detail: the edge of each shoe's own sole and the tongue over the
// instep, *welded into the shoe's own mesh* (see weldDetail), and the laces across the
// instep hung on it as their own small mesh.
//
// The laces are the one piece that stays separate, because they are the one piece that
// is not the shoe: a lace is the kit's own cloth — the trousers' pale tone taken towards
// white — and a welded vertex is drawn with the body's own material, sampling the model's
// atlas at its station. What can be welded is therefore exactly what the leather there can
// say: the sole's edge and the tongue are the shoe's own colour taken down, so each of
// their vertices carries the colour of the shoe's own vertex beneath it, scaled — the
// leather there, darkened — and a lace, which is a colour the shoe has no way to reach,
// keeps its own mesh.
function addShoeDetail(body, { shells, shoe, pant }) {
  const position = body.geometry.getAttribute('position')
  const sole = SOLE_SHARE
  const tongue = TONGUE_SHARE
  const lace = pant.map((channel) => channel + (1 - channel) * LACE_WHITEN)
  // One of the two pieces of geometry, built the same way: `tone` is the colour a piece is
  // drawn in at a vertex of the shoe — the leather's own, for the parts that stay (taken
  // down by the share each call passes), and the lace tone for the bars.
  const builder = (tone) => {
    const vertices = []
    const colors = []
    const uvs = []
    const indices = []
    const donors = []
    const uv = body.geometry.getAttribute('uv')
    let chainUv = null
    const add = (x, y, z, share) => {
      const donor = nearestVertex(position, x, y, z)
      const base = tone(donor)
      vertices.push(x, y, z)
      colors.push(base[0] * share, base[1] * share, base[2] * share)
      // ...and the uv the shoe itself samples there: what makes a welded piece part of the
      // leather is that it carries the leather's own texel, not a colour of its own. Kept
      // to the copy of the island nearest the vertex before it (see unwrapUv), because the
      // band round a sole is one strip that walks right round the shoe.
      chainUv = uv
        ? unwrapUv(chainUv, [uv.getX(donor), uv.getY(donor)])
        : chainUv
      uvs.push(chainUv ? chainUv[0] : 0, chainUv ? chainUv[1] : 0)
      donors.push(donor)
      return vertices.length / 3 - 1
    }
    // A face of one of the pieces laid on the shoe's own surface, wound so it looks along
    // a direction of its own: a row across the foot and a row along it give a quad whose
    // own normal points down, into the shoe, and a face the renderer draws from behind is
    // a face it never draws at all. Read off the three corners' own positions, so the
    // winding holds however a re-export happens to order them.
    const faceTowards = (a, b, c, tx, ty, tz) => {
      const ax = vertices[a * 3]
      const ay = vertices[a * 3 + 1]
      const az = vertices[a * 3 + 2]
      const ux = vertices[b * 3] - ax
      const uy = vertices[b * 3 + 1] - ay
      const uz = vertices[b * 3 + 2] - az
      const vx = vertices[c * 3] - ax
      const vy = vertices[c * 3 + 1] - ay
      const vz = vertices[c * 3 + 2] - az
      const along = (uy * vz - uz * vy) * tx + (uz * vx - ux * vz) * ty + (ux * vy - uy * vx) * tz
      if (along < 0) indices.push(a, c, b)
      else indices.push(a, b, c)
    }
    const faceUp = (a, b, c) => faceTowards(a, b, c, 0, 1, 0)
    // A band round the shoe following one of its own rings: two rows, one under the
    // other along y, pushed out from the shoe's own axis so the band stands proud of it.
    const band = (points, offset, depth, proud, share) => {
      if (points.length < 4) return 0
      const rows = points.map((point) => [point.y + offset, point.y + offset + depth].map((y) => add(
        point.x + point.dx * proud,
        y,
        point.z + point.dz * proud,
        share,
      )))
      for (let step = 0; step < rows.length; step += 1) {
        const next = (step + 1) % rows.length
        indices.push(rows[step][0], rows[step][1], rows[next][1])
        indices.push(rows[step][0], rows[next][1], rows[next][0])
      }
      return rows.length * 2
    }
    return { vertices, colors, uvs, indices, donors, add, faceTowards, faceUp, band }
  }
  // The shoe's own leather, and the laces' own cloth: two pieces of geometry built off the
  // same shoe, one welded into it and one hung beside it.
  const leather = builder((donor) => colourAt(body.geometry, donor))
  const laces = builder(() => lace)
  // ...and the tongue is made of the leather's own geometry, so the helpers it uses are
  // the welded piece's own: what is added to the shoe is added to the shoe's mesh.
  const { add, faceUp } = leather
  let laceBars = 0
  let tongues = 0
  for (const shell of shells) {
    const surface = shoeSurface(body.geometry, shell)
    leather.band(surface.sole, SOLE_OFFSET_Y, SOLE_DEPTH, SOLE_PROUD, sole)
    // The tongue, over the instep: rows down the foot, each following the shoe's own
    // top surface, so it is a pad on the shoe rather than a plate beside it.
    const rows = []
    for (let step = 0; step <= TONGUE_BANDS; step += 1) {
      const z = TONGUE_BACK_Z + (TONGUE_FRONT_Z - TONGUE_BACK_Z) * (step / TONGUE_BANDS)
      const ridge = surface.ridgeAt(z)
      if (!ridge) continue
      const from = ridge[0] + TONGUE_INSET_X
      const to = ridge[1] - TONGUE_INSET_X
      if (!(to > from)) continue
      const row = []
      for (let sample = 0; sample <= LACE_SAMPLES; sample += 1) {
        const x = from + ((to - from) * sample) / LACE_SAMPLES
        const top = surface.topAt(x, z)
        if (top !== null) row.push(add(x, top + TONGUE_LIFT, z, tongue))
      }
      if (row.length >= 4) rows.push(row)
    }
    if (rows.length > 1) tongues += 1
    for (let step = 0; step + 1 < rows.length; step += 1) {
      const [near, far] = [rows[step], rows[step + 1]]
      for (let sample = 0; sample + 1 < Math.min(near.length, far.length); sample += 1) {
        faceUp(near[sample], near[sample + 1], far[sample + 1])
        faceUp(near[sample], far[sample + 1], far[sample])
      }
    }
    // The laces, bar by bar across the instep, over the tongue.
    for (const z of LACE_Z) {
      const ridge = surface.ridgeAt(z)
      if (!ridge) continue
      const from = ridge[0] + LACE_INSET_X
      const to = ridge[1] - LACE_INSET_X
      if (!(to > from)) continue
      const stations = []
      for (let sample = 0; sample <= LACE_SAMPLES; sample += 1) {
        const x = from + ((to - from) * sample) / LACE_SAMPLES
        const top = surface.topAt(x, z)
        if (top !== null) stations.push([x, top])
      }
      if (stations.length < 4) continue
      // A bar is a strap: a top face and the two walls that stand it up off the shoe,
      // so it reads as a lace laid across the instep from the side as well as from
      // above, and cannot come out as a sheet of paper folded over the foot.
      const top = [[], []]
      const under = [[], []]
      for (const [x, surfaceTop] of stations) {
        for (const [edge, at] of [[0, z - LACE_HALF_WIDTH], [1, z + LACE_HALF_WIDTH]]) {
          top[edge].push(laces.add(x, surfaceTop + LACE_LIFT, at, 1))
          under[edge].push(laces.add(x, surfaceTop + LACE_LIFT - LACE_THICKNESS, at, 1))
        }
      }
      for (let sample = 0; sample + 1 < stations.length; sample += 1) {
        laces.faceUp(top[0][sample], top[0][sample + 1], top[1][sample + 1])
        laces.faceUp(top[0][sample], top[1][sample + 1], top[1][sample])
        laces.faceTowards(top[0][sample], top[0][sample + 1], under[0][sample + 1], 0, 0, -1)
        laces.faceTowards(top[0][sample], under[0][sample + 1], under[0][sample], 0, 0, -1)
        laces.faceTowards(top[1][sample], top[1][sample + 1], under[1][sample + 1], 0, 0, 1)
        laces.faceTowards(top[1][sample], under[1][sample + 1], under[1][sample], 0, 0, 1)
      }
      // ...and its two ends closed, or the strap comes out open at the shoe's own edges.
      const last = stations.length - 1
      laces.faceTowards(top[0][0], top[1][0], under[1][0], -1, 0, 0)
      laces.faceTowards(top[0][0], under[1][0], under[0][0], -1, 0, 0)
      laces.faceTowards(top[0][last], top[1][last], under[1][last], 1, 0, 0)
      laces.faceTowards(top[0][last], under[1][last], under[0][last], 1, 0, 0)
      laceBars += 1
    }
  }
  // The shoe's own two pieces go into the shoe; the laces get a mesh of their own, with
  // the flat white material every other detail but the jersey wears (the model's atlas is
  // not what a lace is painted with). Both are built before either is added, so every
  // donor vertex is read off the shoe as the model shipped it.
  const welded = weldDetail(body, {
    positions: leather.vertices,
    uvs: leather.uvs,
    colors: leather.colors,
    indices: leather.indices,
    ...skinOf(body, leather.donors),
    name: 'ShoeDetail',
  })
  const laceMesh = laces.indices.length
    ? skinnedDetail(body, {
      vertices: laces.vertices,
      colors: laces.colors,
      indices: laces.indices,
      donors: laces.donors,
      name: 'LaceDetail',
    })
    : null
  return {
    ...welded,
    laces: laceMesh,
    shells: shells.length,
    laceBars,
    tongues,
    laceWidth: LACE_HALF_WIDTH * 2,
    shoeColour: shoe.map((channel) => Number(channel.toFixed(3))),
    laceColour: lace.map((channel) => Number(channel.toFixed(3))),
  }
}

/**
 * Put the batter's kit right on a loaded body: one ear flap (lengthened, the other
 * cut away along the helmet's own edge), a brow over each eye, eyes that clear the
 * brim and sit on the face, a jersey with its opening on it, and shoes with the edge
 * of their soles, their tongues and their laces — and no sock above them.
 *
 * @param {THREE.Object3D} model the loaded, rigged body, with each skinned mesh
 *   carrying its own geometry (see the body memo in Batter.jsx)
 * @param {{sign?: number}} options `sign` is the rig's own handedness sign: +1 for a
 *   right-handed batter, whose trailing arm is the model's right one
 * @returns {object} what was done, for the tests and the debug drawer
 */
export function applyBatterLook(model, { sign = 1 } = {}) {
  let helmet = null
  let body = null
  model.traverse((node) => {
    if (!node.isSkinnedMesh) return
    if (node.name === 'Helmet') helmet = node
    if (node.name === 'JOINED') body = node
  })
  const report = { flap: null, brows: null, eyes: null, jersey: null, shoes: null }
  if (!helmet || !body) return report
  // Work on the mesh's own copy of its geometry. The meshes came off a *cached* asset,
  // so the geometry can be shared with the cache and with another render of this same
  // component; the kit belongs to this body, so the pass edits a copy and the asset
  // keeps the shape it shipped with.
  helmet.geometry = helmet.geometry.clone()
  body.geometry = body.geometry.clone()

  // The side of the model the batter turns *away* from the pitcher. A right-handed
  // batter's lead arm is his left, so the cover that goes is the one on the model's
  // right (-x); a lefty's trailing side is the other one, and mirroring the sign is all
  // the handedness there is to it.
  const trailing = (x) => (sign > 0 ? x <= -EAR_COVER_SIDE_X : x >= EAR_COVER_SIDE_X)

  // The cover that goes: the separate hanging shell on that side first...
  const flaps = earFlapsOf(helmet.geometry)
  const gone = flaps.filter(({ box }) => (sign > 0 ? box.x[1] < 0 : box.x[0] > 0))
  let triangles = gone.reduce((sum, { vertices }) => sum + dropShell(helmet.geometry, vertices), 0)
  // ...and then the cover the *main* shells carry beside that same ear, which is all
  // that is left of it once the separate flap is gone: the band hanging below the brim,
  // folded back up onto the curve the helmet's own lower edge runs — up to the brim's
  // underside in front of the ear, lowest beside it, and back into the nape's own line
  // behind it (see EAR_EDGE_*). Read as a curve rather than as a box, so the edge the
  // shell is left with is that curve rather than a level rim with a step at either end
  // of it. Off either end of the curve it is the helmet's own shape, which is what
  // `Infinity` says here: nothing is below it, so nothing is folded there.
  const earEdgeY = (z) => {
    if (z >= EAR_EDGE_COVER_Z || z <= EAR_EDGE_NAPE_Z) return Infinity // its own shape, both ends
    // Under the brim, along the cover's own length: the part of the edge that is the same
    // height all the way, because the brim's underside above it is.
    if (z >= EAR_EDGE_FRONT_Z) return EAR_EDGE_FRONT_Y
    return z >= EAR_EDGE_EAR_Z
      // The level run's own height is this segment's ceiling, a hair under it: reaching the
      // level with no slope of its own, the curve rides a touch *above* it through the first
      // half of the turn (measured, 0.0002 at z 0.08). A line up there is a rim pulled up
      // over the brim rather than folded under it — the fold puts the shell *on* the line,
      // and the brim's own underside is part of the surface the line has to stay under — so
      // it is held 0.0006 below it, which also leaves the rim in front of the ear its own
      // edge to read at under the brim rather than the brim's.
      ? Math.min(EAR_EDGE_FRONT_Y - 0.0006, hermite(
        z,
        EAR_EDGE_EAR_Z, EAR_EDGE_EAR_Y, EAR_EDGE_SLOPE_EAR,
        EAR_EDGE_FRONT_Z, EAR_EDGE_FRONT_Y, EAR_EDGE_SLOPE_FRONT,
      ))
      : hermite(
        z,
        EAR_EDGE_NAPE_Z, EAR_EDGE_NAPE_Y, EAR_EDGE_SLOPE_NAPE,
        EAR_EDGE_EAR_Z, EAR_EDGE_EAR_Y, EAR_EDGE_SLOPE_EAR,
      )
  }
  const ear = foldOntoEdge(helmet.geometry, { edge: earEdgeY, side: trailing })

  // The cover that stays is lengthened: stretched about its hinge, graded, so the
  // surface it hangs from is not torn, and carried forward as it goes.
  const helmetPosition = helmet.geometry.getAttribute('position')
  const coverSpan = FLAP_HINGE_Y - Math.min(
    FLAP_HINGE_Y,
    ...flaps.flatMap(({ box }) => box.y),
  )
  let lengthened = 0
  let flapLow = FLAP_HINGE_Y
  if (coverSpan > 0) {
    for (let vertex = 0; vertex < helmetPosition.count; vertex += 1) {
      const x = helmetPosition.getX(vertex)
      const y = helmetPosition.getY(vertex)
      const z = helmetPosition.getZ(vertex)
      if (y > FLAP_TOP_Y || z < EAR_COVER_FRONT_Z || trailing(x)) continue
      if (Math.abs(x) < EAR_COVER_SIDE_X) continue
      const share = clamp01((FLAP_HINGE_Y - y) / coverSpan)
      helmetPosition.setY(vertex, FLAP_HINGE_Y - (FLAP_HINGE_Y - y) * FLAP_STRETCH)
      helmetPosition.setZ(vertex, z + FLAP_FORWARD * share)
      flapLow = Math.min(flapLow, FLAP_HINGE_Y - (FLAP_HINGE_Y - y) * FLAP_STRETCH)
      lengthened += 1
    }
  }
  helmetPosition.needsUpdate = true
  report.flap = {
    found: flaps.length,
    taken: gone.length + (ear.folded > 0 ? 1 : 0),
    kept: flaps.length - gone.length,
    triangles,
    folded: ear.folded,
    foldedLowY: ear.lowY === null ? null : Number(ear.lowY.toFixed(4)),
    lengthened,
    stretched: FLAP_STRETCH,
    lowY: Number(flapLow.toFixed(4)),
    side: sign > 0 ? 'right' : 'left',
  }

  // The eyes: first down about their own bottom edges until the brim stops covering
  // them, then out onto the face.
  const eyes = eyeShellsOf(body.geometry)
  const scaled = eyes.map(({ vertices, box }) => {
    const height = box.y[1] - box.y[0]
    const room = height > 0 ? (EYE_TOP_CLEAR_Y - box.y[0]) / height : 1
    const scale = Math.min(1, Math.max(room, EYE_SCALE_MIN))
    const about = {
      x: (box.x[0] + box.x[1]) / 2,
      y: box.y[0],
      z: (box.z[0] + box.z[1]) / 2,
    }
    if (scale < 0.999) scaleShell(body.geometry, vertices, scale, about)
    // ...and where the eye ended up, so the brow above it can be laid over its own top
    // edge rather than over a size the eye no longer has.
    const at = (value, centre) => centre + (value - centre) * scale
    return {
      vertices,
      box,
      scale: Math.min(scale, 1),
      scaledBox: {
        x: box.x.map((value) => at(value, about.x)),
        y: box.y.map((value) => at(value, about.y)),
        z: box.z.map((value) => at(value, about.z)),
      },
    }
  })
  // ...and the plate's own flatness is what put part of it inside the head: every vertex
  // is put the clearance in front of the head's own surface at its own place on the face
  // (the eyes excluded from the reading, so a plate cannot hold itself up), which is
  // what conforms the plate to the face it is drawn on.
  const bodyPosition = body.geometry.getAttribute('position')
  const eyeVertices = new Set(eyes.flatMap((eye) => eye.vertices))
  const headIndex = body.geometry.getIndex()
  let lifted = 0
  let deepest = 0
  for (const eye of eyes) {
    for (const vertex of eye.vertices) {
      const x = bodyPosition.getX(vertex)
      const y = bodyPosition.getY(vertex)
      const front = frontOfHead(bodyPosition, headIndex, x, y, eyeVertices)
      if (!Number.isFinite(front)) continue // nothing of the head is in front of it
      const z = bodyPosition.getZ(vertex)
      if (front + EYE_FACE_CLEAR <= z) continue // already clear, so it keeps its own shape
      deepest = Math.max(deepest, front - z)
      bodyPosition.setZ(vertex, front + EYE_FACE_CLEAR)
      lifted += 1
    }
  }
  bodyPosition.needsUpdate = true
  const topAt = (box, scale) => box.y[0] + (box.y[1] - box.y[0]) * scale
  report.eyes = {
    count: eyes.length,
    brimUnderside: 1.7954,
    scale: scaled.length ? Math.max(...scaled.map((eye) => eye.scale)) : null,
    topBefore: eyes.length ? Math.max(...eyes.map(({ box }) => box.y[1])) : null,
    topAfter: scaled.length ? Math.max(...scaled.map(({ box, scale }) => topAt(box, scale))) : null,
    heightAfter: scaled.length ? (scaled[0].box.y[1] - scaled[0].box.y[0]) * scaled[0].scale : null,
    widthAfter: scaled.length ? (scaled[0].box.x[1] - scaled[0].box.x[0]) * scaled[0].scale : null,
    lifted,
    deepest: Number(deepest.toFixed(4)),
    clear: EYE_FACE_CLEAR,
  }

  // The brows, over the tops of the eyes just placed, then the jersey's own front and
  // the shoes. The brows are still their own mesh hung on the body (they are drawn in
  // the face's own tone over a material of their own); the jersey's opening and the
  // shoes' own leather are welded into the body's geometry, so a second pass over the
  // same model has to leave them where they are rather than draw them again — the guard
  // is the pass's own report, carried on the model it was made for.
  const done = model.userData.batterLook ?? {}
  report.brows = done.brows ?? addBrows(body, scaled, faceToneOf(body, scaled))
  report.jersey = done.jersey ?? addJerseyFront(body, jerseyColourOf(body))
  if (done.shoes) {
    report.shoes = done.shoes
  } else {
    const shells = shoeShellsOf(body.geometry)
    if (shells.length) {
      const { shoe, pant } = shoeColourOf(body, shells)
      report.shoes = addShoeDetail(body, { shells, shoe, pant })
    }
  }
  report.runs = (model.userData.batterLookRuns ?? 0) + 1
  model.userData.batterLookRuns = report.runs
  model.userData.batterLook = report
  // ...and on the mesh as well, because a probe reads the body rather than the scene
  // root: what the welded pieces are is a *range* of the body's own vertices.
  body.userData.batterLook = report
  return report
}
